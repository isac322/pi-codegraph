import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  gitIdentity,
  normalizeFilesPath,
  WorkspaceManager,
} from "../dist/lib/codegraph.js";
import {
  codeGraphOwnership,
  inspectCodeGraphOwnership,
} from "../dist/lib/codegraph-ownership.js";
import { defaultSettings, loadSettings } from "../dist/lib/config.js";
import { codegraphTools, toolCallLabel } from "../dist/lib/tool-metadata.js";
import { CodeGraphWorkerPool } from "../dist/lib/worker-pool.js";

function workspaceIdentity(sourcePath, suffix) {
  return {
    sourcePath,
    repoRoot: sourcePath,
    repoIdentity: `repo-identity-${suffix}`,
    worktreeIdentity: `worktree-identity-${suffix}`,
    gitCommonDir: "",
  };
}

function managedIndexPath(indexStore, identity) {
  const key = createHash("sha256")
    .update(
      `${identity.repoIdentity}\0${identity.worktreeIdentity}\0${identity.sourcePath}`,
    )
    .digest("hex");
  return path.join(indexStore, "projects", key);
}

async function createManagedDatabase(indexStore, identity) {
  const indexPath = managedIndexPath(indexStore, identity);
  await mkdir(indexPath, { recursive: true });
  await writeFile(path.join(indexPath, "codegraph.db"), "");
  return indexPath;
}

async function createFakeCodeGraph(
  root,
  {
    initialState = "stale",
    indexDelayMs = 0,
    failCommand = "",
    failOnceCommand = "",
  } = {},
) {
  const executable = path.join(root, "fake-codegraph.mjs");
  const logPath = path.join(root, "codegraph-calls.jsonl");
  const statePath = path.join(root, "codegraph-state");
  await writeFile(statePath, initialState);
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const logPath = ${JSON.stringify(logPath)};`,
      `const statePath = ${JSON.stringify(statePath)};`,
      `const failOncePath = ${JSON.stringify(`${root}/fail-once`)};`,
      `const indexDelayMs = ${indexDelayMs};`,
      `const failCommand = ${JSON.stringify(failCommand)};`,
      `const failOnceCommand = ${JSON.stringify(failOnceCommand)};`,
      "const args = process.argv.slice(2);",
      'appendFileSync(logPath, JSON.stringify(args) + "\\n");',
      'const failOnce = (failOnceCommand === args[0] || (failOnceCommand === "invalid-status" && args[0] === "status")) && !existsSync(failOncePath);',
      "if (failOnce) writeFileSync(failOncePath, args[0]);",
      'if (args[0] === "status") {',
      '  if (failCommand === "invalid-status" || failOnceCommand === "invalid-status" && failOnce) {',
      '    process.stdout.write("not-json");',
      "    process.exit(0);",
      "  }",
      '  if (failCommand === "status" || failOnceCommand === "status" && failOnce) process.exit(1);',
      '  const stale = readFileSync(statePath, "utf8") === "stale";',
      "  process.stdout.write(JSON.stringify({ index: { reindexRecommended: stale } }));",
      "  process.exit(0);",
      "}",
      'if (args[0] === "index") {',
      "  if (indexDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, indexDelayMs));",
      '  if (failCommand === "index" || failOnceCommand === "index" && failOnce) process.exit(1);',
      '  writeFileSync(statePath, "current");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "sync") process.exit(0);',
      'process.stderr.write("unexpected command: " + args.join(" ") + "\\n");',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
  return { executable, logPath, statePath };
}

async function createFakeMcpCodeGraph(root) {
  const executable = path.join(root, "fake-mcp-codegraph.mjs");
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import readline from "node:readline";',
      "const args = process.argv.slice(2);",
      'if (args[0] === "init") {',
      '  mkdirSync(join(process.cwd(), ".codegraph"), { recursive: true });',
      '  writeFileSync(join(process.cwd(), ".codegraph", "codegraph.db"), "");',
      "  process.exit(0);",
      "}",
      'if (args[0] !== "serve") process.exit(1);',
      "const input = readline.createInterface({ input: process.stdin });",
      '      const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
      'input.on("line", (line) => {',
      "  let message;",
      "  try { message = JSON.parse(line); } catch { return; }",
      '  if (message.method === "initialize") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: {} });',
      "    return;",
      "  }",
      '  if (message.method !== "tools/call" || message.id === undefined) return;',
      "  const args = message.params?.arguments ?? {};",
      '  if (message.params?.name === "fail") {',
      '    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "controlled failure" } });',
      "    return;",
      "  }",
      "  const delayMs = Number(args.delayMs ?? 0);",
      '      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { content: [] } }), delayMs);',
      "});",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
  return { executable };
}

async function readCodeGraphCalls(logPath) {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForCodeGraphCall(logPath, command) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (
        (await readCodeGraphCalls(logPath)).some((args) => args[0] === command)
      )
        return;
    } catch {
      // The first command has not created the log yet.
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for fake CodeGraph ${command}`);
}

