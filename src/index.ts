import { join } from "node:path";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readConfig } from "./config.ts";
import { escalate, EscalateError, MAX_ANSWER_CHARS } from "./escalate.ts";
import { EscalatePermission } from "./permission.ts";

export default function piEscalate(pi: ExtensionAPI) {
  const permission = new EscalatePermission();
  let settingUp = false;

  pi.registerCommand("escalate-set", {
    description: "Choose the escalation model and thinking level in a local settings TUI.",
    handler: async (args, ctx) => {
      const fail = (message: string) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else throw new Error(message);
      };
      if (ctx.mode !== "tui" || !ctx.hasUI) return fail("pi-escalate: /escalate-set requires Pi TUI mode.");
      if (args.trim()) return fail("Usage: /escalate-set");
      if (settingUp || !ctx.isIdle() || ctx.hasPendingMessages()) {
        return fail("pi-escalate: finish current work or the open settings dialog first.");
      }
      settingUp = true;
      try {
        // Keep UI dependencies off the ordinary headless execution path.
        const { configureEscalation } = await import("./setup.ts");
        await configureEscalation(ctx, join(getAgentDir(), "pi-escalate.json"));
      } catch (error) {
        return fail(error instanceof Error && error.message.startsWith("pi-escalate:") ? error.message :
          "pi-escalate: settings could not be saved. Check configuration directory permissions.");
      } finally {
        settingUp = false;
      }
    },
  });

  pi.registerCommand("escalate", {
    description: "Consult the configured model once about this request, without switching the main model.",
    handler: async (args, ctx) => {
      const fail = (message: string) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else throw new Error(message);
      };
      if (!args.trim()) return fail("Usage: /escalate <question or bounded task>");
      if (settingUp || !ctx.isIdle() || ctx.hasPendingMessages()) {
        return fail("pi-escalate: wait for the current work and queued messages to finish, then use /escalate.");
      }
      if (!pi.getActiveTools().includes("codemode")) {
        return fail("pi-escalate: enable Pi's codemode tool before using /escalate.");
      }
      const prompt = [
        `Escalate once: ${args.trim()}`,
        "Use codemode to prepare only the necessary reference data and call tools.escalate exactly once.",
        "Make its question self-contained; do not forward the conversation or print reference data.",
        "Print result.answer and note result.truncated if true. Summarize briefly without duplicating long output; do not implement fixes.",
        "If required context is unclear, ask the user instead of guessing or making an unrelated call.",
      ].join("\n");
      permission.prepare(ctx.sessionManager.getSessionId(), prompt);
      try {
        pi.sendUserMessage(prompt, { expandPromptTemplates: false });
      } catch (error) {
        permission.clear();
        throw error;
      }
    },
  });

  pi.on("input", (event, ctx) => {
    permission.observeInput(event.text, ctx.sessionManager.getSessionId());
  });
  pi.on("before_agent_start", (event, ctx) => {
    permission.beforeStart(event.prompt, ctx.sessionManager.getSessionId());
  });
  pi.on("agent_start", (_event, ctx) => { permission.start(ctx); });
  // Revoke even an unused grant on completion, cancellation, or a failed run.
  pi.on("agent_end", () => { permission.clear(); });
  pi.on("session_start", () => { permission.clear(); });
  pi.on("session_tree", () => { permission.clear(); });
  pi.on("session_shutdown", () => { permission.clear(); });

  pi.registerTool(defineTool({
    name: "escalate",
    label: "Escalate",
    description:
      "Only after /escalate: consult the configured model once about its requested question. " +
      "Send only necessary context; no history or tools are inherited. " +
      "Returns { answer, truncated }. Print only what you need from codemode.",
    exposure: "codemode",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "One self-contained question." }),
      context: Type.Optional(Type.String({ description: "Only the reference material needed to answer." })),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({
      answer: Type.String({ maxLength: MAX_ANSWER_CHARS }),
      truncated: Type.Boolean(),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      permission.consume(ctx);
      const config = await readConfig(join(getAgentDir(), "pi-escalate.json"));
      try {
        const signals = [signal, ctx.signal].filter((item): item is AbortSignal => item !== undefined);
        const result = await escalate(params, config, ctx.modelRegistry,
          signals.length ? AbortSignal.any(signals) : undefined);
        return {
          content: [{ type: "text", text: result.output.answer }],
          structuredContent: { ...result.output },
          details: undefined,
          usage: result.usage,
        };
      } catch (error) {
        if (!(error instanceof EscalateError)) throw error;
        return {
          content: [{ type: "text", text: error.message }],
          details: undefined,
          isError: true,
          usage: error.usage,
        };
      }
    },
  }));
}
