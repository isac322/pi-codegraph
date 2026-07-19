import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  CodeGraphSettings,
  WorkspaceIdentity,
  WorkspaceStatus,
} from "./types.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const metadataName = ".pi-codegraph.json";
const emptyFilesMarker = "No files found matching the criteria.";
const ansiEscapePattern = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-9;]*m`,
  "g",
);

interface CodeGraphRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  forceSync?: boolean;
}

interface CodeGraphRunResult {
  stdout: string;
  stderr: string;
}

interface CodeGraphPackageManifest {
  name?: string;
  bin?: string | { codegraph?: string };
}

interface CodeGraphPackageJson {
  path: string;
  parsed: CodeGraphPackageManifest;
}

interface IndexMetadata {
  schemaVersion?: number;
  sourcePath?: string;
  repoIdentity?: string;
  worktreeIdentity?: string;
  managed?: boolean;
  lastPreparedAt?: string;
  lastSyncAt?: string | number | null;
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

export function sanitizeDiagnostic(value: unknown, maxLength = 2_000): string {
  const clean = String(value || "")
    .replace(ansiEscapePattern, "")
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|AUTH)[A-Z0-9_]*=)\S+/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /--(?:token|secret|password|api-key|apikey|otp)(?:=|\s+)\S+/gi,
      "--[redacted]",
    );
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

export function truncateText(value: unknown, maxChars: number) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = "\n\n[pi-codegraph output truncated]\n\n";
  const headLength = Math.floor((maxChars - marker.length) * 0.75);
  const tailLength = Math.max(0, maxChars - marker.length - headLength);
  return {
    text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
    truncated: true,
  };
}

export function normalizeFilesPath(
  inputPath: unknown,
  projectCwd?: string,
): string | undefined {
  if (typeof inputPath !== "string" || !inputPath.trim()) return undefined;
  let expanded = inputPath.trim();
  if (expanded === "~" || expanded.startsWith("~/"))
    expanded = join(os.homedir(), expanded.slice(1));
  if (projectCwd && isAbsolute(expanded)) {
    const rel = relative(projectCwd, expanded);
    if (!rel) return undefined;
    if (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
      return rel.split(sep).join("/");
  }
  return expanded.split(sep).join("/");
}

export function annotateFilesResult(
  text: string,
  originalPath?: string,
): string {
  if (!originalPath || !String(text).includes(emptyFilesMarker)) return text;
  return `${text}\n\nHint: codegraph_files expects a repo-relative POSIX prefix such as "src/components". The path "${originalPath}" did not match the index.`;
}

async function existingDirectory(input: string): Promise<string> {
  const resolved = await realpath(resolve(input));
  const info = await stat(resolved);
  if (!info.isDirectory())
    throw new Error(`Project path is not a directory: ${input}`);
  return resolved;
}

async function gitValue(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function gitIdentity(input: string): Promise<WorkspaceIdentity> {
  const sourcePath = await existingDirectory(input);
  const top = await gitValue(sourcePath, ["rev-parse", "--show-toplevel"]);
  if (!top) {
    const info = await stat(sourcePath);
    return {
      sourcePath,
      repoRoot: sourcePath,
      repoIdentity: `directory:${sourcePath}:${info.dev}:${info.ino}:${info.birthtimeMs}`,
      worktreeIdentity: `directory:${sourcePath}:${info.dev}:${info.ino}`,
      gitCommonDir: "",
    };
  }
  const repoRoot = await realpath(top);
  const commonRaw = await gitValue(repoRoot, ["rev-parse", "--git-common-dir"]);
  const gitDirRaw = await gitValue(repoRoot, ["rev-parse", "--git-dir"]);
  const common = await realpath(
    isAbsolute(commonRaw) ? commonRaw : resolve(repoRoot, commonRaw),
  );
  const gitDir = await realpath(
    isAbsolute(gitDirRaw) ? gitDirRaw : resolve(repoRoot, gitDirRaw),
  );
  const [rootCommits, remote, commonInfo, gitDirInfo, sourceInfo] =
    await Promise.all([
      gitValue(repoRoot, ["rev-list", "--max-parents=0", "HEAD"]),
      gitValue(repoRoot, ["config", "--get", "remote.origin.url"]),
      stat(common),
      stat(gitDir),
      stat(repoRoot),
    ]);
  const repoIdentity = createHash("sha256")
    .update(
      [
        common,
        rootCommits,
        remote,
        commonInfo.dev,
        commonInfo.ino,
        commonInfo.birthtimeMs,
      ].join("\0"),
    )
    .digest("hex");
  const worktreeIdentity = createHash("sha256")
    .update(
      [
        gitDir,
        gitDirInfo.dev,
        gitDirInfo.ino,
        repoRoot,
        sourceInfo.dev,
        sourceInfo.ino,
      ].join("\0"),
    )
    .digest("hex");
  return {
    sourcePath: repoRoot,
    repoRoot,
    repoIdentity,
    worktreeIdentity,
    gitCommonDir: common,
  };
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

export class ProjectGuard {
  readonly base: WorkspaceIdentity;
  readonly allowedRoots: string[];

  static async create(baseRoot: string, settings: CodeGraphSettings) {
    if (process.env.PI_CODEGRAPH_TRUSTED === "0")
      throw new Error("CodeGraph is disabled for an untrusted project.");
    const base = await gitIdentity(baseRoot);
    const allowedRoots: string[] = [];
    for (const root of [base.sourcePath, ...settings.allowedProjectRoots]) {
      try {
        allowedRoots.push(await existingDirectory(root));
      } catch {
        // Ignore unavailable optional roots.
      }
    }
    return new ProjectGuard(base, allowedRoots);
  }

  constructor(base: WorkspaceIdentity, allowedRoots: string[]) {
    this.base = base;
    this.allowedRoots = allowedRoots;
  }

  async resolve(requestedPath?: string): Promise<WorkspaceIdentity> {
    if (requestedPath && !isAbsolute(requestedPath))
      throw new Error("CodeGraph projectPath must be absolute.");
    const identity = await gitIdentity(requestedPath || this.base.sourcePath);
    if (this.allowedRoots.some((root) => isWithin(identity.sourcePath, root)))
      return identity;
    if (
      this.base.gitCommonDir &&
      identity.gitCommonDir === this.base.gitCommonDir
    )
      return identity;
    throw new Error(
      `CodeGraph projectPath is outside the trusted workspace and registered worktrees: ${identity.sourcePath}`,
    );
  }
}

async function locatePackageJson(
  entry: string,
): Promise<CodeGraphPackageJson | undefined> {
  let current = dirname(entry);
  for (;;) {
    const candidate = join(current, "package.json");
    try {
      const parsed = JSON.parse(
        await readFile(candidate, "utf8"),
      ) as CodeGraphPackageManifest;
      if (parsed.name === "@colbymchenry/codegraph")
        return { path: candidate, parsed };
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveCodeGraphLaunch(
  settings: CodeGraphSettings,
  args: string[] = [],
): Promise<{ command: string; args: string[] }> {
  if (settings.codegraphExecutable)
    return { command: settings.codegraphExecutable, args };
  try {
    let packageJson: CodeGraphPackageJson | undefined;
    try {
      const packagePath = require.resolve(
        "@colbymchenry/codegraph/package.json",
      );
      packageJson = {
        path: packagePath,
        parsed: JSON.parse(
          await readFile(packagePath, "utf8"),
        ) as CodeGraphPackageManifest,
      };
    } catch {
      packageJson = await locatePackageJson(
        require.resolve("@colbymchenry/codegraph"),
      );
    }
    const binValue =
      typeof packageJson?.parsed?.bin === "string"
        ? packageJson.parsed.bin
        : packageJson?.parsed?.bin?.codegraph;
    if (binValue && packageJson)
      return {
        command: process.execPath,
        args: [resolve(dirname(packageJson.path), binValue), ...args],
      };
  } catch {
    // Fall through to a global executable.
  }
  return { command: "codegraph", args };
}

export async function runCodeGraph(
  settings: CodeGraphSettings,
  cwd: string,
  args: string[],
  options: CodeGraphRunOptions = {},
): Promise<CodeGraphRunResult> {
  const launch = await resolveCodeGraphLaunch(settings, args);
  return new Promise<CodeGraphRunResult>((resolvePromise, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error | null, value?: CodeGraphRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (value) resolvePromise(value);
    };
    const onAbort = () => {
      child.kill();
      const error = new Error(`codegraph ${args[0]} aborted`);
      error.name = "AbortError";
      finish(error);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (code === 0) finish(undefined, { stdout, stderr });
      else
        finish(
          new Error(
            sanitizeDiagnostic(stderr) ||
              `codegraph ${args[0]} exited with code ${code}`,
          ),
        );
    });
    const timeoutMs = options.timeoutMs || settings.requestTimeoutMs;
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(
        `codegraph ${args[0]} timed out after ${timeoutMs}ms`,
      );
      (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function exists(input: string): Promise<boolean> {
  try {
    await access(input);
    return true;
  } catch {
    return false;
  }
}

async function readMetadata(
  indexPath: string,
): Promise<IndexMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(join(indexPath, metadataName), "utf8"),
    ) as IndexMetadata;
  } catch {
    return undefined;
  }
}

async function readIndexedSourcePath(
  indexPath: string,
): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(indexPath, "source.json"), "utf8"),
    );
    const sourceDir =
      typeof parsed === "object" &&
      parsed !== null &&
      "sourceDir" in parsed &&
      typeof parsed.sourceDir === "string" &&
      "version" in parsed &&
      parsed.version === 1
        ? parsed.sourceDir
        : undefined;
    return sourceDir ? await existingDirectory(sourceDir) : undefined;
  } catch {
    return undefined;
  }
}

async function writeMetadata(
  indexPath: string,
  metadata: IndexMetadata,
): Promise<void> {
  const target = join(indexPath, metadataName);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, target);
}

async function acquireLock(
  lockPath: string,
  timeoutMs = 30_000,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > timeoutMs * 2)
          await rm(lockPath, { recursive: true, force: true });
      } catch {
        // Another owner released the lock.
      }
      if (Date.now() - started >= timeoutMs)
        throw new Error(
          `Timed out waiting for CodeGraph index lock: ${lockPath}`,
        );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

export class WorkspaceManager {
  readonly settings: CodeGraphSettings;
  readonly lastSync = new Map<string, number>();
  private lastGc = 0;

  constructor(settings: CodeGraphSettings) {
    this.settings = settings;
  }

  async prepare(
    identity: WorkspaceIdentity,
    options: CodeGraphRunOptions = {},
  ) {
    await existingDirectory(identity.sourcePath);
    const key = createHash("sha256")
      .update(
        `${identity.repoIdentity}\0${identity.worktreeIdentity}\0${identity.sourcePath}`,
      )
      .digest("hex");
    const managedIndex = join(this.settings.indexStore, "projects", key);
    const lockPath = join(this.settings.indexStore, "locks", `${key}.lock`);
    const release = await acquireLock(lockPath, this.settings.requestTimeoutMs);
    try {
      await existingDirectory(identity.sourcePath);
      const binding = await this.#bind(identity, managedIndex);
      const database = join(binding.indexPath, "codegraph.db");
      if (!(await exists(database)))
        await runCodeGraph(
          this.settings,
          identity.sourcePath,
          ["init", "-i"],
          options,
        );
      const lastSync = this.lastSync.get(identity.sourcePath) || 0;
      const shouldSync =
        (options.forceSync || this.settings.autoSync) &&
        (options.forceSync ||
          Date.now() - lastSync >= this.settings.syncMinIntervalMs);
      if (shouldSync) {
        await existingDirectory(identity.sourcePath);
        await runCodeGraph(
          this.settings,
          identity.sourcePath,
          ["sync"],
          options,
        );
        this.lastSync.set(identity.sourcePath, Date.now());
      }
      const metadata = {
        schemaVersion: 2,
        sourcePath: identity.sourcePath,
        repoIdentity: identity.repoIdentity,
        worktreeIdentity: identity.worktreeIdentity,
        managed: binding.managed,
        lastPreparedAt: new Date().toISOString(),
        lastSyncAt: this.lastSync.get(identity.sourcePath) || null,
      };
      await writeMetadata(binding.indexPath, metadata);
      return { ...metadata, indexPath: binding.indexPath, state: "ready" };
    } finally {
      await release();
    }
  }

  async #bind(
    identity: WorkspaceIdentity,
    managedIndex: string,
  ): Promise<{ indexPath: string; managed: boolean }> {
    const linkPath = join(identity.sourcePath, ".codegraph");
    await mkdir(managedIndex, { recursive: true });
    try {
      const info = await lstat(linkPath);
      if (info.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(linkPath);
        } catch {
          target = "";
        }
        if (target === managedIndex)
          return { indexPath: managedIndex, managed: true };
        const metadata = target ? await readMetadata(target) : undefined;
        if (metadata?.managed && metadata.sourcePath === identity.sourcePath) {
          await rm(linkPath, { force: true });
        } else if (
          target &&
          (await readIndexedSourcePath(target)) === identity.sourcePath
        ) {
          return { indexPath: target, managed: false };
        } else {
          throw new Error(
            `Refusing to replace an unmanaged .codegraph symlink at ${identity.sourcePath}`,
          );
        }
      } else if (info.isDirectory()) {
        const metadata = await readMetadata(linkPath);
        if (
          metadata &&
          (metadata.repoIdentity !== identity.repoIdentity ||
            metadata.worktreeIdentity !== identity.worktreeIdentity)
        ) {
          throw new Error(
            `Existing .codegraph belongs to a different repository identity: ${linkPath}`,
          );
        }
        return { indexPath: linkPath, managed: false };
      } else {
        throw new Error(
          `Expected .codegraph to be a directory or symlink: ${linkPath}`,
        );
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    await existingDirectory(identity.sourcePath);
    const temporary = `${linkPath}.pi-codegraph-${process.pid}`;
    await rm(temporary, { force: true });
    await symlink(managedIndex, temporary, "dir");
    try {
      await rename(temporary, linkPath);
    } catch (error) {
      await rm(temporary, { force: true });
      if (!hasErrorCode(error, "EEXIST", "ENOTEMPTY")) throw error;
    }
    return { indexPath: await realpath(linkPath), managed: true };
  }

  async status(identity: WorkspaceIdentity): Promise<WorkspaceStatus> {
    const linkPath = join(identity.sourcePath, ".codegraph");
    try {
      const indexPath = await realpath(linkPath);
      const metadata = await readMetadata(indexPath);
      return {
        state: (await exists(join(indexPath, "codegraph.db")))
          ? "ready"
          : "uninitialized",
        sourcePath: identity.sourcePath,
        indexPath,
        managed: metadata?.managed ?? false,
        lastSyncAt: metadata?.lastSyncAt || null,
        identityMatches:
          !metadata ||
          (metadata.repoIdentity === identity.repoIdentity &&
            metadata.worktreeIdentity === identity.worktreeIdentity),
      };
    } catch {
      return {
        state: "missing",
        sourcePath: identity.sourcePath,
        indexPath: null,
        managed: false,
        lastSyncAt: null,
        identityMatches: true,
      };
    }
  }

  async doctor(identity: WorkspaceIdentity) {
    const version = await runCodeGraph(this.settings, identity.sourcePath, [
      "--version",
    ]);
    return {
      executable: version.stdout.trim() || version.stderr.trim(),
      workspace: await this.status(identity),
      settings: publicSettings(this.settings),
    };
  }

  async gc(
    activeProjects: ReadonlySet<string> = new Set<string>(),
    force = false,
  ): Promise<{ removed: string[] }> {
    if (!this.settings.autoGc && !force) return { removed: [] };
    if (!force && Date.now() - this.lastGc < 60 * 60_000)
      return { removed: [] };
    this.lastGc = Date.now();
    const projectsRoot = join(this.settings.indexStore, "projects");
    let entries: Dirent[] = [];
    try {
      entries = await readdir(projectsRoot, { withFileTypes: true });
    } catch {
      return { removed: [] };
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const indexPath = join(projectsRoot, entry.name);
      const metadata = await readMetadata(indexPath);
      if (
        !metadata?.managed ||
        typeof metadata.sourcePath !== "string" ||
        activeProjects.has(metadata.sourcePath)
      )
        continue;
      let stale = !(await exists(metadata.sourcePath));
      if (!stale) {
        try {
          const identity = await gitIdentity(metadata.sourcePath);
          stale =
            identity.repoIdentity !== metadata.repoIdentity ||
            identity.worktreeIdentity !== metadata.worktreeIdentity;
        } catch {
          stale = true;
        }
      }
      if (stale) {
        await rm(indexPath, { recursive: true, force: true });
        removed.push(indexPath);
      }
    }
    return { removed };
  }
}

export async function workspaceSummary(cwd: string): Promise<WorkspaceStatus> {
  try {
    const identity = await gitIdentity(cwd);
    const linkPath = join(identity.sourcePath, ".codegraph");
    const indexPath = await realpath(linkPath);
    const metadata = await readMetadata(indexPath);
    return {
      state: (await exists(join(indexPath, "codegraph.db")))
        ? "ready"
        : "uninitialized",
      sourcePath: identity.sourcePath,
      indexPath,
      lastSyncAt: metadata?.lastSyncAt || null,
      identityMatches:
        !metadata ||
        (metadata.repoIdentity === identity.repoIdentity &&
          metadata.worktreeIdentity === identity.worktreeIdentity),
    };
  } catch {
    return {
      state: "missing",
      sourcePath: resolve(cwd),
      indexPath: null,
      lastSyncAt: null,
      identityMatches: true,
    };
  }
}

export function publicSettings(settings: CodeGraphSettings): Omit<
  CodeGraphSettings,
  "codegraphExecutable"
> & {
  codegraphExecutable: string;
} {
  return {
    autoSync: settings.autoSync,
    autoGc: settings.autoGc,
    indexStore: settings.indexStore,
    workerIdleTimeoutMs: settings.workerIdleTimeoutMs,
    maxWorkers: settings.maxWorkers,
    requestTimeoutMs: settings.requestTimeoutMs,
    syncMinIntervalMs: settings.syncMinIntervalMs,
    maxOutputChars: settings.maxOutputChars,
    allowedProjectRoots: settings.allowedProjectRoots,
    promptInjection: settings.promptInjection,
    codegraphExecutable: settings.codegraphExecutable || "auto",
    configFile: settings.configFile,
  };
}
