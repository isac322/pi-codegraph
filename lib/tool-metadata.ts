import type { CodeGraphTool } from "./types.js";

const projectPath = {
  type: "string",
  description:
    "Absolute path to the target project or worktree. Pi fills this with the active cwd when omitted; OMP child agents should pass their exact worktree path.",
};
const file = {
  type: "string",
  description:
    "File path or basename. Use it alone with codegraph_node to read a file, or with a symbol to select one definition.",
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const kind = {
  type: "string",
  enum: [
    "function",
    "method",
    "class",
    "interface",
    "type",
    "variable",
    "route",
    "component",
  ],
};

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
): CodeGraphTool["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

export const codegraphTools: readonly CodeGraphTool[] = Object.freeze([
  {
    name: "codegraph_search",
    label: "CodeGraph Search",
    description:
      "Search indexed declarations by symbol name. Returns locations only; use codegraph_explore when you need source and relationships.",
    promptSnippet: "Find indexed declarations and symbol locations by name.",
    promptGuidelines: [
      "Use for symbol names, not literal strings.",
      "Use codegraph_explore instead when you need source or execution flow.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object(
      {
        query: { type: "string", description: "Symbol name or partial name." },
        kind,
        limit: { type: "number", default: 10 },
        projectPath,
      },
      ["query"],
    ),
  },
  {
    name: "codegraph_node",
    label: "CodeGraph Node",
    description:
      "Read an indexed file with line numbers and dependents, or inspect a named symbol with its source and relationships.",
    promptSnippet:
      "Read an indexed file or inspect a known symbol and its immediate relationships.",
    promptGuidelines: [
      "Pass file without symbol to read current source; use offset and limit for a line range or symbolsOnly for a structural overview.",
      "Pass symbol with file or line to disambiguate same-named definitions.",
      "Set includeCode only when symbol source is necessary.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object({
      symbol: {
        type: "string",
        description: "Symbol name to inspect.",
      },
      includeCode: {
        type: "boolean",
        description: "Include the symbol body in symbol mode.",
        default: false,
      },
      file,
      offset: {
        type: "number",
        description: "One-based starting line in file mode.",
      },
      limit: {
        type: "number",
        description: "Maximum lines to return in file mode.",
      },
      symbolsOnly: {
        type: "boolean",
        description: "Return the file's symbol map instead of source.",
        default: false,
      },
      line: {
        type: "number",
        description: "Line used to disambiguate a symbol definition.",
      },
      projectPath,
    }),
  },
  {
    name: "codegraph_files",
    label: "CodeGraph Files",
    description:
      "Read the indexed project file tree. Paths are normalized to repo-relative POSIX prefixes.",
    promptSnippet:
      "Inspect indexed project structure without filesystem traversal.",
    promptGuidelines: [
      "Use before read/glob for architectural navigation.",
      "Pass a repo-relative directory prefix such as src/components.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object({
      path: { type: "string", description: "Repo-relative path prefix." },
      pattern: { type: "string" },
      format: {
        type: "string",
        enum: ["tree", "flat", "grouped"],
        default: "tree",
      },
      includeMetadata: { type: "boolean", default: true },
      maxDepth: { type: "number" },
      projectPath,
    }),
  },
  {
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description:
      "Find functions and methods that call a symbol, optionally selecting its definition by file.",
    promptSnippet: "Trace inbound calls to a known symbol.",
    promptGuidelines: [
      "Use file when the symbol has same-named definitions.",
      "Use for inbound flow and direct impact.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object(
      {
        symbol: { type: "string" },
        file,
        limit: { type: "number", default: 20 },
        projectPath,
      },
      ["symbol"],
    ),
  },
  {
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description:
      "Find functions and methods called by a symbol, optionally selecting its definition by file.",
    promptSnippet: "Trace outbound calls from a known symbol.",
    promptGuidelines: [
      "Use file when the symbol has same-named definitions.",
      "Use for downstream execution flow.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object(
      {
        symbol: { type: "string" },
        file,
        limit: { type: "number", default: 20 },
        projectPath,
      },
      ["symbol"],
    ),
  },
  {
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description:
      "Analyze the transitive impact radius of a symbol, optionally selecting its definition by file.",
    promptSnippet: "Estimate what a symbol change can affect.",
    promptGuidelines: [
      "Use file when the symbol has same-named definitions.",
      "Use before editing shared APIs or heavily referenced symbols.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object(
      {
        symbol: { type: "string" },
        file,
        depth: { type: "number", default: 2 },
        projectPath,
      },
      ["symbol"],
    ),
  },
  {
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description:
      "Explore related symbols and line-numbered source grouped by file. Best first tool for architecture, flows, and broad code questions.",
    promptSnippet:
      "Explore a feature, flow, or architectural concept across related symbols.",
    promptGuidelines: [
      "Prefer this first for broad how-does-it-work questions and before editing an unfamiliar area.",
      "Name relevant symbols or files before increasing maxFiles.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object(
      {
        query: {
          type: "string",
          description: "Specific symbols, files, or code terms to explore.",
        },
        maxFiles: { type: "number", default: 12 },
        projectPath,
      },
      ["query"],
    ),
  },
  {
    name: "codegraph_status",
    label: "CodeGraph Status",
    description:
      "Report CodeGraph index health and pending synchronization state.",
    promptSnippet:
      "Check whether the active project index is ready and current.",
    promptGuidelines: [
      "Use when another CodeGraph tool reports an index or lock error.",
    ],
    annotations: readOnlyAnnotations,
    inputSchema: object({ projectPath }),
  },
]);

export const codegraphToolNames = Object.freeze(
  codegraphTools.map((tool) => tool.name),
);

export function toolCallLabel(
  _name: string,
  args: Record<string, unknown> = {},
): string {
  const value = args.query || args.symbol || args.file || args.path || "status";
  const project =
    typeof args.projectPath === "string"
      ? args.projectPath.split(/[\\/]/).filter(Boolean).at(-1)
      : "current";
  return `${value} · ${project}`;
}

export function summarizeToolText(text: unknown): {
  firstLine: string;
  lineCount: number;
  truncated: boolean;
} {
  const lines = String(text || "")
    .split("\n")
    .filter((line) => line.trim());
  return {
    firstLine: lines[0] || "No output",
    lineCount: lines.length,
    truncated: String(text || "").includes("[pi-codegraph output truncated]"),
  };
}
