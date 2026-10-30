import { workspaceSummary } from "../lib/codegraph.js";
import { loadSettings } from "../lib/config.js";
import { buildCodeGraphPrompt } from "../lib/prompt.js";
import { codegraphToolNames } from "../lib/tool-metadata.js";

interface OmpBeforeAgentStartEvent {
  systemPrompt?: string[];
  reason: "prompt" | "revive";
}

interface OmpToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}

interface OmpExtensionContext {
  cwd: string;
}

interface OmpExtensionApi {
  on(
    event: "before_agent_start",
    handler: (
      event: OmpBeforeAgentStartEvent,
      context: OmpExtensionContext,
    ) => Promise<{ systemPrompt: string[] } | undefined>,
  ): void;
  on(
    event: "tool_call",
    handler: (
      event: OmpToolCallEvent,
      context: OmpExtensionContext,
    ) => Promise<{ input: Record<string, unknown> } | undefined>,
  ): void;
}

const ompCodeGraphToolNames = new Set(
  codegraphToolNames.map(
    (toolName) =>
      `mcp__codegraph_${toolName.startsWith("codegraph_") ? toolName.slice("codegraph_".length) : toolName}`,
  ),
);

export default async function ompCodeGraphExtension(
  omp: OmpExtensionApi,
): Promise<void> {
  const settings = await loadSettings();
  if (typeof omp?.on !== "function") return;

  omp.on("tool_call", async (event, ctx) => {
    if (
      !ompCodeGraphToolNames.has(event.toolName) ||
      Object.hasOwn(event.input, "projectPath")
    ) {
      return undefined;
    }
    return {
      input: {
        ...event.input,
        projectPath: ctx.cwd,
      },
    };
  });

  if (!settings.promptInjection) return;
  omp.on("before_agent_start", async (event, ctx) => {
    if (event.reason === "revive") return undefined;
    const cwd = ctx.cwd;
    const status = await workspaceSummary(cwd, settings.excludedProjectRoots);
    if (status.state === "excluded") return;
    const guidance = buildCodeGraphPrompt({ runtime: "omp", cwd, status });
    return {
      systemPrompt: [...(event.systemPrompt ?? []), guidance],
    };
  });
}
