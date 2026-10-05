import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseConfig, readConfig } from "../src/config.ts";
import { escalate, EscalateError, limitAnswer, MAX_ANSWER_CHARS, REQUEST_TIMEOUT_MS } from "../src/escalate.ts";
import extension from "../src/index.ts";

const model: Model<"openai-completions"> = {
  provider: "fixture", id: "org/astra", name: "Astra",
  api: "openai-completions", baseUrl: "http://localhost/v1",
  reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 32_768,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

function response(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "  Answer.  " }],
    api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
    stopReason: "stop", timestamp: Date.now(), ...overrides,
  };
}

function fixture(message = response()) {
  const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
  const registry = {
    find(provider: string, id: string) {
      assert.equal(provider, "fixture");
      assert.equal(id, "org/astra");
      return model;
    },
    hasConfiguredAuth: () => true,
    streamSimple(_model: unknown, context: Context, options?: SimpleStreamOptions) {
      calls.push({ context, options });
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason === "length" ? "length" : "stop", message });
      return stream;
    },
  };
  return {
    registry: registry as unknown as ExtensionContext["modelRegistry"],
    calls, raw: registry,
  };
}
const config = parseConfig({ model: "fixture/org/astra", reasoningLevel: "high" });

test("config accepts only the two settings, preserving nested model IDs", () => {
  assert.deepEqual(config, { model: "fixture/org/astra", reasoningLevel: "high" });
  assert.equal(parseConfig({ model: "fixture/org/astra" }).reasoningLevel, "high");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(parseConfig({ model: "fixture/org/astra", reasoningLevel: level }).reasoningLevel, level);
  }
});

for (const value of [
  null, [], "text", {}, { model: "astra" }, { model: "/astra" }, { model: "fixture/" },
  { model: "fixture/astra high" }, { model: " fixture/astra" },
  { model: "fixture/astra", reasoningLevel: "ultra" },
  { model: "fixture/astra", reasoningLevel: null },
  { model: "fixture/astra", outputLimit: 100 },
  { model: "fixture/astra", tools: ["read"] },
]) {
  test("rejects invalid config: " + JSON.stringify(value), () => {
    assert.throws(() => parseConfig(value), /pi-escalate:/);
  });
}

test("config file errors are concise and do not echo file contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-escalate-unit-"));
  try {
    const file = join(dir, "pi-escalate.json");
    await assert.rejects(readConfig(file), /create <Pi agent directory>/);
    await writeFile(file, "secret invalid input");
    await assert.rejects(readConfig(file), (error: Error) =>
      error.message.includes("not valid JSON") && !error.message.includes("secret"));
    await writeFile(file, JSON.stringify({ model: "fixture/org/astra", reasoningLevel: "off" }));
    assert.equal((await readConfig(file)).reasoningLevel, "off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one isolated investigation, fixed read-only tools, concise answer and usage only", async () => {
  const f = fixture(response({
    content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: " Answer. " }],
  }));
  const result = await escalate({ question: "Question?", context: "reference" }, config, f.registry);
  assert.deepEqual(result.output, { answer: "Answer.", truncated: false });
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(f.calls.length, 1);
  const { context, options } = f.calls[0];
  const users = context.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), ["read", "grep", "find", "ls"]);
  assert.deepEqual(JSON.parse((users[0].content as Array<{ text: string }>)[0].text),
    { question: "Question?", context: "reference" });
  assert.equal(options?.reasoning, "high");
  assert.equal(options?.cacheRetention, "none");
  assert.equal(options?.maxRetries, 0);
  assert.equal(options?.toolChoice, "auto");
  assert.equal(options?.transport, "sse");
  assert.equal(options?.timeoutMs, REQUEST_TIMEOUT_MS);
  assert.equal(options?.sessionId, undefined);
  assert.equal(options?.maxTokens, 16_384);
  assert(!JSON.stringify(result).includes("private reasoning"));
});

test("reasoning off does not inherit main session reasoning", async () => {
  const f = fixture();
  await escalate({ question: "Question?" }, { ...config, reasoningLevel: "off" }, f.registry);
  assert.equal(f.calls[0].options?.reasoning, undefined);
});

test("generation budget respects a smaller target model limit", async () => {
  const f = fixture();
  f.raw.find = () => ({ ...model, maxTokens: 2_048 });
  await escalate({ question: "Question?" }, config, f.registry);
  assert.equal(f.calls[0].options?.maxTokens, 2_048);
});

test("blank question fails before calling a model", async () => {
  const f = fixture();
  await assert.rejects(escalate({ question: " \n " }, config, f.registry), /blank/);
  assert.equal(f.calls.length, 0);
});

