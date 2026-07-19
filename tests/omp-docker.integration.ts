import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

interface ToolExecutionResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface LoadedMcpTool {
  tool: {
    mcpToolName?: string;
    execute(
      toolCallId: string,
      params: unknown,
      onUpdate: undefined,
      context: { cwd: string },
      signal?: AbortSignal,
    ): Promise<ToolExecutionResult>;
  };
}

interface McpConnection {
  config: { command?: string; cwd?: string };
  transport: {
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  };
}

interface McpManager {
  getConnection(name: string): McpConnection | undefined;
  disconnectAll(): Promise<void>;
}

interface McpLoadResult {
  manager: McpManager;
  tools: LoadedMcpTool[];
  errors: Array<{ path: string; error: string }>;
  connectedServers: string[];
}

const expectedTools = [
  "codegraph_search",
  "codegraph_node",
  "codegraph_files",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_explore",
  "codegraph_status",
] as const;

const execFileAsync = promisify(execFile);
const fixturePath = "/tmp/pi-codegraph-omp-fixture";
const ompBin = process.env.OMP_BIN || "omp";

async function createFixture(): Promise<void> {
  await rm(fixturePath, { recursive: true, force: true });
  await mkdir(path.join(fixturePath, "src"), { recursive: true });
  await writeFile(
    path.join(fixturePath, "src", "math.ts"),
    [
      "export function addNumbers(left: number, right: number): number {",
      "  return left + right;",
      "}",
      "",
      "export function calculateTotal(values: number[]): number {",
      "  return values.reduce((total, value) => addNumbers(total, value), 0);",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixturePath, "src", "report.ts"),
    [
      'import { calculateTotal } from "./math.js";',
      "",
      "export function reportTotal(values: number[]): string {",
      '  return "Total: " + calculateTotal(values);',
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixturePath, "package.json"),
    '{"name":"codegraph-integration-fixture","type":"module"}\n',
  );
  await execFileAsync("git", ["init", "--initial-branch=main", fixturePath]);
  await execFileAsync("git", ["-C", fixturePath, "config", "user.name", "CI"]);
  await execFileAsync("git", [
    "-C",
    fixturePath,
    "config",
    "user.email",
    "ci@example.invalid",
  ]);
  await execFileAsync("git", ["-C", fixturePath, "add", "."]);
  await execFileAsync("git", ["-C", fixturePath, "commit", "-m", "fixture"]);
}

function textOf(result: ToolExecutionResult): string {
  return (result.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

async function main(): Promise<void> {
  await createFixture();
  process.chdir(fixturePath);

  const { stdout: ompVersion } = await execFileAsync(ompBin, ["--version"]);
  assert.match(ompVersion, /17\.0\.5/);

  const discoveryModule = "@oh-my-pi/pi-coding-agent/discovery";
  const mcpModule = "@oh-my-pi/pi-coding-agent/mcp";
  await import(discoveryModule);
  const { discoverAndLoadMCPTools } = (await import(mcpModule)) as {
    discoverAndLoadMCPTools(
      cwd: string,
      options: { cacheStorage: null; filterExa: false },
    ): Promise<McpLoadResult>;
  };

  const loaded = await discoverAndLoadMCPTools(fixturePath, {
    cacheStorage: null,
    filterExa: false,
  });
  try {
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.connectedServers.includes("codegraph"));

    const connection = loaded.manager.getConnection("codegraph");
    assert.ok(connection, "OMP did not retain the CodeGraph MCP connection");
    assert.equal(connection.config.cwd, undefined);
    assert.ok(path.isAbsolute(connection.config.command || ""));
    assert.match(
      connection.config.command || "",
      /dist[/\\]bin[/\\]codegraph-mcp\.js$/,
    );
    await access(connection.config.command || "", constants.X_OK);

    const initialStatus = await connection.transport.request<{
      state: string;
    }>("codegraph/workspace/status", { projectPath: fixturePath });
    assert.equal(initialStatus.state, "missing");

    const prepared = await connection.transport.request<{ state: string }>(
      "codegraph/workspace/prepare",
      { projectPath: fixturePath },
    );
    assert.equal(prepared.state, "ready");

    const tools = new Map(
      loaded.tools.map((entry) => [entry.tool.mcpToolName, entry.tool]),
    );
    assert.deepEqual([...tools.keys()].sort(), [...expectedTools].sort());

    const cases: Array<{
      name: (typeof expectedTools)[number];
      args: Record<string, unknown>;
      includes: string;
    }> = [
      {
        name: "codegraph_search",
        args: { query: "addNumbers" },
        includes: "addNumbers",
      },
      {
        name: "codegraph_node",
        args: { symbol: "calculateTotal", includeCode: true },
        includes: "calculateTotal",
      },
      {
        name: "codegraph_files",
        args: { path: "src", format: "flat" },
        includes: "math.ts",
      },
      {
        name: "codegraph_callers",
        args: { symbol: "addNumbers" },
        includes: "calculateTotal",
      },
      {
        name: "codegraph_callees",
        args: { symbol: "calculateTotal" },
        includes: "addNumbers",
      },
      {
        name: "codegraph_impact",
        args: { symbol: "addNumbers", depth: 2 },
        includes: "calculateTotal",
      },
      {
        name: "codegraph_explore",
        args: { query: "calculateTotal addNumbers" },
        includes: "calculateTotal",
      },
      {
        name: "codegraph_status",
        args: {},
        includes: "Files indexed",
      },
    ];

    for (const testCase of cases) {
      const tool = tools.get(testCase.name);
      assert.ok(tool, `OMP did not expose ${testCase.name}`);
      const result = await tool.execute(
        `integration-${testCase.name}`,
        { ...testCase.args, projectPath: fixturePath },
        undefined,
        { cwd: fixturePath },
      );
      assert.equal(
        result.isError,
        undefined,
        `${testCase.name} failed: ${textOf(result)}`,
      );
      assert.match(textOf(result), new RegExp(testCase.includes, "i"));
    }

    const synchronized = await connection.transport.request<{ state: string }>(
      "codegraph/workspace/sync",
      { projectPath: fixturePath },
    );
    assert.equal(synchronized.state, "ready");

    const status = await connection.transport.request<{
      state: string;
      identityMatches: boolean;
    }>("codegraph/workspace/status", { projectPath: fixturePath });
    assert.equal(status.state, "ready");
    assert.equal(status.identityMatches, true);

    const doctor = await connection.transport.request<{
      executable: string;
      workspace: { state: string };
    }>("codegraph/workspace/doctor", { projectPath: fixturePath });
    assert.ok(doctor.executable);
    assert.equal(doctor.workspace.state, "ready");

    const settings = await connection.transport.request<{
      indexStore: string;
      codegraphExecutable: string;
    }>("codegraph/settings");
    assert.ok(path.isAbsolute(settings.indexStore));
    assert.ok(settings.codegraphExecutable);

    const garbageCollection = await connection.transport.request<{
      removed: string[];
    }>("codegraph/workspace/gc", { force: true });
    assert.ok(Array.isArray(garbageCollection.removed));

    process.stdout.write(
      `OMP ${ompVersion.trim()}: ${expectedTools.length} CodeGraph tools and 6 lifecycle RPCs passed.\n`,
    );
  } finally {
    await loaded.manager.disconnectAll();
  }
}

await main();
