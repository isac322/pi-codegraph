import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type CodeGraphOwnershipState = "free" | "live" | "unknown";

export interface CodeGraphOwnershipSnapshot {
  state: CodeGraphOwnershipState;
  token?: string;
}

export interface CodeGraphOwnershipInspector {
  inspect(
    indexPath: string,
    sourcePath: string,
  ): Promise<CodeGraphOwnershipSnapshot>;
  same(indexPath: string, sourcePath: string, token: string): Promise<boolean>;
}

type ArtifactKind =
  | "writer.pid"
  | "rebuild.pid"
  | "daemon.pid"
  | "codegraph.lock";

interface ArtifactRecord {
  kind: ArtifactKind;
  path: string;
  exists: boolean;
  raw?: string;
  stat?: {
    dev: number;
    ino: number;
    mode: number;
    size: number;
    mtimeMs: number;
  };
  readable: boolean;
}

interface ArtifactSnapshot {
  records: ArtifactRecord[];
  token: string;
  state: CodeGraphOwnershipState;
}

const PID_ARTIFACTS = [
  "writer.pid",
  "rebuild.pid",
  "daemon.pid",
] as const satisfies readonly ArtifactKind[];

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessAlive(pid: number): "live" | "dead" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (!isNodeError(error)) return "unknown";
    if (error.code === "ESRCH") return "dead";
    // EPERM means the process exists but is not signalable by this user.
    // Every other errno is also unverifiable and must fail closed.
    return "unknown";
  }
}

function parsePid(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function parseWriterPid(raw: string): number | undefined {
  try {
    const value = JSON.parse(raw) as {
      pid?: unknown;
      mode?: unknown;
      startedAt?: unknown;
      ready?: unknown;
    };
    if (
      !Number.isInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.mode !== "string" ||
      (value.startedAt !== undefined && typeof value.startedAt !== "number") ||
      (value.ready !== undefined && typeof value.ready !== "boolean")
    )
      return undefined;
    return value.pid as number;
  } catch {
    return undefined;
  }
}

function parseDaemonPid(raw: string): number | undefined {
  try {
    const value = JSON.parse(raw) as {
      pid?: unknown;
      version?: unknown;
      socketPath?: unknown;
      startedAt?: unknown;
    };
    if (
      !Number.isInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.version !== "string" ||
      typeof value.socketPath !== "string" ||
      typeof value.startedAt !== "number"
    )
      return undefined;
    return value.pid as number;
  } catch {
    // CodeGraph 1.6.2 also accepts the legacy plain-decimal daemon pid.
    return parsePid(raw);
  }
}

async function readArtifact(
  path: string,
  kind: ArtifactKind,
): Promise<ArtifactRecord> {
  try {
    const info = await lstat(path);
    const record: ArtifactRecord = {
      kind,
      path,
      exists: true,
      stat: {
        dev: info.dev,
        ino: info.ino,
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
      },
      readable: false,
    };
    if (!info.isFile()) return record;
    try {
      record.raw = await readFile(path, "utf8");
      record.readable = true;
    } catch {
      // An unreadable owner record is unsafe to interpret.
    }
    return record;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      return { kind, path, exists: false, readable: true };
    return { kind, path, exists: true, readable: false };
  }
}

function tokenFor(records: readonly ArtifactRecord[]): string {
  return JSON.stringify(
    records.map((record) => ({
      kind: record.kind,
      path: record.path,
      exists: record.exists,
      raw: record.raw,
      stat: record.stat,
      readable: record.readable,
    })),
  );
}

async function resolveArtifactRoots(
  indexPath: string,
  sourcePath: string,
): Promise<string[] | undefined> {
  if (!isAbsolute(indexPath) || !isAbsolute(sourcePath)) return undefined;
  const managed = resolve(indexPath);
  const source = resolve(sourcePath);
  try {
    const linkTarget = await realpath(join(source, ".codegraph"));
    if (resolve(linkTarget) !== managed) return undefined;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") return undefined;
    // The source/worktree may have been removed; the managed index remains a
    // valid GC candidate and its own artifacts still need inspection.
  }

  // The worker pool's central daemon is rooted at indexStore/daemon. Its
  // `.codegraph` records describe an owner that may retain any cached project
  // database, so a live central owner protects every candidate in the store.
  const indexStore = dirname(dirname(managed));
  return [join(indexStore, "daemon", ".codegraph"), managed];
}

async function readSnapshot(
  indexPath: string,
  sourcePath: string,
): Promise<ArtifactSnapshot | undefined> {
  const roots = await resolveArtifactRoots(indexPath, sourcePath);
  if (!roots) return undefined;
  const paths = roots.flatMap((root) => [
    ...PID_ARTIFACTS.map((name) => ({ path: join(root, name), kind: name })),
    { path: join(root, "codegraph.lock"), kind: "codegraph.lock" as const },
  ]);
  const records = (
    await Promise.all(paths.map(({ path, kind }) => readArtifact(path, kind)))
  ).sort((left, right) => left.path.localeCompare(right.path));
  const token = tokenFor(records);
  let state: CodeGraphOwnershipState = "free";

  for (const record of records) {
    if (!record.exists) continue;
    if (!record.readable || !record.raw) {
      state = "unknown";
      continue;
    }
    const pid =
      record.kind === "daemon.pid"
        ? parseDaemonPid(record.raw)
        : record.kind === "codegraph.lock"
          ? parsePid(record.raw)
          : parseWriterPid(record.raw);
    if (pid === undefined) {
      state = "unknown";
    } else {
      const liveness = isProcessAlive(pid);
      if (liveness === "live") state = "live";
      else if (liveness === "unknown") state = "unknown";
    }
  }
  return { records, token, state };
}

async function stableSnapshot(
  indexPath: string,
  sourcePath: string,
): Promise<ArtifactSnapshot | undefined> {
  const first = await readSnapshot(indexPath, sourcePath);
  if (!first) return undefined;
  const second = await readSnapshot(indexPath, sourcePath);
  if (!second || first.token !== second.token)
    return {
      ...(second ?? first),
      state: "unknown",
      token: second?.token ?? first.token,
    };
  return second;
}

export const codeGraphOwnership: CodeGraphOwnershipInspector = {
  async inspect(indexPath, sourcePath) {
    const snapshot = await stableSnapshot(indexPath, sourcePath);
    if (!snapshot) return { state: "unknown" };
    return snapshot.state === "free"
      ? { state: "free", token: snapshot.token }
      : { state: snapshot.state };
  },

  async same(indexPath, sourcePath, token) {
    const snapshot = await stableSnapshot(indexPath, sourcePath);
    return Boolean(
      snapshot && snapshot.state === "free" && snapshot.token === token,
    );
  },
};

export const inspectCodeGraphOwnership = (
  indexPath: string,
  sourcePath: string,
): Promise<CodeGraphOwnershipSnapshot> =>
  codeGraphOwnership.inspect(indexPath, sourcePath);
