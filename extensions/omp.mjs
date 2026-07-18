import { loadSettings } from "../lib/config.mjs";
import { workspaceSummary } from "../lib/codegraph.mjs";
import { buildCodeGraphPrompt } from "../lib/prompt.mjs";

export default async function ompCodeGraphExtension(omp) {
  const settings = await loadSettings();
  if (!settings.promptInjection || typeof omp?.on !== "function") return;
  omp.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd || process.cwd();
    const status = await workspaceSummary(cwd);
    const guidance = buildCodeGraphPrompt({ runtime: "omp", cwd, status });
    return { systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${guidance}` : guidance };
  });
}
