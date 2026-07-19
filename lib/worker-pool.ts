import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveCodeGraphLaunch, sanitizeDiagnostic } from "./codegraph.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import type { CodeGraphSettings, ToolResult } from "./types.js";

interface WorkerEntry {
  projectPath: string;
  child: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  busy: number;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class CodeGraphWorkerPool {
  readonly settings: CodeGraphSettings;
  readonly entries = new Map<string, WorkerEntry>();
  readonly creating = new Map<string, Promise<WorkerEntry>>();
  private closed = false;

  constructor(settings: CodeGraphSettings) {
    this.settings = settings;
  }

  activeProjects(): Set<string> {
    return new Set(this.entries.keys());
  }

  async call(
    projectPath: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const entry = await this.#get(projectPath);
    entry.busy += 1;
    clearTimeout(entry.idleTimer);
    try {
      return (await entry.peer.request(
        "tools/call",
        { name: toolName, arguments: args },
        { signal, timeoutMs: this.settings.requestTimeoutMs },
      )) as ToolResult;
    } catch (error) {
      const normalized = toError(error);
      if (normalized.name === "AbortError" || hasErrorCode(error, "ETIMEDOUT"))
        await this.closeProject(projectPath, normalized);
      throw error;
    } finally {
      entry.busy -= 1;
      entry.lastUsed = Date.now();
      if (this.entries.get(projectPath) === entry) this.#scheduleIdle(entry);
    }
  }

  async #get(projectPath: string): Promise<WorkerEntry> {
    if (this.closed) throw new Error("CodeGraph worker pool is closed");
    const existing = this.entries.get(projectPath);
    if (existing) return existing;
    const pending = this.creating.get(projectPath);
    if (pending) return pending;
    const creation = this.#create(projectPath).finally(() =>
      this.creating.delete(projectPath),
    );
    this.creating.set(projectPath, creation);
    return creation;
  }

  async #create(projectPath: string): Promise<WorkerEntry> {
    await this.#evictForCapacity();
    const launch = await resolveCodeGraphLaunch(this.settings, [
      "serve",
      "--mcp",
      "--path",
      projectPath,
    ]);
    const child = spawn(launch.command, launch.args, {
      cwd: projectPath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    const peer = new JsonRpcPeer(child.stdout, child.stdin, {
      name: `CodeGraph worker (${projectPath})`,
    });
    const entry: WorkerEntry = {
      projectPath,
      child,
      peer,
      busy: 0,
      lastUsed: Date.now(),
      idleTimer: undefined,
    };
    const onExit = (code: number | null) => {
      const diagnostic =
        sanitizeDiagnostic(stderr) ||
        `CodeGraph worker exited with code ${code}`;
      peer.close(new Error(diagnostic));
      if (this.entries.get(projectPath) === entry)
        this.entries.delete(projectPath);
    };
    child.on("error", (error) => peer.close(error));
    child.on("exit", onExit);
    try {
      const rootUri = pathToFileURL(projectPath).href;
      await peer.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          rootUri,
          workspaceFolders: [
            {
              uri: rootUri,
              name: projectPath.split(/[\\/]/).at(-1) || projectPath,
            },
          ],
          capabilities: {},
          clientInfo: { name: "pi-codegraph", version: "0.2.0" },
        },
        { timeoutMs: this.settings.requestTimeoutMs },
      );
      peer.notify("initialized", {});
      this.entries.set(projectPath, entry);
      this.#scheduleIdle(entry);
      return entry;
    } catch (error) {
      child.kill();
      peer.close(toError(error));
      throw error;
    }
  }

  #scheduleIdle(entry: WorkerEntry): void {
    clearTimeout(entry.idleTimer);
    if (entry.busy > 0) return;
    entry.idleTimer = setTimeout(
      () => this.closeProject(entry.projectPath),
      this.settings.workerIdleTimeoutMs,
    );
    entry.idleTimer.unref?.();
  }

  async #evictForCapacity(): Promise<void> {
    if (this.entries.size < this.settings.maxWorkers) return;
    const idle = [...this.entries.values()]
      .filter((entry) => entry.busy === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    if (!idle.length)
      throw new Error(
        `CodeGraph worker limit reached (${this.settings.maxWorkers}); all workers are busy.`,
      );
    await this.closeProject(idle[0].projectPath);
  }

  async closeProject(
    projectPath: string,
    error: Error = new Error("CodeGraph worker closed"),
  ): Promise<void> {
    const entry = this.entries.get(projectPath);
    if (!entry) return;
    this.entries.delete(projectPath);
    clearTimeout(entry.idleTimer);
    entry.peer.close(error);
    if (!entry.child.killed) entry.child.kill();
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.entries.keys()].map((projectPath) =>
        this.closeProject(projectPath),
      ),
    );
  }
}
