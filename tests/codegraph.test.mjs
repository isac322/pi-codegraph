import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { normalizeFilesPath, WorkspaceManager } from "../dist/lib/codegraph.js";
import { defaultSettings } from "../dist/lib/config.js";
import { codegraphTools, toolCallLabel } from "../dist/lib/tool-metadata.js";

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
  { initialState = "stale", indexDelayMs = 0, failCommand = "" } = {},
) {
  const executable = path.join(root, "fake-codegraph.mjs");
  const logPath = path.join(root, "codegraph-calls.jsonl");
  const statePath = path.join(root, "codegraph-state");
  await writeFile(statePath, initialState);
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      `const logPath = ${JSON.stringify(logPath)};`,
      `const statePath = ${JSON.stringify(statePath)};`,
      `const indexDelayMs = ${indexDelayMs};`,
      `const failCommand = ${JSON.stringify(failCommand)};`,
      "const args = process.argv.slice(2);",
      'appendFileSync(logPath, JSON.stringify(args) + "\\n");',
      'if (args[0] === "status") {',
      '  if (failCommand === "invalid-status") {',
      '    process.stdout.write("not-json");',
      "    process.exit(0);",
      "  }",
      '  if (failCommand === "status") process.exit(1);',
      '  const stale = readFileSync(statePath, "utf8") === "stale";',
      "  process.stdout.write(JSON.stringify({ index: { reindexRecommended: stale } }));",
      "  process.exit(0);",
      "}",
      'if (args[0] === "index") {',
      "  if (indexDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, indexDelayMs));",
      '  if (failCommand === "index") process.exit(1);',
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
        ? [["status", "--json"]]
        : [
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
