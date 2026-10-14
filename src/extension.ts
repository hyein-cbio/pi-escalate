import { join } from "node:path";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readConfig, type EscalateConfig } from "./config.ts";
import { escalate, EscalateError, MAX_ANSWER_CHARS } from "./escalate.ts";
import { EscalatePermission } from "./permission.ts";
import { assertCommandContext, assertRegistry } from "./compatibility.ts";
import { dispatchPrompt, investigationInput, parseCommand } from "./request.ts";

export default function piEscalate(pi: ExtensionAPI) {
  const permission = new EscalatePermission();
  let settingUp = false;
  let sessionConfig: { session: string; config: EscalateConfig } | undefined;
  let sessionGeneration = 0;

  pi.registerCommand("escalate", {
    description: "Investigate with a rich handoff; use min for ≤500-byte context, or set to choose model/thinking.",
    getArgumentCompletions: (prefix) => {
      const word = prefix.trimStart();
      // Complete only the first argument; preserve free-form questions and min's request.
      if (/\s/.test(word)) return null;
      const items = [
        { value: "set", label: "set", description: "Configure the oracle model and thinking level" },
        { value: "min ", label: "min", description: "Use at most 500 UTF-8 bytes of additional context" },
      ].filter((item) => item.label.startsWith(word));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      assertCommandContext(ctx);
      const fail = (message: string) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else throw new Error(message);
      };
      let command;
      try { command = parseCommand(args); }
      catch (error) { return fail((error as Error).message); }
      if (settingUp || !ctx.isIdle() || ctx.hasPendingMessages()) {
        return fail("pi-escalate: finish current work, queued messages, or the open settings dialog first.");
      }
      if (command.kind === "set") {
        if (ctx.mode !== "tui" || !ctx.hasUI) return fail("pi-escalate: /escalate set requires Pi TUI mode.");
        settingUp = true;
        const session = ctx.sessionManager.getSessionId();
        const generation = sessionGeneration;
        try {
          // Keep UI dependencies off the ordinary headless execution path.
          const { configureEscalation } = await import("./setup.ts");
          const current = sessionConfig?.session === session ? sessionConfig.config : undefined;
          const config = await configureEscalation(ctx, join(getAgentDir(), "pi-escalate.json"), current,
            () => sessionGeneration === generation);
          if (config && sessionGeneration === generation && ctx.sessionManager.getSessionId() === session) {
            sessionConfig = { session, config };
          }
        } catch (error) {
          return fail(error instanceof Error && error.message.startsWith("pi-escalate:") ? error.message :
            "pi-escalate: settings could not be applied or saved. Check configuration directory permissions.");
        } finally {
          settingUp = false;
        }
        return;
      }
      if (!pi.getActiveTools().includes("codemode")) {
        return fail(
          `pi-escalate: codemode is inactive. Add "+codemode" to defaultTools in ${join(getAgentDir(), "settings.json")} ` +
          "(preserving existing entries), then run /reload or restart Pi and retry /escalate. " +
          "If you start Pi with --tools, include codemode in that list.",
        );
      }
      const prompt = dispatchPrompt(command);
      permission.prepare(ctx.sessionManager.getSessionId(), prompt, command);
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
  // Revoke even an unused grant; temporary settings survive ordinary runs/tree navigation.
  pi.on("agent_end", () => { permission.clear(); });
  pi.on("session_tree", () => { permission.clear(); });
  const resetSession = () => {
    permission.clear();
    sessionConfig = undefined;
    sessionGeneration++;
  };
  pi.on("session_start", resetSession);
  pi.on("session_shutdown", resetSession);

  pi.registerTool(defineTool({
    name: "escalate",
    label: "Escalate",
    description:
      "Only after /escalate or /escalate min: run one read-only investigation of its requested question. " +
      "The target has read, grep, find, ls; no history or extensions are inherited. " +
      "Follow the authorized mode: rich structured handoff by default; min context ≤500 UTF-8 bytes. " +
      "Returns { answer, truncated }. Print only what you need from codemode.",
    exposure: "codemode",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "One self-contained question; in min mode the executor uses the original user request." }),
      context: Type.Optional(Type.String({ description: "Relevant structured handoff, or at most 500 UTF-8 bytes in min mode." })),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({
      answer: Type.String({ maxLength: MAX_ANSWER_CHARS }),
      truncated: Type.Boolean(),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const authorized = permission.consume(ctx);
      const input = investigationInput(params, authorized);
      assertRegistry(ctx.modelRegistry);
      const current = sessionConfig?.session === ctx.sessionManager.getSessionId() ? sessionConfig.config : undefined;
      const config = current ?? await readConfig(join(getAgentDir(), "pi-escalate.json"));
      try {
        const signals = [signal, ctx.signal].filter((item): item is AbortSignal => item !== undefined);
        const result = await escalate(input, config, ctx.modelRegistry,
          signals.length ? AbortSignal.any(signals) : undefined, ctx.cwd, () => {
            if (ctx.hasUI) {
              ctx.ui.notify(`pi-escalate: investigating with ${config.model} · thinking ${config.reasoningLevel}`, "info");
            }
          });
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
