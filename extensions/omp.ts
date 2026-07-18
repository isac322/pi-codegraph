import { loadSettings } from "../lib/config.ts";
import { workspaceSummary } from "../lib/codegraph.ts";
import { buildCodeGraphPrompt } from "../lib/prompt.ts";

export default async function ompCodeGraphExtension(omp: any): Promise<void> {
  const settings = await loadSettings();
  if (!settings.promptInjection || typeof omp?.on !== "function") return;
  omp.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd || process.cwd();
    const status = await workspaceSummary(cwd);
    const guidance = buildCodeGraphPrompt({ runtime: "omp", cwd, status });
    return { systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${guidance}` : guidance };
  });
}
