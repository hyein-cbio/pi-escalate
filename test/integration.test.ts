import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext, type Theme,
} from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE = "PRIVATE-REFERENCE:" + "x".repeat(20_000);
const PRIVATE_THINKING = "PRIVATE-TARGET-THINKING";
const ANSWER = "The race is between the read and write.";

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name: string } }>;
  reasoning_effort?: string;
  tool_choice?: string;
}

function sendAnswer(res: ServerResponse, model: string, delta: object, finish = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (value: object) => res.write("data: " + JSON.stringify(value) + "\n\n");
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
  chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  chunk({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  res.end("data: [DONE]\n\n");
}

async function scenario(targetFails: boolean, invokeCommand = true, attemptTwice = false, configureFirst = false, investigate = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-escalate-integration-"));
  const cwd = join(dir, "workspace");
  const agentDir = join(dir, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(join(cwd, "reference.txt"), REFERENCE);
  await writeFile(join(agentDir, "pi-escalate.json"), JSON.stringify({
    model: "fixture/astra", reasoningLevel: "high",
  }));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const requests: RequestBody[] = [];
  const script = [
    'const context = await tools.read({ path: "reference.txt" });',
    'const result = await tools.escalate({ question: "Where is the race?", context });',
    'text(result.answer);',
    ...(attemptTwice ? [
      'try { await tools.escalate({ question: "An unapproved second question." }); }',
      'catch (error) { text("SECOND-BLOCKED: " + error.message); }',
    ] : []),
  ].join("\n");

  let parentCalls = 0;
  let childCalls = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const part of req) body += part;
      const request = JSON.parse(body) as RequestBody;
      requests.push(request);
      if (request.model === "astra") {
        if (targetFails) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: REFERENCE + " PRIVATE-KEY", type: "invalid_request_error" } }));
        } else if (investigate && childCalls++ === 0) {
          sendAnswer(res, "astra", {
            reasoning_content: PRIVATE_THINKING, content: "PRIVATE-INTERMEDIATE",
            tool_calls: [
              ["ls", { path: "." }], ["find", { pattern: "*.txt" }],
              ["grep", { pattern: "PRIVATE-REFERENCE", path: "reference.txt" }],
              ["read", { path: "reference.txt" }],
            ].map(([name, args], index) => ({
              index, id: "child-" + name, type: "function",
              function: { name, arguments: JSON.stringify(args) },
            })),
          }, "tool_calls");
        } else {
          if (investigate) {
            assert.equal(request.messages.filter((message) => message.role === "tool").length, 4);
            assert(JSON.stringify(request.messages).includes("PRIVATE-REFERENCE"));
          }
          sendAnswer(res, "astra", { reasoning_content: PRIVATE_THINKING, content: ANSWER });
        }
      } else if (parentCalls++ === 0) {
        sendAnswer(res, "sol", { tool_calls: [{
          index: 0, id: "codemode-call", type: "function",
          function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
        }] }, "tool_calls");
      } else {
        sendAnswer(res, "sol", { content: "Done." });
      }
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    runtime.registerProvider("fixture", {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-key",
      models: ["sol", "astra"].map((id) => ({
        id, name: id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 32_768,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsReasoningEffort: true, supportsStore: true },
      })),
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ["codemode", "read"],
    });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(root, "src/index.ts")],
      extensionFactories: [createCodemodeExtension({ mode: "only", models: false })],
      systemPrompt: "Use codemode once, then finish.",
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(cwd);
    ({ session } = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("fixture", "sol")!,
      thinkingLevel: "off", sessionManager: manager, settingsManager, resourceLoader: loader,
    }));
    const commandErrors: string[] = [];
    let settingScreens = 0;
    const uiContext = {
      notify: () => {},
      custom: async (factory: (tui: TUI, theme: Theme, keys: KeybindingsManager,
        done: (value: unknown) => void) => Component) => {
        const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;
        let done: (value: unknown) => void = () => {};
        const result = new Promise((resolve) => { done = resolve; });
        const picker = await factory({ requestRender: () => {} } as TUI, theme,
          new KeybindingsManager(TUI_KEYBINDINGS), done);
        assert(picker.render(80).some((line) => line.includes("Escalate settings")));
        settingScreens++;
        picker.handleInput!("\r");
        return result;
      },
    } as unknown as ExtensionUIContext;
    await session.bindExtensions(configureFirst ? {
      mode: "tui", uiContext, onError: (error) => commandErrors.push(error.error),
    } : {});
    if (configureFirst) {
      const mainModel = session.model;
      const mainThinking = session.thinkingLevel;
      const messages = JSON.stringify(session.messages);
      await session.prompt("/escalate-set");
      assert.deepEqual(commandErrors, []);
      assert.equal(settingScreens, 2);
      assert.equal(session.model, mainModel);
      assert.equal(session.thinkingLevel, mainThinking);
      assert.equal(JSON.stringify(session.messages), messages);
      assert.equal(requests.length, 0);
    }
    const beforeFiles = (await readdir(dir, { recursive: true })).sort();
    const selectedModel = session.model;
    const selectedThinking = session.thinkingLevel;
    let unsubscribe = () => {};
    const settled = new Promise<void>((resolve) => {
      unsubscribe = session!.subscribe((event) => {
        if (event.type === "agent_settled") { unsubscribe(); resolve(); }
      });
    });
    await session.prompt((invokeCommand ? "/escalate " : "") + "MAIN-PRIVATE-HISTORY: investigate the race.");
    // Slash commands dispatch a new run through sendUserMessage; await its final settlement.
    await settled;

    assert.equal(session.getLastAssistantText(), "Done.");
    assert.equal(session.model, selectedModel);
    assert.equal(session.thinkingLevel, selectedThinking);
    assert(!session.getActiveToolNames().includes("escalate"));
    assert.equal(manager.getSessionFile(), undefined);
    assert.deepEqual((await readdir(dir, { recursive: true })).sort(), beforeFiles);

    const target = requests.filter((request) => request.model === "astra");
    assert.equal(target.length, invokeCommand ? (investigate && !targetFails ? 2 : 1) : 0);
    for (const request of target) {
      assert.equal(request.reasoning_effort, "high");
      assert.deepEqual(request.tools?.map((tool) => tool.function?.name), ["read", "grep", "find", "ls"]);
      assert(!JSON.stringify(request).includes("MAIN-PRIVATE-HISTORY"));
      assert.equal(request.messages.filter((message) => message.role === "user").length, 1);
    }
    if (invokeCommand) assert(JSON.stringify(target[0]).includes("PRIVATE-REFERENCE"));

    const parents = requests.filter((request) => request.model === "sol");
    assert.equal(parents.length, 2);
    assert(!parents[0].tools?.some((tool) => tool.function?.name === "escalate"));
    const continuation = JSON.stringify(parents[1]);
    assert(!continuation.includes("PRIVATE-REFERENCE"));
    assert(!continuation.includes(PRIVATE_THINKING));
    assert(!continuation.includes("PRIVATE-INTERMEDIATE"));
    assert(!continuation.includes("child-read"));
    assert(!continuation.includes("PRIVATE-KEY"));
    const toolResult = session.messages.find((message) => message.role === "toolResult");
    assert(toolResult && toolResult.role === "toolResult");
    const parentTranscript = JSON.stringify(session.messages);
    // Pi retains bounded argument previews as UI metadata, not model context.
    assert(!parentTranscript.includes(REFERENCE));
    const details = toolResult.details as { calls: Array<{ args: string }> };
    assert(details.calls.every((call) => call.args.length <= 200));
    assert(!parentTranscript.includes(PRIVATE_THINKING));
    assert(!parentTranscript.includes("PRIVATE-KEY"));
    assert.equal(session.messages.filter((message) => message.role === "toolResult").length, 1);
    for (const message of session.messages) {
      if (message.role === "assistant") assert.equal(message.model, "sol");
    }
    if (!invokeCommand) {
      assert(continuation.includes("use /escalate"));
      assert(!continuation.includes(ANSWER));
    } else if (targetFails) {
      assert(continuation.includes("did not return a completed text answer"));
    } else {
      assert(continuation.includes(ANSWER));
      assert.equal(toolResult.usage?.totalTokens, investigate ? 60 : 30);
      if (attemptTwice) assert(continuation.includes("SECOND-BLOCKED"));
    }
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
}

test("real Pi + codemode + HTTP: isolated consultations, unchanged main model, bounded parent context, no child files",
  { timeout: 30_000 }, () => scenario(false));
test("real Pi + codemode + HTTP: provider failures do not retry or leak context into the parent",
  { timeout: 30_000 }, () => scenario(true));
test("real Pi + codemode + HTTP: autonomous calls without /escalate never reach the target",
  { timeout: 30_000 }, () => scenario(false, false));
test("real Pi + codemode + HTTP: /escalate authorizes exactly one call, even in the same script",
  { timeout: 30_000 }, () => scenario(false, true, true));
test("real Pi loader + settings TUI: lazy UI loads, saves without model calls or context, and never authorizes escalation",
  { timeout: 30_000 }, () => scenario(false, false, false, true));
test("real Pi + codemode + HTTP: Astra investigates with four native tools; only its final answer reaches Sol",
  { timeout: 30_000 }, () => scenario(false, true, false, false, true));
