#!/usr/bin/env node
import {
  annotateFilesResult,
  normalizeFilesPath,
  ProjectGuard,
  publicSettings,
  sanitizeDiagnostic,
  truncateText,
  WorkspaceManager,
} from "../lib/codegraph.js";
import { loadSettings } from "../lib/config.js";
import { codegraphToolNames, codegraphTools } from "../lib/tool-metadata.js";
import type { JsonRpcMessage, ToolResult } from "../lib/types.js";
import { CodeGraphWorkerPool } from "../lib/worker-pool.js";

const settings = await loadSettings();
const baseRoot = process.env.PI_CODEGRAPH_BASE_ROOT || process.cwd();
const guard = await ProjectGuard.create(baseRoot, settings);
const manager = new WorkspaceManager(settings);
const pool = new CodeGraphWorkerPool(settings);
const controllers = new Map<number | string | null, AbortController>();
let buffer = "";
let gcTimer: NodeJS.Timeout | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function write(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id: JsonRpcMessage["id"], result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function errorResponse(
  id: JsonRpcMessage["id"],
  error: unknown,
  code = -32603,
): void {
  write({
    jsonrpc: "2.0",
    id,
    error: { code, message: sanitizeDiagnostic(errorMessage(error)) },
  });
}

async function resolveIdentity(params: Record<string, unknown> = {}) {
  return guard.resolve(
    typeof params.projectPath === "string" ? params.projectPath : baseRoot,
  );
}

function extractText(result: ToolResult): string {
  return (
    (result?.content || [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") || JSON.stringify(result)
  );
}

async function callTool(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const name = params?.name;
  if (typeof name !== "string" || !codegraphToolNames.includes(name))
    throw new Error(`Unknown CodeGraph tool: ${name}`);
  const supplied = isRecord(params.arguments) ? { ...params.arguments } : {};
  const identity = await resolveIdentity(supplied);
  await manager.prepare(identity, { signal });
  supplied.projectPath = identity.sourcePath;
  const originalFilesPath =
    name === "codegraph_files" && typeof supplied.path === "string"
      ? supplied.path
      : undefined;
  if (name === "codegraph_files") {
    const normalized = normalizeFilesPath(
      originalFilesPath,
      identity.sourcePath,
    );
    if (normalized === undefined) delete supplied.path;
    else supplied.path = normalized;
  }
  const result = await pool.call(identity.sourcePath, name, supplied, signal);
  if (result?.isError) return result;
  let text = extractText(result);
  if (name === "codegraph_files")
    text = annotateFilesResult(text, originalFilesPath);
  const limited = truncateText(text, settings.maxOutputChars);
  return {
    ...result,
    content: [{ type: "text", text: limited.text }],
    _meta: { projectPath: identity.sourcePath, truncated: limited.truncated },
  };
}

async function handleRequest(
  message: JsonRpcMessage,
  signal: AbortSignal,
): Promise<unknown> {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pi-codegraph", version: "0.2.0" },
      };
    case "tools/list":
      return {
        tools: codegraphTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    case "tools/call":
      return callTool(message.params ?? {}, signal);
    case "codegraph/workspace/prepare": {
      const identity = await resolveIdentity(message.params ?? {});
      const result = await manager.prepare(identity, { signal });
      await manager.gc(pool.activeProjects());
      return result;
    }
    case "codegraph/workspace/status": {
      const identity = await resolveIdentity(message.params ?? {});
      return manager.status(identity);
    }
    case "codegraph/workspace/sync": {
      const identity = await resolveIdentity(message.params ?? {});
      return manager.prepare(identity, { signal, forceSync: true });
    }
    case "codegraph/workspace/doctor": {
      const identity = await resolveIdentity(message.params ?? {});
      return manager.doctor(identity);
    }
    case "codegraph/workspace/gc":
      return manager.gc(pool.activeProjects(), Boolean(message.params?.force));
    case "codegraph/settings":
      return publicSettings(settings);
    case "shutdown":
      return null;
    default:
      throw Object.assign(new Error(`Method not found: ${message.method}`), {
        rpcCode: -32601,
      });
  }
}

async function receive(message: JsonRpcMessage): Promise<void> {
  if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId;
    if (
      typeof requestId === "number" ||
      typeof requestId === "string" ||
      requestId === null
    ) {
      controllers.get(requestId)?.abort();
    }
    return;
  }
  if (message.id === undefined) return;
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try {
    response(message.id, await handleRequest(message, controller.signal));
  } catch (error) {
    if (message.method === "tools/call") {
      response(message.id, {
        content: [
          { type: "text", text: sanitizeDiagnostic(errorMessage(error)) },
        ],
        isError: true,
      });
    } else {
      const rpcCode =
        error instanceof Error &&
        "rpcCode" in error &&
        typeof error.rpcCode === "number"
          ? error.rpcCode
          : undefined;
      errorResponse(message.id, error, rpcCode);
    }
  } finally {
    controllers.delete(message.id);
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void receive(JSON.parse(line));
    } catch {
      errorResponse(null, new Error("Invalid JSON"), -32700);
    }
    newline = buffer.indexOf("\n");
  }
});

async function shutdown() {
  if (gcTimer) clearInterval(gcTimer);
  for (const controller of controllers.values()) controller.abort();
  await pool.close();
}

if (settings.autoGc) {
  gcTimer = setInterval(() => {
    void manager.gc(pool.activeProjects());
  }, 60 * 60_000);
  gcTimer.unref?.();
}
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.stdin.on("end", () => {
  void shutdown().finally(() => process.exit(0));
});
