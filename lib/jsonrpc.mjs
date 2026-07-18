export class JsonRpcPeer {
  constructor(readable, writable, options = {}) {
    this.readable = readable;
    this.writable = writable;
    this.name = options.name || "JSON-RPC peer";
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    readable.on("data", (chunk) => this.#onData(chunk));
    readable.on("error", (error) => this.close(error));
    readable.on("end", () => this.close(new Error(`${this.name} closed`)));
  }

  request(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new Error(`${this.name} is closed`));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs || 30_000;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        error ? reject(error) : resolve(value);
      };
      const onAbort = () => {
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
        const error = new Error(`${method} aborted`);
        error.name = "AbortError";
        finish(error);
      };
      timer = setTimeout(() => {
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        const error = new Error(`${method} timed out after ${timeoutMs}ms`);
        error.code = "ETIMEDOUT";
        finish(error);
      }, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { finish });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  close(error = new Error(`${this.name} closed`)) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.finish(error);
    this.pending.clear();
  }

  #write(message) {
    try {
      this.writable.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.close(error);
    }
  }

  #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      if (message.error) {
        const error = new Error(message.error.message || JSON.stringify(message.error));
        error.code = message.error.code;
        pending.finish(error);
      } else {
        pending.finish(undefined, message.result);
      }
    }
  }
}
