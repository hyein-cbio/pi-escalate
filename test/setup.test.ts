import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { readOptionalConfig, writeConfig } from "../src/config.ts";
import extension from "../src/extension.ts";
import { availableTargets, configureEscalation, SetupPicker } from "../src/setup.ts";

const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Pick<Theme, "fg" | "bold">;
const base: Model<"openai-completions"> = {
  provider: "fixture", id: "astra", name: "Astra", api: "openai-completions", baseUrl: "http://unused/v1",
  input: ["text"], reasoning: true, contextWindow: 128_000, maxTokens: 32_768,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

async function fixture(actions: Array<(picker: SetupPicker) => void>, models: Model<Api>[] = [base]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-escalate-setup-"));
  const file = join(dir, "pi-escalate.json");
  const commands = new Map<string, Command>();
  const tools: ToolDefinition[] = [];
  const notices: string[] = [];
  const screens: string[][] = [];
  let calls = 0;
  let sessionId = "main";
  let idle = true;
  let queued = false;
  const selectedMain = { ...base, id: "sol" };
  const ctx = {
    mode: "tui", hasUI: true, model: selectedMain, thinkingLevel: "low",
    isIdle: () => idle, hasPendingMessages: () => queued,
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: {
      getAvailable: () => models,
      hasConfiguredAuth: (model: Model<Api>) => model.id !== "no-auth",
    },
    ui: {
      notify: (message: string) => notices.push(message),
      custom: (factory: (tui: unknown, theme: unknown, keys: KeybindingsManager, done: (value: unknown) => void) => SetupPicker) =>
        new Promise((resolve, reject) => {
          try {
            const picker = factory({ requestRender: () => {} }, theme, keys, resolve);
            picker.focused = true;
            screens.push(picker.render(100));
            actions[calls++](picker);
          } catch (error) { reject(error); }
        }),
    },
  } as unknown as ExtensionCommandContext;
  let sent = 0;
  extension({
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: () => () => {},
    getActiveTools: () => ["codemode"],
    sendUserMessage: () => { sent++; },
  } as unknown as ExtensionAPI);
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return {
    dir, file, ctx, selectedMain, commands, tools, notices, screens,
    calls: () => calls, sent: () => sent,
    setIdle: (value: boolean) => { idle = value; },
    setQueued: (value: boolean) => { queued = value; },
    setSession: (value: string) => { sessionId = value; },
    invoke: (args = "") => commands.get("escalate-set")!.handler(args, ctx),
    dispose: async () => {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const enter = (picker: SetupPicker) => picker.handleInput("\r");
const cancel = (picker: SetupPicker) => picker.handleInput("\x1b");

function picker(items: SelectItem[], initial?: string, customKeys = keys) {
  const values: Array<string | undefined> = [];
  let renders = 0;
  const component = new SetupPicker("Escalate 설정 🙂", items, initial, theme, customKeys,
    (value) => values.push(value), () => { renders++; });
  return { component, values, renders: () => renders };
}

test("native TUI picker preselects saved model, navigates, filters by substring/name, and confirms", () => {
  const f = picker([
    { value: "provider/alpha", label: "provider/alpha", description: "작은 모델" },
    { value: "provider/astra", label: "provider/astra", description: "큰 모델" },
  ], "provider/astra");
  assert(f.component.render(80).some((line) => line.startsWith("→ provider/astra")));
  f.component.handleInput("\x1b[A");
  assert(f.component.render(80).some((line) => line.startsWith("→ provider/alpha")));
  f.component.handleInput("큰");
  assert(f.component.render(80).some((line) => line.includes("provider/astra")));
  assert(!f.component.render(80).some((line) => line.includes("provider/alpha")));
  enter(f.component);
  enter(f.component);
  assert.deepEqual(f.values, ["provider/astra"]);
  assert(f.renders() > 0);
});

test("empty search results do not confirm; Escape cancels once", () => {
  const f = picker([{ value: "a", label: "a" }]);
  f.component.handleInput("unmatched");
  enter(f.component);
  assert.equal(f.values.length, 0);
  assert(f.component.render(80).some((line) => line.includes("No matching options")));
  cancel(f.component);
  cancel(f.component);
  assert.deepEqual(f.values, [undefined]);
});

test("picker propagates focus/cursor, respects remapped selection keys, and fits narrow/wide/Unicode terminals", () => {
  const remapped = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "ctrl+s" });
  const f = picker([{ value: "한글/🙂", label: "한글/🙂" }], undefined, remapped);
  f.component.focused = true;
  assert.equal(f.component.focused, true);
  for (const width of [1, 2, 8, 20, 80, 140]) {
    for (const line of f.component.render(width)) assert(visibleWidth(line) <= width);
  }
  f.component.invalidate();
  f.component.handleInput("\x13");
  assert.deepEqual(f.values, ["한글/🙂"]);
  f.component.focused = false;
  assert.equal(f.component.focused, false);
});

test("available models are authenticated, physical, sorted, and deduplicated", async () => {
  const f = await fixture([], [
    { ...base, id: "z" }, { ...base, id: "no-auth" }, { ...base, id: "virtual", api: "pi-virtual" },
    { ...base, id: "a" }, { ...base, id: "a" },
  ]);
  try { assert.deepEqual(availableTargets(f.ctx).map((model) => model.id), ["a", "z"]); }
  finally { await f.dispose(); }
});

test("/escalate-set creates exactly two settings after both choices; no model call, main mutation, or authorization", async () => {
  const f = await fixture([enter, enter]);
  try {
    await f.invoke();
    assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { model: "fixture/astra", reasoningLevel: "high" });
    assert.deepEqual((await readdir(f.dir)).sort(), ["pi-escalate.json"]);
    if (process.platform !== "win32") assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal(f.ctx.model, f.selectedMain);
    assert.equal(f.ctx.thinkingLevel, "low");
    assert.equal(f.sent(), 0);
    assert.equal(f.calls(), 2);
    await assert.rejects(f.tools[0].execute("call", { question: "Q" }, undefined, undefined,
      f.ctx as unknown as Parameters<ToolDefinition["execute"]>[4]), /use \/escalate/);
    assert(f.notices.some((notice) => notice.includes("saved fixture/astra")));
  } finally { await f.dispose(); }
});

for (const step of [1, 2]) {
  test("cancelling step " + step + " leaves existing settings byte-for-byte unchanged", async () => {
    const f = await fixture(step === 1 ? [cancel] : [enter, cancel]);
    try {
      const original = '{ "model": "fixture/astra", "reasoningLevel": "low" }\n';
      await writeFile(f.file, original);
      await f.invoke();
      assert.equal(await readFile(f.file, "utf8"), original);
      assert.equal(f.sent(), 0);
      assert.equal(f.calls(), step);
    } finally { await f.dispose(); }
  });
}

test("cancel during first-time setup creates no settings file", async () => {
  const f = await fixture([enter, cancel]);
  try {
    await f.invoke();
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.dispose(); }
});

test("saved values are highlighted and non-reasoning models offer only off", async () => {
  const f = await fixture([enter, enter], [{ ...base, reasoning: false }]);
  try {
    await writeConfig(f.file, { model: "fixture/astra", reasoningLevel: "off" });
    await f.invoke();
    assert(f.screens[0].some((line) => line.startsWith("→ fixture/astra")));
    assert(f.screens[1].some((line) => line.startsWith("→ off")));
    assert(!f.screens[1].some((line) => /^\s*(→ )?(high|max|minimal)\b/.test(line)));
    assert.equal((await readOptionalConfig(f.file))?.reasoningLevel, "off");
  } finally { await f.dispose(); }
});

test("models with a restricted effort map offer only supported choices", async () => {
  const restricted = { ...base, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, xhigh: null, max: null } };
  const f = await fixture([enter, enter], [restricted]);
  try {
    await f.invoke();
    assert(f.screens[1].some((line) => line.startsWith("→ high")));
    assert(!f.screens[1].some((line) => line.trim().startsWith("low")));
    assert.equal((await readOptionalConfig(f.file))?.reasoningLevel, "high");
  } finally { await f.dispose(); }
});

