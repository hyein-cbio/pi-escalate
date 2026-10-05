import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream, getCurrentTools, getSystemMessageText,
  type AssistantMessage, type Context, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  escalate, EscalateError, MAX_MODEL_REQUESTS, MAX_TOOL_CALLS, MAX_TOOL_RESULT_CHARS,
} from "../src/escalate.ts";
import { createInvestigationTools, READ_ONLY_TOOL_NAMES } from "../src/investigation-tools.ts";

const model: Model<"openai-completions"> = {
  provider: "fixture", id: "astra", name: "Astra", api: "openai-completions", baseUrl: "http://unused/v1",
  input: ["text"], reasoning: true, contextWindow: 128_000, maxTokens: 32_768,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const config = { model: "fixture/astra", reasoningLevel: "high" as const };
const SOURCE = "PRIVATE-EVIDENCE: BUGMARK is here.\nconst lostUpdate = true;\n";
const PRIVATE_THINKING = "PRIVATE-INVESTIGATION-THINKING";

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason,
    timestamp: Date.now(), usage: {
      input: 10, output: 20, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, reasoning: 5, totalTokens: 35,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
  };
}
const call = (name: string, args: Record<string, string | number>, id = name) =>
  ({ type: "toolCall" as const, id, name, arguments: args });

function fixture(respond: (index: number, context: Context, options?: SimpleStreamOptions) => AssistantMessage) {
  const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
  const registry = {
    find: () => model, hasConfiguredAuth: () => true,
    streamSimple: (_model: unknown, context: Context, options?: SimpleStreamOptions) => {
      const index = calls.length;
      calls.push({ context, options });
      const response = respond(index, context, options);
      const stream = createAssistantMessageEventStream();
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        stream.push({ type: "error", reason: response.stopReason, error: response });
      } else {
        stream.push({ type: "done", reason: response.stopReason === "length" ? "length" :
          response.stopReason === "toolUse" ? "toolUse" : "stop", message: response });
      }
      return stream;
    },
  } as unknown as ExtensionContext["modelRegistry"];
  return { registry, calls };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "pi-escalate-investigation-"));
  await writeFile(join(dir, "sample.ts"), SOURCE);
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test("denied filesystem paths stay private child evidence without granting another execution", async () => {
  const w = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "pi-outside-evidence-"));
  try {
    const secret = join(outside, "secret.ts");
    await writeFile(secret, "OUTSIDE-PRIVATE-CONTENT");
    const f = fixture((index, context) => {
      if (index === 0) return message(READ_ONLY_TOOL_NAMES.map((name) =>
        call(name, { path: secret, pattern: "*" })), "toolUse");
      const results = context.messages.filter((entry) => entry.role === "toolResult");
      assert.equal(results.length, 4);
      assert(results.every((entry) => entry.isError));
      assert(!JSON.stringify(results).includes("OUTSIDE-PRIVATE-CONTENT"));
      return message([{ type: "text", text: "The files are outside the read boundary; no contents were inspected." }]);
    });
    const result = await escalate({ question: "Q" }, config, f.registry, undefined, w.dir);
    assert.equal(f.calls.length, 2);
    assert.equal(result.usage.totalTokens, 70);
    assert(!JSON.stringify(result).includes("OUTSIDE-PRIVATE-CONTENT"));
    assert(!JSON.stringify(result).includes(outside));
  } finally { await w.dispose(); await rm(outside, { recursive: true, force: true }); }
});

test("Astra uses all four native tools, receives results privately, and returns only the final answer with total usage", async () => {
  const w = await workspace();
  try {
    const f = fixture((index, context) => {
      if (index === 0) return message([
        { type: "thinking", thinking: PRIVATE_THINKING },
        { type: "text", text: "PRIVATE-INTERMEDIATE-ANSWER" },
        call("ls", { path: "." }), call("find", { pattern: "*.ts" }),
        call("grep", { pattern: "BUGMARK", path: "sample.ts" }), call("read", { path: "sample.ts" }),
      ], "toolUse");
      const results = context.messages.filter((entry) => entry.role === "toolResult");
      assert.equal(results.length, 4);
      assert(results.every((entry) => !entry.isError));
      assert(JSON.stringify(results).includes("sample.ts"));
      assert(JSON.stringify(results).includes("PRIVATE-EVIDENCE"));
      return message([{ type: "text", text: "The lost update is in sample.ts:2." }]);
    });
    const before = await readdir(w.dir);
    const result = await escalate({ question: "Investigate sample.ts." }, config, f.registry, undefined, w.dir);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(getCurrentTools(f.calls[0].context.messages).map((tool) => tool.name), READ_ONLY_TOOL_NAMES);
    assert.deepEqual(result.output, { answer: "The lost update is in sample.ts:2.", truncated: false });
    assert.equal(result.usage.totalTokens, 70);
    assert.equal(result.usage.reasoning, 10);
    assert.equal(result.usage.cacheWrite1h, 2);
    assert.equal(result.usage.cost.total, 0.66);
    assert(!JSON.stringify(result).includes(PRIVATE_THINKING));
    assert(!JSON.stringify(result).includes("PRIVATE-INTERMEDIATE-ANSWER"));
    assert(!JSON.stringify(result).includes("PRIVATE-EVIDENCE"));
    assert.deepEqual(await readdir(w.dir), before);
    assert.equal(await readFile(join(w.dir, "sample.ts"), "utf8"), SOURCE);
  } finally { await w.dispose(); }
});