test("exposes the complete CodeGraph 1.6 MCP schema", () => {
  const tools = new Map(codegraphTools.map((tool) => [tool.name, tool]));
  const expectedProperties = {
    codegraph_search: ["kind", "limit", "projectPath", "query"],
    codegraph_node: [
      "file",
      "includeCode",
      "limit",
      "line",
      "offset",
      "projectPath",
      "symbol",
      "symbolsOnly",
    ],
    codegraph_files: [
      "format",
      "includeMetadata",
      "maxDepth",
      "path",
      "pattern",
      "projectPath",
    ],
    codegraph_callers: ["file", "limit", "projectPath", "symbol"],
    codegraph_callees: ["file", "limit", "projectPath", "symbol"],
    codegraph_impact: ["depth", "file", "projectPath", "symbol"],
    codegraph_explore: ["maxFiles", "projectPath", "query"],
    codegraph_status: ["projectPath"],
  };
  const expectedRequired = {
    codegraph_search: ["query"],
    codegraph_node: [],
    codegraph_files: [],
    codegraph_callers: ["symbol"],
    codegraph_callees: ["symbol"],
    codegraph_impact: ["symbol"],
    codegraph_explore: ["query"],
    codegraph_status: [],
  };
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  assert.deepEqual(
    [...tools.keys()].sort(),
    Object.keys(expectedProperties).sort(),
  );
  for (const [name, properties] of Object.entries(expectedProperties)) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is not registered`);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties).sort(),
      properties,
      `${name} properties drifted from CodeGraph 1.6`,
    );
    assert.deepEqual(tool.inputSchema.required, expectedRequired[name]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.annotations, readOnlyAnnotations);
  }
});

test("normalizes absolute file arguments and labels file-only node calls", () => {
  assert.equal(
    normalizeFilesPath(
      "/workspace/project/src/service.ts",
      "/workspace/project",
    ),
    "src/service.ts",
  );
  assert.equal(
    toolCallLabel("codegraph_node", {
      file: "src/service.ts",
      projectPath: "/workspace/project",
    }),
    "src/service.ts · project",
  );
});

test("reindexes a stale existing index once before serving it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "reindex");
  await mkdir(sourcePath);
  await createManagedDatabase(indexStore, identity);
  const fake = await createFakeCodeGraph(root, { indexDelayMs: 3_500 });
  const settings = {
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
    codegraphExecutable: fake.executable,
    requestTimeoutMs: 3_000,
  };

  const manager = new WorkspaceManager(settings);
  const prepared = await manager.prepare(identity);
  await manager.prepare(identity);

  assert.equal(prepared.state, "ready");
  assert.equal(await readFile(fake.statePath, "utf8"), "current");
  assert.deepEqual(await readCodeGraphCalls(fake.logPath), [
    ["status", "--json"],
    ["index", "--quiet"],
  ]);

  const nextSession = new WorkspaceManager({ ...settings, autoSync: false });
  await nextSession.prepare(identity);
  assert.deepEqual(await readCodeGraphCalls(fake.logPath), [
    ["status", "--json"],
    ["index", "--quiet"],
    ["status", "--json"],
  ]);
});

test("keeps serving when stale detection or rebuilding fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const failCommand of ["status", "invalid-status", "index"]) {
    const caseRoot = path.join(root, failCommand);
    const sourcePath = path.join(caseRoot, "project");
    const indexStore = path.join(caseRoot, "managed");
    const identity = workspaceIdentity(sourcePath, failCommand);
    await mkdir(sourcePath, { recursive: true });
    await createManagedDatabase(indexStore, identity);
    const fake = await createFakeCodeGraph(caseRoot, { failCommand });
    const manager = new WorkspaceManager({
      ...defaultSettings,
      autoSync: false,
      autoGc: false,
      indexStore,
      codegraphExecutable: fake.executable,
    });

    assert.equal((await manager.prepare(identity)).state, "ready");
    assert.equal((await manager.prepare(identity)).state, "ready");
    assert.deepEqual(
      await readCodeGraphCalls(fake.logPath),
      failCommand === "status" || failCommand === "invalid-status"
        ? [
            ["status", "--json"],
            ["status", "--json"],
          ]
        : [
            ["status", "--json"],
            ["index", "--quiet"],
            ["status", "--json"],
            ["index", "--quiet"],
          ],
    );
  }
});

test("re-arms stale checks after transient status and rebuild failures", async (t) => {
  for (const failOnceCommand of ["status", "invalid-status", "index"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "project");
    const indexStore = path.join(root, "managed");
    const identity = workspaceIdentity(sourcePath, `retry-${failOnceCommand}`);
    await mkdir(sourcePath);
    await createManagedDatabase(indexStore, identity);
    const fake = await createFakeCodeGraph(root, { failOnceCommand });
    const manager = new WorkspaceManager({
      ...defaultSettings,
      autoSync: false,
      autoGc: false,
      indexStore,
      codegraphExecutable: fake.executable,
    });

    assert.equal((await manager.prepare(identity)).state, "ready");
    assert.equal((await manager.prepare(identity)).state, "ready");
    assert.equal(await readFile(fake.statePath, "utf8"), "current");
    const calls = await readCodeGraphCalls(fake.logPath);
    assert.deepEqual(
      calls,
      failOnceCommand === "index"
        ? [
            ["status", "--json"],
            ["index", "--quiet"],
            ["status", "--json"],
            ["index", "--quiet"],
          ]
        : [
            ["status", "--json"],
            ["status", "--json"],
            ["index", "--quiet"],
          ],
    );
  }
});

test("keeps a long reindex lock alive with heartbeats", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "heartbeat");
  await mkdir(sourcePath);
  await createManagedDatabase(indexStore, identity);
  const fake = await createFakeCodeGraph(root, { indexDelayMs: 3_500 });
  const settings = {
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    requestTimeoutMs: 1_000,
    indexStore,
    codegraphExecutable: fake.executable,
  };

  const firstPrepare = new WorkspaceManager(settings).prepare(identity);
  await waitForCodeGraphCall(fake.logPath, "index");
  await delay(2_200);
  await assert.rejects(
    new WorkspaceManager(settings).prepare(identity),
    /Timed out waiting for CodeGraph index lock/,
  );
  assert.equal((await firstPrepare).state, "ready");
  assert.deepEqual(await readCodeGraphCalls(fake.logPath), [
    ["status", "--json"],
    ["index", "--quiet"],
  ]);
});

test("protects overlapping and failed worker calls with counted leases", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await createFakeMcpCodeGraph(root);
  const pool = new CodeGraphWorkerPool({
    ...defaultSettings,
    autoGc: false,
    indexStore: path.join(root, "managed"),
    codegraphExecutable: fake.executable,
    requestTimeoutMs: 1_000,
  });
  t.after(() => pool.close());

  const first = pool.call("/project", "codegraph_node", { delayMs: 100 });
  const second = pool.call("/project", "codegraph_node", { delayMs: 100 });
  assert.deepEqual(pool.activeProjects(), new Set(["/project"]));
  assert.deepEqual(await Promise.all([first, second]), [
    { content: [] },
    { content: [] },
  ]);
  assert.deepEqual(pool.activeProjects(), new Set());

  await assert.rejects(pool.call("/project", "fail", {}), /controlled failure/);
  assert.deepEqual(pool.activeProjects(), new Set());
  await pool.close();
  assert.deepEqual(pool.activeProjects(), new Set());
  await assert.rejects(pool.call("/project", "codegraph_node", {}), /closed/);
});

test("reuses a legacy CodeGraph symlink for the same source directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const legacyIndex = path.join(root, "legacy-index");
  await mkdir(sourcePath);
  await mkdir(legacyIndex);
  await writeFile(
    path.join(legacyIndex, "source.json"),
    `${JSON.stringify({ sourceDir: sourcePath, version: 1 }, null, 2)}\n`,
  );
  await writeFile(path.join(legacyIndex, "codegraph.db"), "");
  await symlink(legacyIndex, path.join(sourcePath, ".codegraph"), "dir");
  const fake = await createFakeCodeGraph(root, { initialState: "current" });

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore: path.join(root, "managed"),
    codegraphExecutable: fake.executable,
  });
  const prepared = await manager.prepare({
    sourcePath,
    repoRoot: sourcePath,
    repoIdentity: "repo-identity",
    worktreeIdentity: "worktree-identity",
    gitCommonDir: "",
  });

  assert.equal(prepared.state, "ready");
  assert.equal(prepared.indexPath, await realpath(legacyIndex));
  assert.equal(prepared.managed, false);
  assert.equal(
    await realpath(path.join(sourcePath, ".codegraph")),
    await realpath(legacyIndex),
  );
  assert.equal(
    await readlink(path.join(sourcePath, ".codegraph")),
    legacyIndex,
  );
});

test("rejects a legacy CodeGraph symlink for a different source directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const otherSourcePath = path.join(root, "other-project");
  const legacyIndex = path.join(root, "legacy-index");
  await mkdir(sourcePath);
  await mkdir(otherSourcePath);
  await mkdir(legacyIndex);
  await writeFile(
    path.join(legacyIndex, "source.json"),
    `${JSON.stringify({ sourceDir: otherSourcePath, version: 1 }, null, 2)}\n`,
  );
  await writeFile(path.join(legacyIndex, "codegraph.db"), "");
  await symlink(legacyIndex, path.join(sourcePath, ".codegraph"), "dir");

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore: path.join(root, "managed"),
  });

  await assert.rejects(
    manager.prepare({
      sourcePath,
      repoRoot: sourcePath,
      repoIdentity: "repo-identity",
      worktreeIdentity: "worktree-identity",
      gitCommonDir: "",
    }),
    /Refusing to replace an unmanaged \.codegraph symlink/,
  );
  assert.equal(
    await realpath(path.join(sourcePath, ".codegraph")),
    await realpath(legacyIndex),
  );
});

test("rejects a legacy CodeGraph symlink with an unsupported metadata version", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const legacyIndex = path.join(root, "legacy-index");
  await mkdir(sourcePath);
  await mkdir(legacyIndex);
  await writeFile(
    path.join(legacyIndex, "source.json"),
    `${JSON.stringify({ sourceDir: sourcePath, version: 2 }, null, 2)}\n`,
  );
  await writeFile(path.join(legacyIndex, "codegraph.db"), "");
  await symlink(legacyIndex, path.join(sourcePath, ".codegraph"), "dir");

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore: path.join(root, "managed"),
  });

  await assert.rejects(
    manager.prepare({
      sourcePath,
      repoRoot: sourcePath,
      repoIdentity: "repo-identity",
      worktreeIdentity: "worktree-identity",
      gitCommonDir: "",
    }),
    /Refusing to replace an unmanaged \.codegraph symlink/,
  );
});

test("repairs a dangling managed CodeGraph symlink during prepare", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "repair");
  await mkdir(sourcePath);
  const expectedIndex = await createManagedDatabase(indexStore, identity);
  const staleTarget = path.join(indexStore, "projects", "stale-index");
  await symlink(staleTarget, path.join(sourcePath, ".codegraph"), "dir");
  const fake = await createFakeCodeGraph(root, { initialState: "current" });

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
    codegraphExecutable: fake.executable,
  });
  const prepared = await manager.prepare(identity);

  assert.equal(prepared.state, "ready");
  assert.equal(prepared.managed, true);
  assert.equal(prepared.indexPath, await realpath(expectedIndex));
  assert.equal(
    await realpath(path.join(sourcePath, ".codegraph")),
    await realpath(expectedIndex),
  );
});

test("repairs an alias-spelled dangling managed symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const indexStoreAlias = path.join(root, "managed-alias");
  const identity = workspaceIdentity(sourcePath, "alias");
  await mkdir(sourcePath);
  await mkdir(indexStore);
  await symlink(indexStore, indexStoreAlias, "dir");
  const expectedIndex = await createManagedDatabase(indexStore, identity);
  const staleTarget = path.join(indexStoreAlias, "projects", "stale-index");
  await symlink(staleTarget, path.join(sourcePath, ".codegraph"), "dir");
  const fake = await createFakeCodeGraph(root, { initialState: "current" });

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
    codegraphExecutable: fake.executable,
  });
  const prepared = await manager.prepare(identity);

  assert.equal(prepared.indexPath, await realpath(expectedIndex));
  assert.equal(
    await realpath(path.join(sourcePath, ".codegraph")),
    await realpath(expectedIndex),
  );
  const preparedAgain = await manager.prepare(identity);
  assert.equal(preparedAgain.indexPath, prepared.indexPath);
});

test("preserves a dangling symlink outside managed projects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "unmanaged");
  await mkdir(sourcePath);
  await createManagedDatabase(indexStore, identity);
  const unmanagedTarget = path.join(indexStore, "unmanaged", "missing");
  const linkPath = path.join(sourcePath, ".codegraph");
  await symlink(unmanagedTarget, linkPath, "dir");

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
  });
  await assert.rejects(
    manager.prepare(identity),
    /Refusing to replace an unmanaged \.codegraph symlink/,
  );
  assert.equal(await readlink(linkPath), unmanagedTarget);
});

test("preserves a dangling link redirected outside managed projects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "redirected");
  await mkdir(sourcePath);
  await createManagedDatabase(indexStore, identity);
  const redirectedAncestor = path.join(indexStore, "projects", "redirected");
  await symlink(path.join(root, "outside"), redirectedAncestor, "dir");
  const redirectedTarget = path.join(redirectedAncestor, "missing");
  const linkPath = path.join(sourcePath, ".codegraph");
  await symlink(redirectedTarget, linkPath, "dir");

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
  });
  await assert.rejects(
    manager.prepare(identity),
    /Refusing to replace an unmanaged \.codegraph symlink/,
  );
  assert.equal(await readlink(linkPath), redirectedTarget);
});

test("preserves parent traversal across a managed-store symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const outsideDirectory = path.join(root, "outside", "directory");
  const identity = workspaceIdentity(sourcePath, "parent-traversal");
  await mkdir(sourcePath);
  await mkdir(outsideDirectory, { recursive: true });
  await createManagedDatabase(indexStore, identity);
  const redirectedAncestor = path.join(indexStore, "projects", "redirected");
  await symlink(outsideDirectory, redirectedAncestor, "dir");
  const redirectedTarget = `${redirectedAncestor}${path.sep}..${path.sep}missing`;
  const linkPath = path.join(sourcePath, ".codegraph");
  await symlink(redirectedTarget, linkPath, "dir");

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
  });
  await assert.rejects(
    manager.prepare(identity),
    /Refusing to replace an unmanaged \.codegraph symlink/,
  );
  assert.equal(await readlink(linkPath), redirectedTarget);
});

test("lazily repairs a managed link after garbage collection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "after-gc");
  const staleIndex = path.join(indexStore, "projects", "stale-index");
  const linkPath = path.join(sourcePath, ".codegraph");
  await mkdir(sourcePath);
  await mkdir(staleIndex, { recursive: true });
  await writeFile(path.join(staleIndex, "codegraph.db"), "");
  await writeFile(
    path.join(staleIndex, ".pi-codegraph.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      sourcePath,
      repoIdentity: "stale-repo",
      worktreeIdentity: "stale-worktree",
      managed: true,
    })}\n`,
  );
  await symlink(staleIndex, linkPath, "dir");
  const fake = await createFakeCodeGraph(root, { initialState: "current" });

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
    codegraphExecutable: fake.executable,
  });
  const collected = await manager.gc(new Set(), true);

  assert.deepEqual(collected.removed, [staleIndex]);
  assert.equal(await readlink(linkPath), staleIndex);
  await assert.rejects(realpath(staleIndex), { code: "ENOENT" });

  const expectedIndex = await createManagedDatabase(indexStore, identity);
  const prepared = await manager.prepare(identity);

  assert.equal(prepared.indexPath, await realpath(expectedIndex));
  assert.equal(await realpath(linkPath), await realpath(expectedIndex));
});

