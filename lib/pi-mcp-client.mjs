import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JsonRpcPeer } from "./jsonrpc.mjs";
import { sanitizeDiagnostic } from "./codegraph.mjs";
import { settingsEnvironment } from "./config.mjs";

const serverPath = fileURLToPath(new URL("../bin/codegraph-mcp.mjs", import.meta.url));

export class PiCodeGraphClient {
  constructor(settings, baseRoot) {
    this.settings = settings;
    this.baseRoot = baseRoot;
    this.startPromise = undefined;
    this.child = undefined;
    this.peer = undefined;
  }

  async start() {
    if (this.peer) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  async #start() {
    const child = spawn(process.execPath, [serverPath], {
      cwd: this.baseRoot,
      env: { ...process.env, ...settingsEnvironment(this.settings, this.baseRoot, true) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
    const peer = new JsonRpcPeer(child.stdout, child.stdin, { name: "pi-codegraph MCP facade" });
    child.on("error", (error) => peer.close(error));
    child.on("exit", (code) => peer.close(new Error(sanitizeDiagnostic(stderr) || `pi-codegraph MCP facade exited with code ${code}`)));
    this.child = child;
    this.peer = peer;
    try {
      await peer.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-codegraph-pi", version: "0.2.0" },
      }, { timeoutMs: this.settings.requestTimeoutMs });
      peer.notify("initialized", {});
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async request(method, params = {}, signal) {
    await this.start();
    return this.peer.request(method, params, { signal, timeoutMs: this.settings.requestTimeoutMs });
  }

  async callTool(name, args, signal) {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  async close() {
    const peer = this.peer;
    const child = this.child;
    this.peer = undefined;
    this.child = undefined;
    peer?.close(new Error("Pi session closed"));
    if (child && !child.killed) child.kill();
  }
}
