import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

const peerModuleUrl = new URL("../dist/lib/jsonrpc.js", import.meta.url).href;
const CHILD_DEADLINE_MS = 1_500;

// The parser runs in this separate process. The parent is the protocol peer and
// owns the deadline, so a parser spin cannot block the watchdog or the suite.
const childSource = String.raw`
  import { createReadStream, createWriteStream } from "node:fs";
  import { createInterface } from "node:readline";

  const { JsonRpcPeer } = await import(${JSON.stringify(peerModuleUrl)});
  const scenario = process.env.JSONRPC_SCENARIO;
  const controlInput = createReadStream(null, { fd: 3, autoClose: false });
  const controlOutput = createWriteStream(null, { fd: 3, autoClose: false });
  const control = createInterface({ input: controlInput });
  const peer = new JsonRpcPeer(process.stdin, process.stdout, {
    name: "isolated JSON-RPC test peer",
  });
  let abortController;
  let splitAcknowledged = false;
  let started = false;

  function report(message) {
    controlOutput.write(JSON.stringify(message) + "\n");
  }

  function errorInfo(error) {
    return {
      name: error?.name,
      code: error?.code ?? null,
      message: error?.message,
    };
  }

  function finish(message) {
    controlOutput.write(JSON.stringify(message) + "\n", () => process.exit(0));
  }

  process.stdin.on("data", (chunk) => {
    if (scenario === "split" && !splitAcknowledged) {
      splitAcknowledged = true;
      report({ type: "split-bytes-received", byteLength: chunk.length });
    }
  });

  async function run() {
    if (scenario === "normal") {
      const first = await peer.request("normal", { value: 7 });
      const second = await peer.request("normal-followup");
      finish({ type: "result", result: { first, second } });
      return;
    }

    if (scenario === "split") {
      const result = await peer.request("split");
      finish({ type: "result", result });
      return;
    }

    if (scenario === "notification") {
      const result = await peer.request("notification");
      finish({ type: "result", result });
      return;
    }

    if (scenario === "mixed") {
      const result = await peer.request("mixed");
      finish({ type: "result", result });
      return;
    }

    if (scenario === "timeout-late" || scenario === "abort-late") {
      abortController = new AbortController();
      let firstError;
      try {
        const options = scenario === "timeout-late"
          ? { timeoutMs: 35 }
          : { timeoutMs: 1_000, signal: abortController.signal };
        await peer.request(scenario, {}, options);
      } catch (error) {
        firstError = errorInfo(error);
      }
      const recovered = await peer.request("after-late", {}, { timeoutMs: 500 });
      finish({ type: "result", result: { firstError, recovered } });
      return;
    }

    throw new Error("unknown test scenario: " + scenario);
  }

  control.on("line", (line) => {
    const command = JSON.parse(line);
    if (command.command === "start" && !started) {
      started = true;
      void run().catch((error) => finish({ type: "error", error: errorInfo(error) }));
      return;
    }
    if (command.command === "abort") {
      abortController?.abort();
    }
  });

  report({ type: "ready" });
`;

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function responseLine(id, result) {
  return `${JSON.stringify(response(id, result))}\n`;
}

