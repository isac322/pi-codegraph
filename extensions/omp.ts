import { workspaceSummary } from "../lib/codegraph.js";
import { loadSettings } from "../lib/config.js";
import { buildCodeGraphPrompt } from "../lib/prompt.js";

interface OmpBeforeAgentStartEvent {
  systemPrompt?: string;
}

interface OmpExtensionContext {
  cwd?: string;
}

interface OmpExtensionApi {
  on: (
    event: "before_agent_start",
    handler: (
      event: OmpBeforeAgentStartEvent,
      context: OmpExtensionContext,
    ) => Promise<{ systemPrompt: string } | undefined>,
  ) => void;
}

export default async function ompCodeGraphExtension(
  omp: OmpExtensionApi,
): Promise<void> {
  const settings = await loadSettings();
  if (!settings.promptInjection || typeof omp?.on !== "function") return;
  omp.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd || process.cwd();
    const status = await workspaceSummary(cwd, settings.excludedProjectRoots);
    if (status.state === "excluded") return;
    const guidance = buildCodeGraphPrompt({ runtime: "omp", cwd, status });
    return {
      systemPrompt: event.systemPrompt
        ? `${event.systemPrompt}\n\n${guidance}`
        : guidance,
    };
  });
}
