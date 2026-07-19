import { Text } from "@earendil-works/pi-tui";
import { loadSettings } from "../lib/config.js";
import { workspaceSummary } from "../lib/codegraph.js";
import { buildCodeGraphPrompt } from "../lib/prompt.js";
import { PiCodeGraphClient } from "../lib/pi-mcp-client.js";
import { codegraphTools, summarizeToolText, toolCallLabel } from "../lib/tool-metadata.js";

function textContent(result) {
  return (result?.content || []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

async function trusted(ctx) {
  if (typeof ctx?.isProjectTrusted !== "function") return true;
  return Boolean(await ctx.isProjectTrusted());
}

export default async function piCodeGraphExtension(pi: any): Promise<void> {
  const settings = await loadSettings();
  let sessionCwd = process.cwd();
  let client;

  const getClient = async (cwd, ctx) => {
    if (!(await trusted(ctx))) throw new Error("CodeGraph is disabled until this project is trusted.");
    if (!client || sessionCwd !== cwd) {
      await client?.close();
      sessionCwd = cwd;
      client = new PiCodeGraphClient(settings, cwd);
    }
    return client;
  };

  for (const tool of codegraphTools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd || sessionCwd || process.cwd();
        const activeClient = await getClient(cwd, ctx);
        const args = { ...(params || {}), projectPath: params?.projectPath || cwd };
        const result = await activeClient.callTool(tool.name, args, signal);
        const text = textContent(result);
        if (result?.isError) throw new Error(text || `${tool.label} failed`);
        const summary = summarizeToolText(text);
        return {
          content: result?.content?.length ? result.content : [{ type: "text", text: JSON.stringify(result) }],
          details: { toolName: tool.name, projectPath: args.projectPath, ...summary },
        };
      },
      renderCall(args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold(`${tool.label} `)) + theme.fg("muted", toolCallLabel(tool.name, args)), 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details || {};
        const text = textContent(result);
        if (!text) return new Text(theme.fg("dim", "No output"), 0, 0);
        if (expanded) return new Text(text, 0, 0);
        const lines = text.split("\n");
        const preview = lines.slice(0, 6).join("\n");
        const suffix = lines.length > 6 ? `\n${theme.fg("dim", `... ${lines.length - 6} more lines`)}` : "";
        const marker = details.truncated ? theme.fg("warning", " [truncated]") : "";
        return new Text(`${preview}${suffix}${marker}`, 0, 0);
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd || process.cwd();
    if (!(await trusted(ctx))) return;
    ctx.ui?.setStatus?.("codegraph", "CodeGraph indexing");
    try {
      const activeClient = await getClient(sessionCwd, ctx);
      await activeClient.request("codegraph/workspace/prepare", { projectPath: sessionCwd });
    } catch (error) {
      ctx.ui?.notify?.(`CodeGraph initialization failed: ${error.message}`, "warning");
    } finally {
      ctx.ui?.setStatus?.("codegraph", undefined);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!settings.promptInjection || !(await trusted(ctx))) return;
    const cwd = ctx.cwd || sessionCwd || process.cwd();
    const status = await workspaceSummary(cwd);
    const guidance = buildCodeGraphPrompt({ runtime: "pi", cwd, status });
    return { systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${guidance}` : guidance };
  });

  pi.on("session_shutdown", async () => {
    await client?.close();
    client = undefined;
  });

  pi.registerCommand("codegraph", {
    description: "CodeGraph status, sync, doctor, or gc",
    handler: async (input, ctx) => {
      if (!(await trusted(ctx))) {
        ctx.ui?.notify?.("Trust this project before using CodeGraph.", "error");
        return;
      }
      const action = String(input || "status").trim().split(/\s+/)[0] || "status";
      const methods = {
        status: "codegraph/workspace/status",
        sync: "codegraph/workspace/sync",
        doctor: "codegraph/workspace/doctor",
        gc: "codegraph/workspace/gc",
      };
      if (!methods[action]) {
        ctx.ui?.notify?.("Usage: /codegraph [status|sync|doctor|gc]", "error");
        return;
      }
      ctx.ui?.setStatus?.("codegraph", `CodeGraph ${action}`);
      try {
        const activeClient = await getClient(ctx.cwd || sessionCwd, ctx);
        const result = await activeClient.request(methods[action], { projectPath: ctx.cwd || sessionCwd, force: action === "gc" });
        ctx.ui?.notify?.(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        ctx.ui?.notify?.(`CodeGraph ${action} failed: ${error.message}`, "error");
      } finally {
        ctx.ui?.setStatus?.("codegraph", undefined);
      }
    },
  });
}
