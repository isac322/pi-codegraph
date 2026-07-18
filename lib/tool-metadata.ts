import type { CodeGraphTool } from "./types.ts";

const projectPath = {
  type: "string",
  description: "Absolute path to the target project or worktree. Pi fills this with the active cwd when omitted; OMP child agents should pass their exact worktree path.",
};

const kind = {
  type: "string",
  enum: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
};

function object(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export const codegraphTools: readonly CodeGraphTool[] = Object.freeze([
  {
    name: "codegraph_search",
    label: "CodeGraph Search",
    description: "Search indexed declarations by symbol name. Use this before text search when you know all or part of a symbol name.",
    promptSnippet: "Find declarations and symbol locations by name in the active CodeGraph index.",
    promptGuidelines: ["Use for symbol names, not literal strings.", "Follow a result with codegraph_node when implementation or relationships are needed."],
    inputSchema: object({ query: { type: "string", description: "Symbol name or partial name." }, kind, limit: { type: "number", default: 10 }, projectPath }, ["query"]),
  },
  {
    name: "codegraph_node",
    label: "CodeGraph Node",
    description: "Inspect one known symbol, including signature, location, source, callers, and callees.",
    promptSnippet: "Inspect a known symbol and its immediate relationships.",
    promptGuidelines: ["Use after codegraph_search identifies the symbol.", "Set includeCode only when source is necessary."],
    inputSchema: object({ symbol: { type: "string", description: "Exact or unambiguous symbol name." }, includeCode: { type: "boolean", default: false }, projectPath }, ["symbol"]),
  },
  {
    name: "codegraph_files",
    label: "CodeGraph Files",
    description: "Read the indexed project file tree. Paths are normalized to repo-relative POSIX prefixes.",
    promptSnippet: "Inspect indexed project structure without filesystem traversal.",
    promptGuidelines: ["Use before read/glob for architectural navigation.", "Pass a repo-relative directory prefix such as src/components."],
    inputSchema: object({ path: { type: "string", description: "Repo-relative path prefix." }, pattern: { type: "string" }, format: { type: "string", enum: ["tree", "flat", "grouped"], default: "tree" }, includeMetadata: { type: "boolean", default: true }, maxDepth: { type: "number" }, projectPath }),
  },
  {
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find functions and methods that call a symbol.",
    promptSnippet: "Trace inbound calls to a known symbol.",
    promptGuidelines: ["Use for inbound flow and direct impact."],
    inputSchema: object({ symbol: { type: "string" }, limit: { type: "number", default: 20 }, projectPath }, ["symbol"]),
  },
  {
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find functions and methods called by a symbol.",
    promptSnippet: "Trace outbound calls from a known symbol.",
    promptGuidelines: ["Use for downstream execution flow."],
    inputSchema: object({ symbol: { type: "string" }, limit: { type: "number", default: 20 }, projectPath }, ["symbol"]),
  },
  {
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze the transitive impact radius of changing a symbol.",
    promptSnippet: "Estimate what a symbol change can affect.",
    promptGuidelines: ["Use before editing shared APIs or heavily referenced symbols."],
    inputSchema: object({ symbol: { type: "string" }, depth: { type: "number", default: 2 }, projectPath }, ["symbol"]),
  },
  {
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description: "Explore several related symbols and source locations grouped by file. Best first tool for broad architecture and flow questions.",
    promptSnippet: "Explore a feature, flow, or architectural concept across related symbols.",
    promptGuidelines: ["Prefer this first for broad how-does-it-work questions.", "Narrow the query before increasing maxFiles."],
    inputSchema: object({ query: { type: "string", description: "Specific symbols, files, or code terms to explore." }, maxFiles: { type: "number", default: 12 }, projectPath }, ["query"]),
  },
  {
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Report CodeGraph index health and pending synchronization state.",
    promptSnippet: "Check whether the active project index is ready and current.",
    promptGuidelines: ["Use when another CodeGraph tool reports an index or lock error."],
    inputSchema: object({ projectPath }),
  },
]);

export const codegraphToolNames = Object.freeze(codegraphTools.map((tool) => tool.name));

export function toolCallLabel(name: string, args: Record<string, unknown> = {}): string {
  const value = args.query || args.symbol || args.path || "status";
  const project = typeof args.projectPath === "string" ? args.projectPath.split(/[\\/]/).filter(Boolean).at(-1) : "current";
  return `${value} · ${project}`;
}

export function summarizeToolText(text: unknown): { firstLine: string; lineCount: number; truncated: boolean } {
  const lines = String(text || "").split("\n").filter((line) => line.trim());
  return {
    firstLine: lines[0] || "No output",
    lineCount: lines.length,
    truncated: String(text || "").includes("[pi-codegraph output truncated]"),
  };
}
