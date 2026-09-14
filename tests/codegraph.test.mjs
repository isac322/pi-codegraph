import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore: path.join(root, "managed"),
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

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
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

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
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

  const manager = new WorkspaceManager({
    ...defaultSettings,
    autoSync: false,
    autoGc: false,
    indexStore,
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