test("missing target or authentication never falls back to the main model", async () => {
  const f = fixture();
  f.raw.hasConfiguredAuth = () => false;
  await assert.rejects(escalate({ question: "Q" }, config, f.registry), /authentication/);
  const missing = { ...f.raw, find: () => undefined } as unknown as ExtensionContext["modelRegistry"];
  await assert.rejects(escalate({ question: "Q" }, config, missing), /registry/);
  assert.equal(f.calls.length, 0);
});

test("virtual routers and unsupported reasoning fail before execution", async () => {
  const f = fixture();
  const virtual = { ...f.raw, find: () => ({ ...model, api: "pi-virtual" }) };
  await assert.rejects(escalate({ question: "Q" }, config,
    virtual as unknown as ExtensionContext["modelRegistry"]), /physical/);
  const simple = { ...f.raw, find: () => ({ ...model, reasoning: false }) };
  await assert.rejects(escalate({ question: "Q" }, config,
    simple as unknown as ExtensionContext["modelRegistry"]), /not supported/);
  assert.equal(f.calls.length, 0);
});

test("answer cap is bounded, marked, and never cuts a surrogate pair", () => {
  assert.equal(limitAnswer("a".repeat(MAX_ANSWER_CHARS)).truncated, false);
  const output = limitAnswer("🙂".repeat(MAX_ANSWER_CHARS));
  assert(output.answer.length <= MAX_ANSWER_CHARS);
  assert.equal(output.truncated, true);
  assert.match(output.answer, /Truncated/);
  assert(!/^[\ud800-\udfff]$/.test(output.answer.split("\n\n")[0].slice(-1)) ||
    output.answer.split("\n\n")[0].endsWith("🙂"));
  assert.deepEqual(limitAnswer(" short ", true), { answer: "short", truncated: true });
});

test("provider length limit is reported even when the answer fits", async () => {
  const f = fixture(response({ stopReason: "length" }));
  assert.equal((await escalate({ question: "Q" }, config, f.registry)).output.truncated, true);
});

for (const message of [
  response({ stopReason: "error", errorMessage: "secret request body" }),
  response({ stopReason: "aborted" }),
  response({ content: [{ type: "thinking", thinking: "private" }] }),
  response({ content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "touch file" } }] }),
]) {
  test("bad response is not treated as success or leaked; usage is preserved: " + message.stopReason +
    "/" + message.content[0]?.type, async () => {
    const f = fixture(message);
    await assert.rejects(escalate({ question: "Q" }, config, f.registry), (error: Error) => {
      assert(error instanceof EscalateError);
      assert.equal(error.usage?.totalTokens, 30);
      assert(!error.message.includes("secret"));
      assert(!error.message.includes("private"));
      return true;
    });
    assert.equal(f.calls.length, 1);
  });
}

test("unexpected provider exception is sanitized", async () => {
  const f = fixture();
  f.raw.streamSimple = () => { throw new Error("secret key and full prompt"); };
  await assert.rejects(escalate({ question: "Q" }, config, f.registry),
    (error: Error) => error.message === "pi-escalate: target model request failed.");
});

test("already cancelled calls never reach the provider", async () => {
  const f = fixture();
  await assert.rejects(escalate({ question: "Q" }, config, f.registry, AbortSignal.abort()), /cancelled/);
  assert.equal(f.calls.length, 0);
});

test("cancellation interrupts an uncooperative provider", async () => {
  const f = fixture();
  f.raw.streamSimple = () => createAssistantMessageEventStream();
  const controller = new AbortController();
  const promise = escalate({ question: "Q" }, config, f.registry, controller.signal);
  controller.abort();
  await assert.rejects(promise, /cancelled/);
});

test("fifteen-minute deadline also interrupts an uncooperative provider", async (t) => {
  const f = fixture();
  f.raw.streamSimple = () => createAssistantMessageEventStream();
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 900_000);
    return controller.signal;
  });
  const promise = escalate({ question: "Q" }, config, f.registry);
  controller.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(promise, /timed out after fifteen minutes/);
});

test("extension registers only one codemode tool with no per-call routing settings", () => {
  const definitions: ToolDefinition[] = [];
  extension({
    registerTool: (definition: ToolDefinition) => definitions.push(definition),
    registerCommand: () => {},
    on: () => () => {},
  } as unknown as ExtensionAPI);
  assert.equal(definitions.length, 1);
  const tool = definitions[0];
  assert.equal(tool.name, "escalate");
  assert.equal(tool.exposure, "codemode");
  const input = tool.parameters as unknown as { properties: object; additionalProperties: boolean };
  const output = tool.outputSchema as unknown as { properties: object };
  assert.deepEqual(Object.keys(input.properties), ["question", "context"]);
  assert.deepEqual(Object.keys(output.properties), ["answer", "truncated"]);
  assert.equal(input.additionalProperties, false);
});
