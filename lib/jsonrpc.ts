import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage, JsonRpcRequestOptions } from "./types.js";

interface PendingRequest {
  finish: (error?: Error, value?: unknown) => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class JsonRpcPeer {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly name: string;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private closed = false;

  constructor(
    readable: Readable,
    writable: Writable,
    options: { name?: string } = {},
  ) {
    this.readable = readable;
    this.writable = writable;
    this.name = options.name || "JSON-RPC peer";
    readable.on("data", (chunk) => this.#onData(chunk));
    readable.on("error", (error) => this.close(error));
    readable.on("end", () => this.close(new Error(`${this.name} closed`)));
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    options: JsonRpcRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.name} is closed`));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs || 30_000;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        error ? reject(error) : resolve(value);
      };
      const onAbort = () => {
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "aborted",
        });
        const error = new Error(`${method} aborted`);
        error.name = "AbortError";
        finish(error);
      };
      timer = setTimeout(() => {
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "timeout",
        });
        const error = new Error(`${method} timed out after ${timeoutMs}ms`);
        (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
        finish(error);
      }, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { finish });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  close(error = new Error(`${this.name} closed`)): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.finish(error);
    this.pending.clear();
  }

  #write(message: JsonRpcMessage): void {
    try {
      this.writable.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.close(toError(error));
    }
  }

  #onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) continue;
        message = parsed as unknown as JsonRpcMessage;
      } catch {
        continue;
      }
      if (
        typeof message.id !== "number" ||
        (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))
      )
        continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      if (message.error) {
        const error = new Error(
          message.error.message || JSON.stringify(message.error),
        );
        (error as Error & { code?: number | string }).code = message.error.code;
        pending.finish(error);
      } else {
        pending.finish(undefined, message.result);
      }
      newline = this.buffer.indexOf("\n");
    }
  }
}
