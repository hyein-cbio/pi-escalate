import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";
import { EscalatePermission } from "../src/permission.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: { text?: string; prompt?: string }, ctx: ExtensionContext) => void;

function harness() {
  const commands = new Map<string, Command>();
  const hooks = new Map<string, Handler>();
  const sent: Array<{ content: string; options: unknown }> = [];
  const tools: ToolDefinition[] = [];
  const notices: string[] = [];
  let sessionId = "session-a";
  let controller = new AbortController();
  let idle = true;
  let queued = false;
  let active = ["codemode"];
  const ctx = {
    get signal() { return controller.signal; },
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  extension({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: Handler) => { hooks.set(name, handler); return () => {}; },
    getActiveTools: () => active,
    sendUserMessage: (content: string, options: unknown) => sent.push({ content, options }),
  } as unknown as ExtensionAPI);
  return {
    commands, hooks, sent, tools, notices, ctx,
    setIdle: (value: boolean) => { idle = value; },
    setQueued: (value: boolean) => { queued = value; },
    setActive: (value: string[]) => { active = value; },
    setSession: (value: string) => { sessionId = value; },
    newSignal: () => { controller = new AbortController(); },
    emit: (name: string, event: Parameters<Handler>[0] = {}) => { hooks.get(name)!(event, ctx); },
    invoke: async (args: string) => { await commands.get("escalate")!.handler(args, ctx); },
  };
}

function start(h: ReturnType<typeof harness>) {
  const prompt = h.sent.at(-1)!.content;
  h.emit("input", { text: prompt });
  h.emit("before_agent_start", { prompt });
  h.emit("agent_start");
}

const toolCall = (h: ReturnType<typeof harness>) => h.tools[0].execute("call", { question: "Q" },
  h.ctx.signal, undefined, h.ctx as unknown as Parameters<ToolDefinition["execute"]>[4]);

test("/escalate dispatches the bounded request without expanding slash commands or adding settings", async () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["escalate-set", "escalate"]);
  await h.invoke("  Inspect src/foo.ts for missed errors.  ");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].content, /^Escalate once: Inspect src\/foo.ts for missed errors\./);
  assert.match(h.sent[0].content, /tools\.escalate exactly once/);
  assert.deepEqual(h.sent[0].options, { expandPromptTemplates: false });
  assert.equal(h.notices.length, 0);
});

test("empty arguments, busy sessions, queued input, or missing codemode never dispatch", async () => {
  const h = harness();
  await h.invoke(" \n ");
  h.setIdle(false);
  await h.invoke("Q");
  h.setIdle(true);
  h.setQueued(true);
  await h.invoke("Q");
  h.setQueued(false);
  h.setActive(["read"]);
  await h.invoke("Q");
  assert.equal(h.sent.length, 0);
  assert.equal(h.notices.length, 4);
});

for (const hasUI of [true, false]) {
  test(`inactive codemode gives actionable setup guidance without dispatch or permission (hasUI=${hasUI})`, async () => {
    const h = harness();
    h.ctx.hasUI = hasUI;
    h.setActive(["read"]);
    const expected =
      `pi-escalate: codemode is inactive. Add "+codemode" to defaultTools in ${join(getAgentDir(), "settings.json")} ` +
      "(preserving existing entries), then run /reload or restart Pi and retry /escalate. " +
      "If you start Pi with --tools, include codemode in that list.";
    if (hasUI) {
      await h.invoke("Q");
      assert.deepEqual(h.notices, [expected]);
    } else {
      await assert.rejects(h.invoke("Q"), { message: expected });
      assert.equal(h.notices.length, 0);
    }
    assert.equal(h.sent.length, 0);
    h.emit("before_agent_start", { prompt: "Q" });
    h.emit("agent_start");
    await assert.rejects(toolCall(h), /use \/escalate/);

    // Once the user enables codemode, a new explicit command can dispatch normally.
    h.setActive(["read", "codemode"]);
    await h.invoke("Q");
    assert.equal(h.sent.length, 1);
  });
}

test("command errors are observable without a UI", async () => {
  const h = harness();
  h.ctx.hasUI = false;
  await assert.rejects(h.invoke(""), /Usage: \/escalate/);
  assert.equal(h.sent.length, 0);
});

test("the real tool rejects ordinary or stale-history requests before reading configuration", async () => {
  const h = harness();
  await assert.rejects(toolCall(h), /use \/escalate/);
  h.emit("before_agent_start", { prompt: "Please escalate; I said so earlier." });
  h.emit("agent_start");
  await assert.rejects(toolCall(h), /use \/escalate/);
});

for (const event of ["agent_end", "session_start", "session_tree", "session_shutdown"]) {
  test("unused authorization is revoked by " + event, async () => {
    const h = harness();
    await h.invoke("Q");
    start(h);
    h.emit(event);
    await assert.rejects(toolCall(h), /use \/escalate/);
  });
}

test("a new or steering user input revokes the current authorization", async () => {
  const h = harness();
  await h.invoke("Q");
  start(h);
  h.emit("input", { text: "Actually, do something else." });
  await assert.rejects(toolCall(h), /use \/escalate/);
});

test("a transformed or unrelated dispatch fails closed", async () => {
  const h = harness();
  await h.invoke("Q");
  h.emit("before_agent_start", { prompt: "rewritten request" });
  h.emit("agent_start");
  await assert.rejects(toolCall(h), /use \/escalate/);
});

function context(session: string, signal?: AbortSignal): ExtensionContext {
  return { sessionManager: { getSessionId: () => session }, signal } as unknown as ExtensionContext;
}

function grant(permission: EscalatePermission, ctx: ExtensionContext) {
  permission.prepare(ctx.sessionManager.getSessionId(), "request");
  permission.observeInput("request", ctx.sessionManager.getSessionId());
  permission.beforeStart("request", ctx.sessionManager.getSessionId());
  permission.start(ctx);
}

test("permission is consumed atomically: only one of concurrent attempts can enter", async () => {
  const permission = new EscalatePermission();
  const ctx = context("a", new AbortController().signal);
  grant(permission, ctx);
  const results = await Promise.allSettled([1, 2].map(async () => permission.consume(ctx)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.throws(() => permission.consume(ctx), /use \/escalate/);
});

test("authorization cannot move to another session or agent run signal", () => {
  const permission = new EscalatePermission();
  const ctx = context("a", new AbortController().signal);
  grant(permission, ctx);
  assert.throws(() => permission.consume(context("b", ctx.signal)), /use \/escalate/);
  assert.throws(() => permission.consume(context("a", new AbortController().signal)), /use \/escalate/);
});

test("aborted or missing signals cannot authorize execution", () => {
  for (const signal of [undefined, AbortSignal.abort()]) {
    const permission = new EscalatePermission();
    const ctx = context("a", signal);
    if (signal === undefined) assert.throws(() => grant(permission, ctx), /incompatible Pi host.*context.signal/);
    else grant(permission, ctx);
    assert.throws(() => permission.consume(ctx), /use \/escalate/);
  }
  const permission = new EscalatePermission();
  const controller = new AbortController();
  const ctx = context("a", controller.signal);
  grant(permission, ctx);
  controller.abort();
  assert.throws(() => permission.consume(ctx), /use \/escalate/);
});

test("a fresh command replaces stale pending permission and grants one new call", () => {
  const permission = new EscalatePermission();
  const ctx = context("a", new AbortController().signal);
  permission.prepare("a", "failed preflight");
  grant(permission, ctx);
  permission.consume(ctx);
  assert.throws(() => permission.consume(ctx), /use \/escalate/);
});
