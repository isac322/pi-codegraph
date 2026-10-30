import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceManager } from "../dist/lib/codegraph.js";
import { codeGraphOwnership } from "../dist/lib/codegraph-ownership.js";
import { defaultSettings } from "../dist/lib/config.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexStore = path.join(root, "managed");
  const indexPath = path.join(indexStore, "projects", "obsolete");
  const sourcePath = path.join(root, "removed-source");
  await mkdir(indexPath, { recursive: true });
  await writeFile(path.join(indexPath, "codegraph.db"), "retained database");
  await writeFile(
    path.join(indexPath, ".pi-codegraph.json"),
    JSON.stringify({
      schemaVersion: 2,
      sourcePath,
      repoIdentity: "old-repository",
      worktreeIdentity: "old-worktree",
      managed: true,
    }),
  );
  return { indexStore, indexPath, sourcePath };
}

// A separate process exercises the pinned 1.6.2 rebuild admission protocol,
// O_EXCL contention, signal-0 liveness, and a real retained database FD.
async function ownerProcess(t, indexPath) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    const path = require("node:path");
    const indexPath = process.argv[1];
    const encode = () => JSON.stringify({ pid: process.pid, mode: "direct", startedAt: Date.now(), ready: false }) + "\\n";
    const held = [];
    process.on("message", (command) => {
      try {
        if (command.action === "probe") {
          let intent;
          try { intent = JSON.parse(fs.readFileSync(path.join(indexPath, "rebuild.pid"), "utf8")); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          if (intent && intent.pid !== process.pid) {
            try { process.kill(intent.pid, 0); process.send({ admitted: false }); return; }
            catch (error) { if (error.code !== "ESRCH") throw error; }
          }
          const writer = fs.openSync(path.join(indexPath, "writer.pid"), "wx", 0o600);
          fs.writeFileSync(writer, encode());
          fs.closeSync(writer);
          held.push(fs.openSync(path.join(indexPath, "codegraph.db"), "r"));
          process.send({ admitted: true, links: fs.fstatSync(held.at(-1)).nlink });
        } else if (command.action === "claim") {
          try {
            const fd = fs.openSync(path.join(indexPath, "rebuild.pid"), "wx", 0o600);
            fs.writeFileSync(fd, encode());
            fs.closeSync(fd);
            process.send({ acquired: true });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            process.send({ acquired: false });
          }
        } else if (command.action === "write") {
          const destination = command.path;
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          if (command.replace) fs.unlinkSync(destination);
          fs.writeFileSync(destination, command.raw ?? encode());
          if (command.hold) held.push(fs.openSync(path.join(indexPath, "codegraph.db"), "r"));
          process.send({ raw: fs.readFileSync(destination, "utf8") });
        } else if (command.action === "read-held") {
          const fd = held.at(-1);
          process.send({ links: fs.fstatSync(fd).nlink, text: fs.readFileSync(fd, "utf8") });
        }
      } catch (error) { process.send({ error: String(error) }); }
    });
    process.send({ ready: true });
  `,
      indexPath,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  assert.deepEqual((await once(child, "message"))[0], { ready: true });
  return {
    pid: child.pid,
    async command(command) {
      const reply = once(child, "message");
      child.send(command);
      const [result] = await reply;
      assert.equal(result.error, undefined);
      return result;
    },
    async stop() {
      child.kill();
      await exited;
    },
  };
}

async function freeToken(indexPath, sourcePath) {
  const snapshot = await codeGraphOwnership.inspect(indexPath, sourcePath);
  assert.equal(snapshot.state, "free");
  assert.ok(snapshot.token);
  return snapshot.token;
}

function manager(indexStore) {
  return new WorkspaceManager({
    ...defaultSettings,
    indexStore,
    autoGc: false,
  });
}

test("rebuild reservation excludes a competing process until released", {
  timeout: 10_000,
}, async (t) => {
  const { indexPath, sourcePath } = await fixture(t);
  const peer = await ownerProcess(t, indexPath);
  const token = await freeToken(indexPath, sourcePath);
  const reservation = await codeGraphOwnership.reserve(
    indexPath,
    sourcePath,
    token,
  );
  assert.ok(reservation);
  t.after(() => reservation.release());
  const record = JSON.parse(
    await readFile(path.join(indexPath, "rebuild.pid"), "utf8"),
  );
  assert.equal(record.pid, process.pid);
  assert.equal(typeof record.mode, "string");
  assert.equal(typeof record.startedAt, "number");
  assert.equal(record.ready, false);
  assert.equal(
    (await stat(path.join(indexPath, "rebuild.pid"))).mode & 0o777,
    0o600,
  );
  assert.equal(await reservation.same(), true);
  assert.deepEqual(await peer.command({ action: "claim" }), {
    acquired: false,
  });
  assert.deepEqual(await peer.command({ action: "probe" }), {
    admitted: false,
  });
  assert.deepEqual(await codeGraphOwnership.inspect(indexPath, sourcePath), {
    state: "live",
  });
  assert.equal(
    await codeGraphOwnership.reserve(indexPath, sourcePath, token),
    undefined,
  );
  reservation.release();
  assert.deepEqual(await peer.command({ action: "probe" }), {
    admitted: true,
    links: 1,
  });
  assert.deepEqual(await peer.command({ action: "read-held" }), {
    links: 1,
    text: "retained database",
  });
  assert.deepEqual(await codeGraphOwnership.inspect(indexPath, sourcePath), {
    state: "live",
  });
});

test("reservation never steals a live or malformed rebuild record", {
  timeout: 10_000,
}, async (t) => {
  const { indexPath, sourcePath } = await fixture(t);
  const peer = await ownerProcess(t, indexPath);
  const token = await freeToken(indexPath, sourcePath);
  assert.deepEqual(await peer.command({ action: "claim" }), { acquired: true });
  const rebuild = path.join(indexPath, "rebuild.pid");
  const original = await readFile(rebuild, "utf8");
  assert.equal(
    await codeGraphOwnership.reserve(indexPath, sourcePath, token),
    undefined,
  );
  assert.equal(await readFile(rebuild, "utf8"), original);
  await peer.command({ action: "write", path: rebuild, raw: "{malformed" });
  assert.equal(
    await codeGraphOwnership.reserve(indexPath, sourcePath, token),
    undefined,
  );
  assert.equal(await readFile(rebuild, "utf8"), "{malformed");
  assert.deepEqual((await readdir(indexPath)).sort(), [
    ".pi-codegraph.json",
    "codegraph.db",
    "rebuild.pid",
  ]);
});

test("reservation compares verified-dead records and preserves a replacement lock", {
  timeout: 10_000,
}, async (t) => {
  const { indexPath, sourcePath } = await fixture(t);
  const deadPeer = await ownerProcess(t, indexPath);
  const writer = path.join(indexPath, "writer.pid");
  await deadPeer.command({ action: "write", path: writer });
  await deadPeer.stop();
  const token = await freeToken(indexPath, sourcePath);
  const reservation = await codeGraphOwnership.reserve(
    indexPath,
    sourcePath,
    token,
  );
  assert.ok(reservation);
  t.after(() => reservation.release());
  assert.equal(await reservation.same(), true);
  const peer = await ownerProcess(t, indexPath);
  const old = JSON.parse(await readFile(writer, "utf8"));
  await peer.command({
    action: "write",
    path: writer,
    raw: JSON.stringify({ ...old, mode: "changed-dead-owner" }),
  });
  assert.equal(await reservation.same(), false);
  const rebuild = path.join(indexPath, "rebuild.pid");
  const replacement = await peer.command({
    action: "write",
    path: rebuild,
    replace: true,
  });
  reservation.release();
  assert.equal(await readFile(rebuild, "utf8"), replacement.raw);
  assert.equal(await reservation.same(), false);
});

test("GC retains owners appearing at either side of reservation acquisition", {
  timeout: 30_000,
}, async (t) => {
  for (const phase of ["before", "after"]) {
    for (const kind of [
      "live-writer",
      "malformed-writer",
      "central-owner",
      "replacement-intent",
    ]) {
      if (phase === "before" && kind === "replacement-intent") continue;
      await t.test(`${phase}: ${kind}`, async (t) => {
        const { indexStore, indexPath } = await fixture(t);
        const peer = await ownerProcess(t, indexPath);
        const original = codeGraphOwnership.reserve;
        t.after(() => {
          codeGraphOwnership.reserve = original;
        });
        let reached = false;
        let destination;
        let written;
        codeGraphOwnership.reserve = async (...args) => {
          reached = true;
          assert.ok(
            (
              await stat(path.join(indexStore, "locks", "obsolete.lock"))
            ).isDirectory(),
          );
          const reservation =
            phase === "after" ? await original(...args) : undefined;
          if (phase === "after") assert.ok(reservation);
          destination =
            kind === "central-owner"
              ? path.join(indexStore, "daemon", ".codegraph", "writer.pid")
              : path.join(
                  indexPath,
                  kind === "replacement-intent" ? "rebuild.pid" : "writer.pid",
                );
          written = await peer.command({
            action: "write",
            path: destination,
            ...(kind === "malformed-writer" ? { raw: "{uncertain" } : {}),
            replace: kind === "replacement-intent",
            hold: kind === "live-writer",
          });
          return phase === "after" ? reservation : original(...args);
        };
        assert.deepEqual(
          (await manager(indexStore).gc(new Set(), true)).removed,
          [],
        );
        assert.equal(reached, true);
        assert.equal(
          await readFile(path.join(indexPath, "codegraph.db"), "utf8"),
          "retained database",
        );
        assert.equal(await readFile(destination, "utf8"), written.raw);
        if (kind === "live-writer")
          assert.deepEqual(await peer.command({ action: "read-held" }), {
            links: 1,
            text: "retained database",
          });
        if (kind !== "replacement-intent")
          await assert.rejects(stat(path.join(indexPath, "rebuild.pid")), {
            code: "ENOENT",
          });
        assert.deepEqual(await readdir(path.join(indexStore, "locks")), []);
      });
    }
  }
});

test("GC removes a free stale index while blocking competing admission", {
  timeout: 10_000,
}, async (t) => {
  const { indexStore, indexPath } = await fixture(t);
  const peer = await ownerProcess(t, indexPath);
  const original = codeGraphOwnership.reserve;
  t.after(() => {
    codeGraphOwnership.reserve = original;
  });
  let reached = false;
  codeGraphOwnership.reserve = async (...args) => {
    const reservation = await original(...args);
    assert.ok(reservation);
    reached = true;
    assert.deepEqual(await peer.command({ action: "claim" }), {
      acquired: false,
    });
    assert.deepEqual(await peer.command({ action: "probe" }), {
      admitted: false,
    });
    return reservation;
  };
  assert.deepEqual((await manager(indexStore).gc(new Set(), true)).removed, [
    indexPath,
  ]);
  assert.equal(reached, true);
  await assert.rejects(stat(indexPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(indexStore, "locks")), []);
});