test("each separate investigation starts without previous tool results or conversation", async () => {
  const w = await workspace();
  try {
    const f = fixture(() => message([{ type: "text", text: "Final." }]));
    await escalate({ question: "First private question." }, config, f.registry, undefined, w.dir);
    await escalate({ question: "Second question." }, config, f.registry, undefined, w.dir);
    const second = JSON.stringify(f.calls[1].context);
    assert(!second.includes("First private question"));
    assert(!second.includes("Final."));
    assert(!f.calls[1].context.messages.some((entry) => entry.role === "toolResult"));
  } finally { await w.dispose(); }
});

for (const name of ["bash", "powershell", "edit", "write", "codemode", "escalate", "mcp__fixture__search"]) {
  test("forbidden tool " + name + " fails before execution, including a mixed read/write batch", async () => {
    const w = await workspace();
    try {
      const f = fixture(() => message([
        call("read", { path: "sample.ts" }),
        call(name, { path: "sample.ts", content: "OVERWRITTEN", command: "touch unexpected" }),
      ], "toolUse"));
      await assert.rejects(escalate({ question: "Q" }, config, f.registry, undefined, w.dir), (error: Error) => {
        assert(error instanceof EscalateError);
        assert.match(error.message, /outside the read-only scope/);
        assert.equal(error.usage?.totalTokens, 35);
        return true;
      });
      assert.equal(f.calls.length, 1);
      assert.equal(await readFile(join(w.dir, "sample.ts"), "utf8"), SOURCE);
      assert.deepEqual(await readdir(w.dir), ["sample.ts"]);
    } finally { await w.dispose(); }
  });
}

test("a failed read is tool evidence, not a fabricated success; the target can report the limitation", async () => {
  const w = await workspace();
  try {
    const f = fixture((index, context) => {
      if (index === 0) return message([call("read", { path: "missing.ts" })], "toolUse");
      const result = context.messages.find((entry) => entry.role === "toolResult");
      assert(result?.role === "toolResult" && result.isError);
      return message([{ type: "text", text: "Could not inspect missing.ts; no conclusion is verified." }]);
    });
    const result = await escalate({ question: "Q" }, config, f.registry, undefined, w.dir);
    assert.match(result.output.answer, /no conclusion is verified/);
    assert.equal(f.calls.length, 2);
  } finally { await w.dispose(); }
});

test("model-request cap reserves the last request for a tool-free final report", async () => {
  const w = await workspace();
  try {
    const f = fixture((index, context, options) => {
      if (index < MAX_MODEL_REQUESTS - 1) return message([call("ls", { path: "." }, "ls-" + index)], "toolUse");
      assert.equal(options?.toolChoice, "none");
      assert.equal(getCurrentTools(context.messages).length, 0);
      assert(context.messages.some((entry) => entry.role === "system" && getSystemMessageText(entry).includes("Investigation limit reached")));
      return message([{ type: "text", text: "Best-supported report so far." }]);
    });
    const result = await escalate({ question: "Q" }, config, f.registry, undefined, w.dir);
    assert.equal(f.calls.length, MAX_MODEL_REQUESTS);
    assert.equal(result.usage.totalTokens, MAX_MODEL_REQUESTS * 35);
    assert.equal(result.output.truncated, true);
    assert.match(result.output.answer, /fixed execution limit/);
  } finally { await w.dispose(); }
});