test("fails closed when CodeGraph ownership is malformed or changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "ownership");
  await mkdir(sourcePath);
  const indexPath = await createManagedDatabase(indexStore, identity);
  await writeFile(
    path.join(indexPath, ".pi-codegraph.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      sourcePath,
      repoIdentity: "stale-repo",
      worktreeIdentity: "stale-worktree",
      managed: true,
    })}\n`,
  );
  const free = await inspectCodeGraphOwnership(indexPath, sourcePath);
  assert.equal(free.state, "free");
  assert.ok(free.token);
  await writeFile(path.join(indexPath, "writer.pid"), "{malformed");
  assert.equal(
    await codeGraphOwnership.same(indexPath, sourcePath, free.token),
    false,
  );
  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoGc: false,
    indexStore,
  });

  assert.deepEqual((await manager.gc(new Set(), true)).removed, []);
  assert.ok((await stat(indexPath)).isDirectory());
  await rm(path.join(indexPath, "writer.pid"));
  assert.deepEqual((await manager.gc(new Set(), true)).removed, [indexPath]);
});

test("retains a managed index while the central daemon owner is live", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "central-daemon-ownership");
  await mkdir(sourcePath);
  const indexPath = await createManagedDatabase(indexStore, identity);
  await writeFile(
    path.join(indexPath, ".pi-codegraph.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      sourcePath,
      repoIdentity: "stale-repo",
      worktreeIdentity: "stale-worktree",
      managed: true,
    })}\n`,
  );
  await symlink(indexPath, path.join(sourcePath, ".codegraph"), "dir");

  const daemon = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
    },
  );
  t.after(() => daemon.kill());
  await new Promise((resolve, reject) => {
    daemon.once("spawn", resolve);
    daemon.once("error", reject);
  });
  const daemonCodeGraphDir = path.join(indexStore, "daemon", ".codegraph");
  await mkdir(daemonCodeGraphDir, { recursive: true });
  await writeFile(
    path.join(daemonCodeGraphDir, "daemon.pid"),
    `${JSON.stringify({
      pid: daemon.pid,
      version: "1.6.2",
      socketPath: path.join(root, "daemon.sock"),
      startedAt: Date.now(),
    })}\n`,
  );

  assert.deepEqual(await inspectCodeGraphOwnership(indexPath, sourcePath), {
    state: "live",
  });
  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoGc: false,
    indexStore,
  });
  assert.deepEqual((await manager.gc(new Set(), true)).removed, []);
  assert.ok((await stat(indexPath)).isDirectory());
});

