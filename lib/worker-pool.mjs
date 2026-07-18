import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { JsonRpcPeer } from "./jsonrpc.mjs";
import { resolveCodeGraphLaunch, sanitizeDiagnostic } from "./codegraph.mjs";

export class CodeGraphWorkerPool {
  constructor(settings) {
    this.settings = settings;
    this.entries = new Map();
    this.creating = new Map();
    this.closed = false;
  }

  activeProjects() {
    return new Set(this.entries.keys());
  }

  async call(projectPath, toolName, args, signal) {
    const entry = await this.#get(projectPath);
    entry.busy += 1;
    clearTimeout(entry.idleTimer);
    try {
      return await entry.peer.request("tools/call", { name: toolName, arguments: args }, { signal, timeoutMs: this.settings.requestTimeoutMs });
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ETIMEDOUT") await this.closeProject(projectPath, error);
      throw error;
    } finally {
      entry.busy -= 1;
      entry.lastUsed = Date.now();
      if (this.entries.get(projectPath) === entry) this.#scheduleIdle(entry);
    }
  }

  async #get(projectPath) {
    if (this.closed) throw new Error("CodeGraph worker pool is closed");
    const existing = this.entries.get(projectPath);
    if (existing) return existing;
    const pending = this.creating.get(projectPath);
    if (pending) return pending;
    const creation = this.#create(projectPath).finally(() => this.creating.delete(projectPath));
    this.creating.set(projectPath, creation);
    return creation;
  }

  async #create(projectPath) {
    await this.#evictForCapacity();
    const launch = await resolveCodeGraphLaunch(this.settings, ["serve", "--mcp", "--path", projectPath]);
    const child = spawn(launch.command, launch.args, { cwd: projectPath, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
    const peer = new JsonRpcPeer(child.stdout, child.stdin, { name: `CodeGraph worker (${projectPath})` });
    const entry = { projectPath, child, peer, busy: 0, lastUsed: Date.now(), idleTimer: undefined };
    const onExit = (code) => {
      const diagnostic = sanitizeDiagnostic(stderr) || `CodeGraph worker exited with code ${code}`;
      peer.close(new Error(diagnostic));
      if (this.entries.get(projectPath) === entry) this.entries.delete(projectPath);
    };
    child.on("error", (error) => peer.close(error));
    child.on("exit", onExit);
    try {
      const rootUri = pathToFileURL(projectPath).href;
      await peer.request("initialize", {
        protocolVersion: "2024-11-05",
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: projectPath.split(/[\\/]/).at(-1) || projectPath }],
        capabilities: {},
        clientInfo: { name: "pi-codegraph", version: "0.2.0" },
      }, { timeoutMs: this.settings.requestTimeoutMs });
      peer.notify("initialized", {});
      this.entries.set(projectPath, entry);
      this.#scheduleIdle(entry);
      return entry;
    } catch (error) {
      child.kill();
      peer.close(error);
      throw error;
    }
  }

  #scheduleIdle(entry) {
    clearTimeout(entry.idleTimer);
    if (entry.busy > 0) return;
    entry.idleTimer = setTimeout(() => this.closeProject(entry.projectPath), this.settings.workerIdleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  async #evictForCapacity() {
    if (this.entries.size < this.settings.maxWorkers) return;
    const idle = [...this.entries.values()].filter((entry) => entry.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    if (!idle.length) throw new Error(`CodeGraph worker limit reached (${this.settings.maxWorkers}); all workers are busy.`);
    await this.closeProject(idle[0].projectPath);
  }

  async closeProject(projectPath, error = new Error("CodeGraph worker closed")) {
    const entry = this.entries.get(projectPath);
    if (!entry) return;
    this.entries.delete(projectPath);
    clearTimeout(entry.idleTimer);
    entry.peer.close(error);
    if (!entry.child.killed) entry.child.kill();
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((projectPath) => this.closeProject(projectPath)));
  }
}
