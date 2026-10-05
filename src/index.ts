import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertFunctions, assertHostVersion } from "./compatibility.ts";

/** Check the host before importing the implementation's newer named exports. */
export default async function piEscalate(pi: ExtensionAPI): Promise<void> {
  const host = await import("@earendil-works/pi-coding-agent");
  assertHostVersion(host.VERSION);
  assertFunctions(host, ["defineTool", "getAgentDir", "createReadOnlyTools", "detectSupportedImageMimeTypeFromFile"], "pi-coding-agent");
  assertFunctions(pi, ["registerCommand", "registerTool", "on", "getActiveTools", "sendUserMessage"], "ExtensionAPI");

  const ai = await import("@earendil-works/pi-ai");
  assertFunctions(ai, ["getSupportedThinkingLevels", "createAssistantMessageEventStream"], "pi-ai");
  const schemas = await import("typebox");
  assertFunctions(schemas.Type, ["Object", "String", "Optional", "Boolean"], "typebox.Type");
  const core = await import("@earendil-works/pi-agent-core");
  assertFunctions(core, ["Agent"], "pi-agent-core");
  assertFunctions(core.Agent.prototype,
    ["prompt", "subscribe", "abort", "clearAllQueues", "waitForIdle", "reset"], "Agent");

  // A constructor-only probe: no requests, subscriptions, sessions, timers, or tools.
  // Detect cores that ignore hook options; behavioral guarantees still need real tests.
  const probe = new core.Agent({
    streamFn: () => { throw new Error("pi-escalate: compatibility probe must not stream."); },
    prepareRequest: () => undefined,
    finishTurn: () => undefined,
    beforeToolCall: async () => undefined,
    afterToolCall: async () => undefined,
  });
  assertFunctions(probe, ["prepareRequest", "finishTurn", "beforeToolCall", "afterToolCall"], "Agent");

  const { default: register } = await import("./extension.ts");
  register(pi);
}
