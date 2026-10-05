import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bootstrap from "../src/index.ts";
import {
  assertCommandContext, assertFunctions, assertHostVersion, assertRegistry, assertRunSignal,
  MIN_PI_VERSION, SUPPORTED_PI_RANGE,
} from "../src/compatibility.ts";
import { escalate } from "../src/escalate.ts";
import { EscalatePermission } from "../src/permission.ts";

test("runtime policy accepts the floor, stable future 1.x minors, and SemVer build metadata", () => {
  assert.equal(MIN_PI_VERSION, "0.99.0");
  assert.equal(SUPPORTED_PI_RANGE, ">=0.99.0 <0.100.0 || >=1.0.0 <2.0.0");
  for (const version of ["0.99.0", "0.99.2", "0.99.99", "1.0.0", "1.0.3", "1.1.0", "1.99.7",
    "1.0.3+custom", "1.1.0+build.001"]) assertHostVersion(version);
});

test("unsupported old/major/pre-1 minor versions, prereleases, and malformed versions fail clearly", () => {
  for (const version of ["0.87.1", "0.98.99", "0.100.0", "2.0.0", "1.0.3-rc.1", "1.1.0-beta+build",
    "v1.0.3", "01.0.3", "1.0.03", "1.0", "1.0.0+", "1.0.0+bad..id", "garbage", undefined, null]) {
    assert.throws(() => assertHostVersion(version), /incompatible Pi host.*Install a supported Pi release/);
  }
});

test("host-supplied peers remain wildcard, lockfile agrees, and compatibility docs ship", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
    assert.equal(pkg.peerDependencies[`@earendil-works/${name}`], "*");
  }
  assert.equal(pkg.peerDependencies.typebox, "*");
  assert.deepEqual(lock.packages[""].peerDependencies, pkg.peerDependencies);
  assert(pkg.files.includes("COMPATIBILITY.md"));
});

test("public bootstrap rejects missing registration APIs before registering or dispatching anything", async () => {
  let registrations = 0;
  const api = {
    registerCommand: () => registrations++, registerTool: () => registrations++, on: () => registrations++,
    sendUserMessage: () => { throw new Error("must not dispatch"); },
  } as unknown as ExtensionAPI;
  await assert.rejects(bootstrap(api), /missing ExtensionAPI.getActiveTools/);
  assert.equal(registrations, 0);
});

test("public bootstrap registers unchanged commands/tool without making a model call or session record", async () => {
  const commands: string[] = [];
  const tools: string[] = [];
  await bootstrap({
    registerCommand: (name: string) => commands.push(name),
    registerTool: (tool: { name: string }) => tools.push(tool.name), on: () => () => {},
    getActiveTools: () => ["codemode"],
    sendUserMessage: () => { throw new Error("bootstrap must not dispatch"); },
  } as unknown as ExtensionAPI);
  assert.deepEqual(commands, ["escalate-set", "escalate"]);
  assert.deepEqual(tools, ["escalate"]);
});

test("missing constructor hooks are diagnosed, not accepted as an unbounded investigator", () => {
  assert.throws(() => assertFunctions({ beforeToolCall() {}, afterToolCall() {} },
    ["prepareRequest", "finishTurn", "beforeToolCall", "afterToolCall"], "Agent"),
    /missing Agent.prepareRequest, Agent.finishTurn/);
});

test("essential context, signal, registry, and lazy TUI APIs identify the missing capability", () => {
  assert.throws(() => assertFunctions({}, ["defineTool"], "pi-coding-agent"), /pi-coding-agent.defineTool/);
  assert.throws(() => assertCommandContext({}), /context.isIdle.*context.hasPendingMessages/);
  assert.throws(() => assertCommandContext({ isIdle() {}, hasPendingMessages() {} }), /sessionManager.getSessionId/);
  assert.throws(() => assertRunSignal(undefined), /context.signal.throwIfAborted/);
  assert.throws(() => assertRunSignal({ throwIfAborted() {}, addEventListener() {}, removeEventListener() {} }),
    /context.signal.aborted/);
  assert.throws(() => assertFunctions({}, ["matches", "getKeys"], "keybindings"), /keybindings.matches/);
  assert.throws(() => assertRegistry({ find() {}, hasConfiguredAuth() {} }), /modelRegistry.streamSimple/);
  assert.throws(() => assertRegistry({}, true), /modelRegistry.getAvailable/);
});

test("an ordinary parent run with no grant performs no escalation-specific signal validation", () => {
  const permission = new EscalatePermission();
  const ctx = { sessionManager: { getSessionId: () => "a" }, signal: undefined } as unknown as ExtensionContext;
  assert.doesNotThrow(() => permission.start(ctx));
  assert.throws(() => permission.consume(ctx), /use \/escalate/);
});

test("missing signal in an explicitly authorized run diagnoses the host and revokes permission", () => {
  const permission = new EscalatePermission();
  const ctx = { sessionManager: { getSessionId: () => "a" }, signal: undefined } as unknown as ExtensionContext;
  permission.prepare("a", "request");
  permission.beforeStart("request", "a");
  assert.throws(() => permission.start(ctx), /incompatible Pi host.*context.signal/);
  assert.throws(() => permission.consume(ctx), /use \/escalate/);
});

test("missing registry streaming is diagnosed before lookup/auth/request and outside provider-error sanitization", async () => {
  let calls = 0;
  const registry = { find() { calls++; }, hasConfiguredAuth() { calls++; } };
  await assert.rejects(escalate({ question: "Q" }, { model: "fixture/astra", reasoningLevel: "high" },
    registry as unknown as Parameters<typeof escalate>[2]),
    /incompatible Pi host.*modelRegistry.streamSimple/);
  assert.equal(calls, 0);
});
