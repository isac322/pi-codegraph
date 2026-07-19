import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFile as execFileCallback,
  fork,
} from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);

interface ClientMessage {
  type: "ready" | "closed" | "error";
  text?: string;
  error?: string;
}

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

async function clientMain(projectPath: string, symbol: string): Promise<void> {
  try {
    process.chdir(projectPath);
    await import("@oh-my-pi/pi-coding-agent/discovery");
    const { discoverAndLoadMCPTools } = await import(
      "@oh-my-pi/pi-coding-agent/mcp"
    );
    const loaded = await discoverAndLoadMCPTools(projectPath, {
      cacheStorage: null,
      enableProjectConfig: true,
      filterExa: false,
    });
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.connectedServers.includes("codegraph"));

    const search = loaded.tools.find(({ tool }) =>
      tool.name.endsWith("codegraph_search"),
    );
    assert.ok(search, "OMP did not expose codegraph_search");
    const result = await search.tool.execute(
      `search-${symbol}`,
      { query: symbol },
      undefined,
      { cwd: projectPath } as never,
    );
    assert.notEqual(result.isError, true);
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert.match(text, new RegExp(symbol));

    process.send?.({ type: "ready", text } satisfies ClientMessage);
    process.on("message", async (message) => {
      if (message !== "close") {
        return;
      }
      await loaded.manager.disconnectAll();
      process.send?.({ type: "closed" } satisfies ClientMessage);
      process.disconnect?.();
    });
  } catch (error) {
    process.send?.({
      type: "error",
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    } satisfies ClientMessage);
    process.disconnect?.();
    process.exitCode = 1;
  }
}

function waitForMessage(
  child: ChildProcess,
  expected: ClientMessage["type"],
  timeoutMs = 30_000,
): Promise<ClientMessage> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child message: ${expected}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `OMP client exited before ${expected} (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    };
    const onMessage = (raw: unknown) => {
      const message = raw as ClientMessage;
      if (message.type === "error") {
        cleanup();
        reject(new Error(message.error ?? "OMP client failed"));
        return;
      }
      if (message.type !== expected) {
        return;
      }
      cleanup();
      resolveMessage(message);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
  });
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for daemon state change");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function extractPid(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === "pid") {
        const pid = extractPid(child);
        if (pid) {
          return pid;
        }
      }
    }
  }
  return undefined;
}

async function readDaemonPid(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return Number.parseInt(raw, 10);
    }
  })();
  const pid = extractPid(parsed);
  assert.ok(pid, `No PID found in ${path}`);
  return pid;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-codegraph-daemon-"));
  const mainWorktree = join(temporaryRoot, "main");
  const secondaryWorktree = join(temporaryRoot, "secondary");
  const indexStore = join(temporaryRoot, "indexes");
  const daemonPidPath = join(indexStore, "daemon", ".codegraph", "daemon.pid");
  const serverPath = join(packageRoot, "dist", "bin", "codegraph-mcp.js");
  const mcpConfig = {
    mcpServers: {
      codegraph: {
        command: serverPath,
      },
    },
  };

  await mkdir(join(mainWorktree, "src"), { recursive: true });
  await runGit(mainWorktree, "init", "-b", "main");
  await runGit(
    mainWorktree,
    "config",
    "user.email",
    "integration@example.invalid",
  );
  await runGit(mainWorktree, "config", "user.name", "Integration Test");
  await writeFile(
    join(mainWorktree, "src", "service.ts"),
    "export function baseSymbol() {}\n",
  );
  await writeFile(
    join(mainWorktree, ".mcp.json"),
    JSON.stringify(mcpConfig, null, 2),
  );
  await runGit(mainWorktree, "add", ".");
  await runGit(mainWorktree, "commit", "-m", "initial fixture");
  await runGit(mainWorktree, "branch", "secondary");
  await runGit(mainWorktree, "worktree", "add", secondaryWorktree, "secondary");

  await writeFile(
    join(mainWorktree, "src", "service.ts"),
    "export function MainWorktreeSymbol() { return 'main'; }\n",
  );
  await runGit(mainWorktree, "add", "src/service.ts");
  await runGit(mainWorktree, "commit", "-m", "main implementation");
  await writeFile(
    join(secondaryWorktree, "src", "service.ts"),
    "export function SecondaryWorktreeSymbol() { return 'secondary'; }\n",
  );
  await runGit(secondaryWorktree, "add", "src/service.ts");
  await runGit(secondaryWorktree, "commit", "-m", "secondary implementation");

  const env = {
    ...process.env,
    CODEGRAPH_PPID_POLL_MS: "100",
    PI_CODEGRAPH_INDEX_STORE: indexStore,
    PI_CODEGRAPH_WORKER_IDLE_MS: "1000",
  };
  const spawnClient = (cwd: string, symbol: string) =>
    fork(scriptPath, ["--client", cwd, symbol], {
      cwd,
      env,
      execArgv: "bun" in process.versions ? [] : ["--import", "tsx"],
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
  const mainClient = spawnClient(mainWorktree, "MainWorktreeSymbol");
  const secondaryClient = spawnClient(
    secondaryWorktree,
    "SecondaryWorktreeSymbol",
  );

  try {
    await Promise.all([
      waitForMessage(mainClient, "ready"),
      waitForMessage(secondaryClient, "ready"),
    ]);
    await waitUntil(() => exists(daemonPidPath));
    const daemonPid = await readDaemonPid(daemonPidPath);
    assert.ok(
      processExists(daemonPid),
      "shared CodeGraph daemon is not running",
    );
    assert.equal(
      await exists(join(mainWorktree, ".codegraph", "daemon.pid")),
      false,
      "main worktree started its own daemon",
    );
    assert.equal(
      await exists(join(secondaryWorktree, ".codegraph", "daemon.pid")),
      false,
      "secondary worktree started its own daemon",
    );

    mainClient.send("close");
    await waitForMessage(mainClient, "closed");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.ok(
      processExists(daemonPid),
      "daemon exited while another OMP client was attached",
    );
    assert.equal(await readDaemonPid(daemonPidPath), daemonPid);

    secondaryClient.send("close");
    await waitForMessage(secondaryClient, "closed");
    await waitUntil(
      async () => !processExists(daemonPid) && !(await exists(daemonPidPath)),
    );
    console.log(
      "shared daemon integration passed: one daemon, two OMP worktrees, clean shutdown",
    );
  } finally {
    for (const child of [mainClient, secondaryClient]) {
      if (child.connected) {
        child.send("close");
      }
    }
  }
}

if (process.argv[2] === "--client") {
  const projectPath = process.argv[3];
  const symbol = process.argv[4];
  assert.ok(projectPath && symbol);
  await clientMain(projectPath, symbol);
} else {
  await main();
}