test("invalid settings are preserved on cancel and can be replaced by deliberate selections", async () => {
  const f = await fixture([cancel, enter, enter]);
  try {
    await writeFile(f.file, "invalid private content");
    await f.invoke();
    assert.equal(await readFile(f.file, "utf8"), "invalid private content");
    await f.invoke();
    assert.equal((await readOptionalConfig(f.file))?.model, "fixture/astra");
    assert(!f.notices.some((notice) => notice.includes("private content")));
  } finally { await f.dispose(); }
});

test("empty model list, wrong mode, nonempty args, busy work, or queued input leave settings untouched", async () => {
  const f = await fixture([], []);
  try {
    await f.invoke();
    f.ctx.mode = "rpc";
    await f.invoke();
    f.ctx.mode = "tui";
    await f.invoke("extra argument");
    f.setIdle(false);
    await f.invoke();
    f.setIdle(true);
    f.setQueued(true);
    await f.invoke();
    assert.equal(f.calls(), 0);
    assert.equal(f.sent(), 0);
    assert.deepEqual(await readdir(f.dir), []);
    assert.equal(f.notices.length, 5);
  } finally { await f.dispose(); }
});

test("setup surfaces its own diagnostic errors but sanitizes unrelated exception messages", async () => {
  for (const message of ["pi-escalate: selected model is unavailable.", "unrelated private exception"]) {
    const f = await fixture([() => { throw new Error(message); }]);
    try {
      await f.invoke();
      assert.equal(f.notices.at(-1), message.startsWith("pi-escalate:") ? message :
        "pi-escalate: settings could not be saved. Check configuration directory permissions.");
      assert.deepEqual(await readdir(f.dir), []);
    } finally { await f.dispose(); }
  }
});

