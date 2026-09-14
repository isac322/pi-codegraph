import type { WorkspaceStatus } from "./types.js";

export function buildCodeGraphPrompt({
  runtime,
  cwd,
  status,
}: {
  runtime: "pi" | "omp";
  cwd: string;
  status: WorkspaceStatus;
}): string {
  const projectRule =
    runtime === "omp"
      ? `Always pass projectPath="${cwd}" so parent and child agents query the correct worktree.`
      : `The extension automatically binds omitted projectPath to "${cwd}".`;
  const state =
    status.identityMatches === false ? "identity-mismatch" : status.state;
  return [
    "CodeGraph structural tools are available as codegraph_* tools.",
    `Active project: ${cwd}`,
    `Index state: ${state}${status.lastSyncAt ? `; last sync: ${status.lastSyncAt}` : ""}`,
    projectRule,
    "Use codegraph_explore first for broad architecture and flow questions, codegraph_search for symbol locations, and codegraph_files for project structure.",
    "Use codegraph_node with file to read indexed source and see dependents; use symbol with file or line to disambiguate definitions.",
    "Use codegraph_callers and codegraph_impact before shared API changes. Use grep/read for literal text, unindexed files, or when CodeGraph is insufficient.",
  ].join("\n");
}
