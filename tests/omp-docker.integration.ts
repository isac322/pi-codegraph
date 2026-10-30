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
    name: string;
    mcpServerName?: string;
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

interface McpToolDefinition {
  name: string;
  inputSchema: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
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
type BeforeAgentStartEvent = {
  systemPrompt?: string[];
  reason: "prompt" | "revive";
};

type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  context: { cwd: string },
) => Promise<{ systemPrompt: string[] } | undefined>;
type ToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
  context: { cwd: string },
) => Promise<{ input: Record<string, unknown> } | undefined>;
type OmpHandlers = {
  beforeAgentStart?: BeforeAgentStartHandler;
  toolCall?: ToolCallHandler;
};

const execFileAsync = promisify(execFile);
const fixturePath = "/tmp/pi-codegraph-omp-fixture";
const siblingFixturePath = "/tmp/pi-codegraph-omp-sibling";
const ompBin = process.env.OMP_BIN || "omp";

async function createFixture(): Promise<void> {
  await rm(fixturePath, { recursive: true, force: true });
  await rm(siblingFixturePath, { recursive: true, force: true });
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
    path.join(fixturePath, "src", "alternate.ts"),
    [
      "export function addNumbers(left: number, right: number): number {",
      "  return left * right;",
      "}",
      "",
      "export function calculateTotal(values: number[]): number {",
      "  return values.reduce((total, value) => addNumbers(total, value), 1);",
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
  await execFileAsync("git", [
    "-C",
    fixturePath,
    "worktree",
    "add",
    "-b",
    "sibling",
    siblingFixturePath,
  ]);
  await writeFile(
    path.join(siblingFixturePath, "src", "sibling.ts"),
    "export function SiblingWorktreeSymbol() { return 'sibling'; }\n",
  );
  await execFileAsync("git", ["-C", siblingFixturePath, "add", "."]);
  await execFileAsync("git", [
    "-C",
    siblingFixturePath,
    "commit",
    "-m",
    "sibling fixture",
  ]);
}

function textOf(result: ToolExecutionResult): string {
  return (result.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

async function registerOmpHandlers(): Promise<OmpHandlers> {
  const { default: register } = (await import("../dist/extensions/omp.js")) as {
    default: (omp: {
      on: (event: string, handler: (...args: never[]) => unknown) => void;
    }) => Promise<void>;
  };
  const handlers: OmpHandlers = {};
  await register({
    on(event, handler) {
      if (event === "before_agent_start") {
        handlers.beforeAgentStart = handler as BeforeAgentStartHandler;
      } else if (event === "tool_call") {
        handlers.toolCall = handler as ToolCallHandler;
      }
    },
  });
  return handlers;
}

async function testOmpPromptInjection(): Promise<void> {
  const handlers = await registerOmpHandlers();
  const callback = handlers.beforeAgentStart;
  assert.ok(callback, "OMP extension did not register before_agent_start");
  assert.ok(handlers.toolCall, "OMP extension did not register tool_call");
  const input = ["first\nsection,with punctuation", "second section"];
  const originalInput = [...input];
  const result = await callback(
    { systemPrompt: input, reason: "prompt" },
    { cwd: fixturePath },
  );
  assert.ok(result);
  assert.notEqual(result.systemPrompt, input);
  assert.deepEqual(result.systemPrompt.slice(0, input.length), input);
  assert.match(result.systemPrompt.at(-1) || "", /CodeGraph structural tools/);
  assert.deepEqual(input, originalInput);

  const emptyResult = await callback(
    { systemPrompt: [], reason: "prompt" },
    { cwd: fixturePath },
  );
  assert.ok(emptyResult);
  assert.equal(emptyResult.systemPrompt.length, 1);
  assert.match(emptyResult.systemPrompt[0], /CodeGraph structural tools/);

  let cwdReads = 0;
  const reviveResult = await callback(
    { systemPrompt: [], reason: "revive" },
    {
      get cwd() {
        cwdReads += 1;
        return fixturePath;
      },
    },
  );
  assert.equal(reviveResult, undefined);
  assert.equal(cwdReads, 0);

  const previousExcludedRoots = process.env.PI_CODEGRAPH_EXCLUDED_ROOTS;
  process.env.PI_CODEGRAPH_EXCLUDED_ROOTS = fixturePath;
  try {
    const excludedCallback = (await registerOmpHandlers()).beforeAgentStart;
    assert.ok(excludedCallback);
    const excludedResult = await excludedCallback(
      { systemPrompt: input, reason: "prompt" },
      { cwd: fixturePath },
    );
    assert.equal(excludedResult, undefined);
    await assert.rejects(access(path.join(fixturePath, ".codegraph")));
  } finally {
    if (previousExcludedRoots === undefined)
      delete process.env.PI_CODEGRAPH_EXCLUDED_ROOTS;
    else process.env.PI_CODEGRAPH_EXCLUDED_ROOTS = previousExcludedRoots;
  }
}

async function testDisabledPromptInjection(): Promise<void> {
  const previous = process.env.PI_CODEGRAPH_PROMPT_INJECTION;
  process.env.PI_CODEGRAPH_PROMPT_INJECTION = "0";
  try {
    const handlers = await registerOmpHandlers();
    assert.equal(handlers.beforeAgentStart, undefined);
    assert.ok(
      handlers.toolCall,
      "routing must remain active when prompts are disabled",
    );
  } finally {
    if (previous === undefined)
      delete process.env.PI_CODEGRAPH_PROMPT_INJECTION;
    else process.env.PI_CODEGRAPH_PROMPT_INJECTION = previous;
  }
}

async function main(): Promise<void> {
  await createFixture();
  process.chdir(fixturePath);
  await testOmpPromptInjection();
  await testDisabledPromptInjection();

  const { stdout: ompVersion } = await execFileAsync(ompBin, ["--version"]);
  assert.match(ompVersion, /18\.14\.0/);

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
    const siblingPrepared = await connection.transport.request<{
      state: string;
    }>("codegraph/workspace/prepare", { projectPath: siblingFixturePath });
    assert.equal(siblingPrepared.state, "ready");

    const listed = await connection.transport.request<{
      tools: McpToolDefinition[];
    }>("tools/list");
    const listedTools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const nodeSchema = listedTools.get("codegraph_node")?.inputSchema;
    assert.deepEqual(nodeSchema?.required, []);
    assert.deepEqual(Object.keys(nodeSchema?.properties ?? {}).sort(), [
      "file",
      "includeCode",
      "limit",
      "line",
      "offset",
      "projectPath",
      "symbol",
      "symbolsOnly",
    ]);
    for (const name of [
      "codegraph_callers",
      "codegraph_callees",
      "codegraph_impact",
    ]) {
      assert.ok(
        "file" in (listedTools.get(name)?.inputSchema.properties ?? {}),
        `${name} did not expose its file selector`,
      );
    }
    for (const tool of listed.tools) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    const tools = new Map(
      loaded.tools.map((entry) => [entry.tool.mcpToolName, entry.tool]),
    );
    assert.deepEqual([...tools.keys()].sort(), [...expectedTools].sort());
    const searchTool = tools.get("codegraph_search");
    assert.ok(searchTool);
    assert.equal(searchTool.name, "mcp__codegraph_search");
    assert.equal(searchTool.mcpServerName, "codegraph");
    assert.equal(searchTool.mcpToolName, "codegraph_search");
    const routingHandlers = await registerOmpHandlers();
    assert.ok(routingHandlers.toolCall);
    const siblingRoute = await routingHandlers.toolCall(
      { toolName: searchTool.name, input: { query: "SiblingWorktreeSymbol" } },
      { cwd: siblingFixturePath },
    );
    assert.deepEqual(siblingRoute?.input, {
      query: "SiblingWorktreeSymbol",
      projectPath: siblingFixturePath,
    });
    const siblingResult = await searchTool.execute(
      "integration-sibling-routing",
      siblingRoute?.input,
      undefined,
      { cwd: siblingFixturePath },
    );
    assert.equal(siblingResult.isError, undefined, textOf(siblingResult));
    assert.match(textOf(siblingResult), /SiblingWorktreeSymbol/);

    const explicitRoute = await routingHandlers.toolCall(
      {
        toolName: searchTool.name,
        input: {
          query: "SiblingWorktreeSymbol",
          projectPath: siblingFixturePath,
        },
      },
      { cwd: fixturePath },
    );
    assert.equal(explicitRoute, undefined);
    const explicitSiblingResult = await searchTool.execute(
      "integration-explicit-sibling-routing",
      { query: "SiblingWorktreeSymbol", projectPath: siblingFixturePath },
      undefined,
      { cwd: fixturePath },
    );
    assert.equal(explicitSiblingResult.isError, undefined);
    assert.match(textOf(explicitSiblingResult), /SiblingWorktreeSymbol/);
    const unrelatedRoute = await routingHandlers.toolCall(
      {
        toolName: "mcp__other_codegraph_search",
        input: { query: "addNumbers" },
      },
      { cwd: siblingFixturePath },
    );
    assert.equal(unrelatedRoute, undefined);
    const nonMcpRoute = await routingHandlers.toolCall(
      { toolName: "bash", input: { command: "printf safe" } },
      { cwd: siblingFixturePath },
    );
    assert.equal(nonMcpRoute, undefined);

    const cases: Array<{
      name: (typeof expectedTools)[number];
      args: Record<string, unknown>;
      includes: string;
      excludes?: string;
    }> = [
      {
        name: "codegraph_search",
        args: { query: "addNumbers" },
        includes: "addNumbers",
      },
      {
        name: "codegraph_node",
        args: {
          symbol: "addNumbers",
          includeCode: true,
          file: "src/math.ts",
          line: 1,
        },
        includes: "return left + right",
        excludes: "return left * right",
      },
      {
        name: "codegraph_node",
        args: {
          file: path.join(fixturePath, "src", "math.ts"),
          offset: 1,
          limit: 3,
        },
        includes: "addNumbers",
        excludes: "calculateTotal",
      },
      {
        name: "codegraph_node",
        args: { file: "src/math.ts", symbolsOnly: true },
        includes: "Symbols",
      },
      {
        name: "codegraph_files",
        args: { path: "src", format: "flat" },
        includes: "math.ts",
      },
      {
        name: "codegraph_callers",
        args: { symbol: "addNumbers", file: "src/math.ts" },
        includes: "calculateTotal",
        excludes: "alternate.ts",
      },
      {
        name: "codegraph_callees",
        args: { symbol: "calculateTotal", file: "src/math.ts" },
        includes: "addNumbers",
        excludes: "alternate.ts",
      },
      {
        name: "codegraph_impact",
        args: { symbol: "addNumbers", file: "src/math.ts", depth: 2 },
        includes: "calculateTotal",
        excludes: "alternate.ts",
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
      const routed = await routingHandlers.toolCall(
        { toolName: tool.name, input: testCase.args },
        { cwd: fixturePath },
      );
      assert.deepEqual(routed?.input, {
        ...testCase.args,
        projectPath: fixturePath,
      });
      const result = await tool.execute(
        `integration-${testCase.name}`,
        routed?.input,
        undefined,
        { cwd: fixturePath },
      );
      assert.equal(
        result.isError,
        undefined,
        `${testCase.name} failed: ${textOf(result)}`,
      );
      const text = textOf(result).toLowerCase();
      assert.ok(
        text.includes(testCase.includes.toLowerCase()),
        `${testCase.name} did not include ${testCase.includes}`,
      );
      if (testCase.excludes) {
        assert.ok(
          !text.includes(testCase.excludes.toLowerCase()),
          `${testCase.name} ignored its file selector`,
        );
      }
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