test("print-mode setup reports an error rather than invoking unsupported custom UI", async () => {
  const f = await fixture([]);
  try {
    f.ctx.mode = "print";
    f.ctx.hasUI = false;
    await assert.rejects(f.invoke(), /requires Pi TUI mode/);
    assert.equal(f.calls(), 0);
  } finally { await f.dispose(); }
});

test("only one settings flow can be open; /escalate cannot start during it", async () => {
  let activePicker: SetupPicker | undefined;
  const f = await fixture([(picker) => { activePicker = picker; }]);
  try {
    const pending = f.invoke();
    // Wait for the first custom screen to open, without timers or real terminal input.
    while (!activePicker) await new Promise<void>((resolve) => setImmediate(resolve));
    await f.invoke();
    await f.commands.get("escalate")!.handler("Q", f.ctx);
    assert.equal(f.calls(), 1);
    assert.equal(f.sent(), 0);
    cancel(activePicker);
    await pending;
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.dispose(); }
});

for (const change of ["session", "busy", "availability"] as const) {
  test("settings are not saved if " + change + " changes while the TUI is open", async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture([enter, (picker) => {
      if (change === "session") f.setSession("other");
      if (change === "busy") f.setIdle(false);
      if (change === "availability") f.ctx.modelRegistry.hasConfiguredAuth = () => false;
      enter(picker);
    }]);
    try {
      await f.invoke();
      assert.deepEqual(await readdir(f.dir), []);
      assert(f.notices.some((notice) => notice.includes("not saved")));
    } finally { await f.dispose(); }
  });
}

test("atomic writer creates missing parent directories and cleans staging files on rename failure", async () => {
  const f = await fixture([]);
  try {
    const nested = join(f.dir, "nested", "settings.json");
    await writeConfig(nested, { model: "fixture/astra", reasoningLevel: "low" });
    assert.deepEqual(await readdir(join(f.dir, "nested")), ["settings.json"]);
    await mkdir(f.file);
    await assert.rejects(writeConfig(f.file, { model: "fixture/astra", reasoningLevel: "high" }));
    assert.deepEqual((await readdir(f.dir)).sort(), ["nested", "pi-escalate.json"]);
  } finally { await f.dispose(); }
});
