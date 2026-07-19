import assert from "node:assert/strict";
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

import { WorkspaceManager } from "../dist/lib/codegraph.js";
import { defaultSettings } from "../dist/lib/config.js";

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