async function runScenario(scenario) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", childSource],
    {
      env: { ...process.env, JSONRPC_SCENARIO: scenario },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  const control = child.stdio[3];
  const serverInput = createInterface({ input: child.stdout });
  const controlInput = createInterface({ input: control });
  const requests = [];
  const cancellations = [];
  const lateResponses = [];
  let splitRemainder;
  let splitHandshake = false;
  let lateSent = false;
  let settled = false;
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const fail = (error) => {
    if (!settled) {
      settled = true;
      rejectResult(error);
    }
  };
  const succeed = (result) => {
    if (!settled) {
      settled = true;
      resolveResult(result);
    }
  };

  const sendControl = (message) => writeJsonLine(control, message);
  const sendResponse = (id, result) => {
    if (!child.stdin.destroyed)
      writeJsonLine(child.stdin, response(id, result));
  };

  const onControl = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(new Error(`invalid child control message: ${error.message}`));
      return;
    }
    if (message.type === "ready") {
      sendControl({ command: "start" });
      return;
    }
    if (message.type === "split-bytes-received") {
      splitHandshake = true;
      if (!splitRemainder) {
        fail(
          new Error("split response arrived before its first chunk was sent"),
        );
        return;
      }
      child.stdin.write(splitRemainder);
      splitRemainder = undefined;
      return;
    }
    if (message.type === "result") {
      succeed({
        child: message.result,
        requests,
        cancellations,
        lateResponses,
        splitHandshake,
      });
      return;
    }
    if (message.type === "error") {
      const error = new Error(
        message.error?.message || "isolated child failed",
      );
      error.name = message.error?.name || "Error";
      error.code = message.error?.code || undefined;
      fail(error);
    }
  };

  const onServerLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(new Error(`invalid child protocol message: ${error.message}`));
      return;
    }
    if (message.method === "notifications/cancelled") {
      cancellations.push(message.params);
      if (
        !lateSent &&
        (scenario === "timeout-late" || scenario === "abort-late")
      ) {
        lateSent = true;
        lateResponses.push(message.params.requestId);
        sendResponse(message.params.requestId, {
          kind: "late",
          requestId: message.params.requestId,
        });
      }
      return;
    }
    if (typeof message.id !== "number" || typeof message.method !== "string")
      return;

    requests.push(message);
    if (scenario === "abort-late" && requests.length === 1) {
      sendControl({ command: "abort" });
      return;
    }
    if (scenario === "timeout-late" || scenario === "abort-late") {
      if (message.method === "after-late") {
        sendResponse(message.id, {
          kind: "recovered",
          requestMethod: message.method,
          requestCount: requests.length,
        });
      }
      return;
    }
    if (scenario === "split" && requests.length === 1) {
      const output = responseLine(message.id, {
        kind: "split",
        requestMethod: message.method,
        requestCount: requests.length,
      });
      const midpoint = Math.floor(output.length / 2);
      splitRemainder = output.slice(midpoint);
      child.stdin.write(output.slice(0, midpoint));
      return;
    }
    if (scenario === "notification") {
      const notification = {
        jsonrpc: "2.0",
        method: "notifications/log",
        params: { message: "server notification" },
      };
      child.stdin.write(
        JSON.stringify(notification) +
          "\n" +
          responseLine(message.id, {
            kind: "notification-response",
            requestMethod: message.method,
            requestCount: requests.length,
          }),
      );
      return;
    }
    if (scenario === "mixed") {
      child.stdin.write(
        "\n" +
          "not-json\n" +
          "42\n" +
          responseLine(999, { kind: "unknown" }) +
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/log",
            params: { message: "ignored notification" },
          }) +
          "\n" +
          responseLine(message.id, {
            kind: "mixed",
            requestMethod: message.method,
            requestCount: requests.length,
          }),
      );
      return;
    }
    if (scenario === "normal") {
      sendResponse(message.id, {
        kind: "normal",
        requestMethod: message.method,
        requestCount: requests.length,
      });
    }
  };

  serverInput.on("line", onServerLine);
  controlInput.on("line", onControl);
  child.stderr.resume();
  child.on("error", fail);
  child.on("close", (code, signal) => {
    if (!settled) {
      fail(
        new Error(
          `isolated child exited before result (code=${code}, signal=${signal})`,
        ),
      );
    }
  });

  const deadline = setTimeout(() => {
    const error = new Error(
      `${scenario} parser child exceeded external deadline`,
    );
    error.code = "ETIMEDOUT";
    fail(error);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, CHILD_DEADLINE_MS);

  try {
    return await resultPromise;
  } finally {
    clearTimeout(deadline);
    serverInput.close();
    controlInput.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "close");
  }
}

test("completes normal requests and keeps independent server counts", async () => {
  const { child, requests } = await runScenario("normal");

  assert.deepEqual(child.first, {
    kind: "normal",
    requestMethod: "normal",
    requestCount: 1,
  });
  assert.deepEqual(child.second, {
    kind: "normal",
    requestMethod: "normal-followup",
    requestCount: 2,
  });
  assert.deepEqual(
    requests.map(({ id, method }) => ({ id, method })),
    [
      { id: 1, method: "normal" },
      { id: 2, method: "normal-followup" },
    ],
  );
});

test("completes a response split across two handshake-driven byte writes", async () => {
  const { child, requests, splitHandshake } = await runScenario("split");

  assert.equal(splitHandshake, true);
  assert.deepEqual(child, {
    kind: "split",
    requestMethod: "split",
    requestCount: 1,
  });
  assert.equal(requests.length, 1);
});

test("ignores a valid notification before its response", async () => {
  const { child, requests } = await runScenario("notification");

  assert.deepEqual(child, {
    kind: "notification-response",
    requestMethod: "notification",
    requestCount: 1,
  });
  assert.equal(requests.length, 1);
});

test("makes progress through blank, malformed, primitive, unknown, and notification lines", async () => {
  const { child, requests } = await runScenario("mixed");

  assert.deepEqual(child, {
    kind: "mixed",
    requestMethod: "mixed",
    requestCount: 1,
  });
  assert.equal(requests.length, 1);
});

for (const [scenario, reason, errorCheck] of [
  ["timeout-late", "timeout", (error) => assert.equal(error.code, "ETIMEDOUT")],
  ["abort-late", "aborted", (error) => assert.equal(error.name, "AbortError")],
]) {
  test(`${scenario} ignores the late response and recovers on the same peer`, async () => {
    const { child, requests, cancellations, lateResponses } =
      await runScenario(scenario);

    errorCheck(child.firstError);
    assert.deepEqual(child.recovered, {
      kind: "recovered",
      requestMethod: "after-late",
      requestCount: 2,
    });
    assert.deepEqual(cancellations, [{ requestId: 1, reason }]);
    assert.deepEqual(lateResponses, [1]);
    assert.deepEqual(
      requests.map(({ id, method }) => ({ id, method })),
      [
        { id: 1, method: scenario },
        { id: 2, method: "after-late" },
      ],
    );
  });
}
