import type { WorkspaceStatus } from "./types.ts";

export function buildCodeGraphPrompt({ runtime, cwd, status }: { runtime: "pi" | "omp"; cwd: string; status: WorkspaceStatus }): string {
  const projectRule = runtime === "omp"
    ? `Always pass projectPath=\"${cwd}\" so parent and child agents query the correct worktree.`
    : `The extension automatically binds omitted projectPath to \"${cwd}\".`;
  const state = status.identityMatches === false ? "identity-mismatch" : status.state;
  return [
    "CodeGraph structural tools are available as codegraph_* tools.",
    `Active project: ${cwd}`,
    `Index state: ${state}${status.lastSyncAt ? `; last sync: ${status.lastSyncAt}` : ""}`,
    projectRule,
    "For architecture, execution flow, symbol location, dependency impact, and project navigation, use CodeGraph before grep/read.",
    "Use codegraph_explore for broad flows, codegraph_search for symbol names, codegraph_node for a known symbol, codegraph_files for structure, and codegraph_callers/codegraph_impact before shared API changes.",
    "Use grep/read for literal text, generated names, or when CodeGraph is insufficient.",
  ].join("\n");
}