test("tool budget limits execution within a large batch and then requests a final report", async () => {
  const w = await workspace();
  try {
    const count = MAX_TOOL_CALLS + 8;
    const f = fixture((index, context, options) => {
      if (index === 0) return message(Array.from({ length: count }, (_unused, i) =>
        call("ls", { path: "." }, "ls-" + i)), "toolUse");
      const results = context.messages.filter((entry) => entry.role === "toolResult");
      assert.equal(results.filter((entry) => !entry.isError).length, MAX_TOOL_CALLS);
      assert.equal(results.filter((entry) => entry.isError).length, 8);
      assert.equal(options?.toolChoice, "none");
      assert.equal(getCurrentTools(context.messages).length, 0);
      return message([{ type: "text", text: "Limited report." }]);
    });
    const result = await escalate({ question: "Q" }, config, f.registry, undefined, w.dir);
    assert.equal(f.calls.length, 2);
    assert.equal(result.output.truncated, true);
  } finally { await w.dispose(); }
});

test("a rogue final tool call cannot evade the fixed request cap", async () => {
  const w = await workspace();
  try {
    const f = fixture((index) => message([call("ls", { path: "." }, "ls-" + index)], "toolUse"));
    await assert.rejects(escalate({ question: "Q" }, config, f.registry, undefined, w.dir), /completed text answer/);
    assert.equal(f.calls.length, MAX_MODEL_REQUESTS);
  } finally { await w.dispose(); }
});

test("large native tool results are clipped only inside the child and can be inspected with narrower reads", async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.dir, "large.ts"), "PRIVATE-LARGE:" + "x".repeat(MAX_TOOL_RESULT_CHARS * 2));
    const f = fixture((index, context) => {
      if (index === 0) return message([call("read", { path: "large.ts" })], "toolUse");
      const result = context.messages.find((entry) => entry.role === "toolResult");
      assert(result?.role === "toolResult");
      const content = result.content.map((block) => block.type === "text" ? block.text : "").join("\n");
      assert(content.length < MAX_TOOL_RESULT_CHARS + 200);
      assert(content.includes("Tool output clipped"));
      return message([{ type: "text", text: "Final short report." }]);
    });
    const result = await escalate({ question: "Q" }, config, f.registry, undefined, w.dir);
    assert(!JSON.stringify(result).includes("PRIVATE-LARGE"));
  } finally { await w.dispose(); }
});

test("native read omits image attachments for a text-only target", async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.dir, "pixel.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const f = fixture((index, context) => {
      if (index === 0) return message([call("read", { path: "pixel.png" })], "toolUse");
      const result = context.messages.find((entry) => entry.role === "toolResult");
      assert(result?.role === "toolResult" && !result.isError);
      assert(!result.content.some((block) => block.type === "image"));
      assert(JSON.stringify(result.content).includes("Image omitted"));
      return message([{ type: "text", text: "Image cannot be inspected with this model." }]);
    });
    await escalate({ question: "Q" }, config, f.registry, undefined, w.dir);
  } finally { await w.dispose(); }
});

test("cancellation as a response arrives prevents the next provider request", async () => {
  const w = await workspace();
  const controller = new AbortController();
  try {
    const f = fixture(() => {
      queueMicrotask(() => controller.abort());
      return message([call("read", { path: "sample.ts" })], "toolUse");
    });
    await assert.rejects(escalate({ question: "Q" }, config, f.registry, controller.signal, w.dir), /cancelled/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options?.signal?.aborted, true);
    assert.deepEqual(await readdir(w.dir), ["sample.ts"]);
  } finally { await w.dispose(); }
});

test("failure on a later provider turn reports all prior usage without leaking intermediate evidence", async () => {
  const w = await workspace();
  try {
    const f = fixture((index) => index === 0 ? message([call("read", { path: "sample.ts" })], "toolUse") :
      { ...message([], "error"), errorMessage: SOURCE + " PRIVATE-CREDENTIAL" });
    await assert.rejects(escalate({ question: "Q" }, config, f.registry, undefined, w.dir), (error: Error) => {
      assert(error instanceof EscalateError);
      assert.equal(error.usage?.totalTokens, 70);
      assert(!error.message.includes("PRIVATE"));
      return true;
    });
  } finally { await w.dispose(); }
});

test("absent search binaries fail without installing files or attempting a download", async () => {
  const w = await workspace();
  const path = process.env.PATH;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PATH = "";
    process.env.PI_CODING_AGENT_DIR = w.dir;
    const tools = createInvestigationTools(w.dir);
    for (const [name, args] of [["grep", { pattern: "BUGMARK" }], ["find", { pattern: "*.ts" }]] as const) {
      const tool = tools.find((entry) => entry.name === name)!;
      await assert.rejects(tool.execute("call", args), /no download was attempted/);
    }
    assert.deepEqual(await readdir(w.dir), ["sample.ts"]);
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir;
    await w.dispose();
  }
});