test("refuses only projects matched by excludedProjectRoots", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const exact = path.join(root, "scratch");
  const belowExact = path.join(exact, "repo");
  const tree = path.join(root, "tree");
  const belowTree = path.join(tree, "repo");
  for (const directory of [belowExact, belowTree])
    await mkdir(directory, { recursive: true });
  const indexStore = path.join(root, "managed");
  const fake = await createFakeCodeGraph(root, { initialState: "current" });
  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
    codegraphExecutable: fake.executable,
    excludedProjectRoots: [exact, path.join(tree, "**")],
  });

  for (const excluded of [exact, tree, belowTree]) {
    const identity = workspaceIdentity(excluded, "excluded");
    await assert.rejects(manager.prepare(identity), /excludedProjectRoots/);
    await assert.rejects(readlink(path.join(excluded, ".codegraph")), {
      code: "ENOENT",
    });
  }
  const allowed = workspaceIdentity(belowExact, "below-exact");
  const expectedIndex = await createManagedDatabase(indexStore, allowed);
  const prepared = await manager.prepare(allowed);

  assert.equal(prepared.indexPath, await realpath(expectedIndex));
  assert.deepEqual(await readdir(path.join(indexStore, "projects")), [
    path.basename(expectedIndex),
  ]);
});

test("reads excludedProjectRoots from config and environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({ excludedProjectRoots: ["~/scratch", "/tmp/**"] }),
  );
  const previous = process.env.PI_CODEGRAPH_EXCLUDED_ROOTS;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODEGRAPH_EXCLUDED_ROOTS;
    else process.env.PI_CODEGRAPH_EXCLUDED_ROOTS = previous;
  });

  delete process.env.PI_CODEGRAPH_EXCLUDED_ROOTS;
  assert.deepEqual((await loadSettings({ configFile })).excludedProjectRoots, [
    path.join(os.homedir(), "scratch"),
    path.join(path.sep, "tmp", "**"),
  ]);

  process.env.PI_CODEGRAPH_EXCLUDED_ROOTS = ["/a", "/b/**"].join(
    path.delimiter,
  );
  assert.deepEqual((await loadSettings({ configFile })).excludedProjectRoots, [
    path.resolve("/a"),
    path.resolve("/b/**"),
  ]);
});

test("does not leave an empty managed index for an in-repo .codegraph", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await writeFile(path.join(sourcePath, ".codegraph", "codegraph.db"), "");
  const fake = await createFakeCodeGraph(root, { initialState: "current" });
  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
    codegraphExecutable: fake.executable,
  });

  const prepared = await manager.prepare(
    workspaceIdentity(sourcePath, "in-repo"),
  );

  assert.equal(prepared.indexPath, path.join(sourcePath, ".codegraph"));
  await assert.rejects(readdir(path.join(indexStore, "projects")), {
    code: "ENOENT",
  });
});

test("collects abandoned and excluded-root indexes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const indexStore = path.join(root, "managed");
  const projects = path.join(indexStore, "projects");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  const createIndex = async (name, { age, metadata } = {}) => {
    const indexPath = path.join(projects, name);
    await mkdir(indexPath, { recursive: true });
    await writeFile(path.join(indexPath, "codegraph.db"), "");
    if (metadata)
      await writeFile(
        path.join(indexPath, ".pi-codegraph.json"),
        `${JSON.stringify(metadata)}\n`,
      );
    if (age) {
      await utimes(path.join(indexPath, "codegraph.db"), age, age);
      await utimes(indexPath, age, age);
    }
    return indexPath;
  };
  const excludedSource = path.join(root, "excluded");
  const keptSource = path.join(root, "kept");
  await mkdir(excludedSource);
  await mkdir(keptSource);
  const managedFor = async (source) => ({
    schemaVersion: 2,
    managed: true,
    ...(await gitIdentity(source)),
  });
  const excludedRoot = await createIndex("excluded-root", {
    metadata: await managedFor(excludedSource),
  });
  const kept = await createIndex("kept", {
    metadata: await managedFor(keptSource),
  });
  const abandoned = await createIndex("abandoned", { age: twoDaysAgo });
  const fresh = await createIndex("fresh");
  const locked = await createIndex("locked", { age: twoDaysAgo });
  await mkdir(path.join(indexStore, "locks", "locked.lock"), {
    recursive: true,
  });

  const manager = new WorkspaceManager({
    ...defaultSettings,
    indexStore,
    excludedProjectRoots: [excludedSource],
  });
  const collected = await manager.gc(new Set(), true);

  assert.deepEqual(collected.removed.sort(), [abandoned, excludedRoot].sort());
  assert.ok((await stat(fresh)).isDirectory());
  assert.ok((await stat(kept)).isDirectory());
  assert.ok((await stat(locked)).isDirectory());
});

test("truncates the CodeGraph write-ahead log after syncing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "project");
  const indexStore = path.join(root, "managed");
  const identity = workspaceIdentity(sourcePath, "wal");
  await mkdir(sourcePath);
  const indexPath = managedIndexPath(indexStore, identity);
  await mkdir(indexPath, { recursive: true });
  const database = path.join(indexPath, "codegraph.db");
  const writer = new DatabaseSync(database);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.exec("CREATE TABLE nodes (body BLOB)");
  writer.prepare("INSERT INTO nodes VALUES (?)").run(Buffer.alloc(1 << 20));
  assert.ok((await stat(`${database}-wal`)).size > 1 << 20);
  const fake = await createFakeCodeGraph(root, { initialState: "current" });
  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoGc: false,
    indexStore,
    codegraphExecutable: fake.executable,
  });

  await manager.prepare(identity, { forceSync: true });

  assert.equal((await stat(`${database}-wal`)).size, 0);
  assert.equal(writer.prepare("SELECT count(*) AS n FROM nodes").get().n, 1);
});
