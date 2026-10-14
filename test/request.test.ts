import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchPrompt, investigationInput, MIN_CONTEXT_BYTES, parseCommand } from "../src/request.ts";

for (const [args, expected] of [
  ["Inspect src/foo.ts", { kind: "investigate", mode: "handoff", request: "Inspect src/foo.ts" }],
  ["  min\nInspect src/foo.ts  ", { kind: "investigate", mode: "min", request: "Inspect src/foo.ts" }],
  [" set ", { kind: "set" }],
  ["minimum context", { kind: "investigate", mode: "handoff", request: "minimum context" }],
  ["settings format", { kind: "investigate", mode: "handoff", request: "settings format" }],
  ["handoff review", { kind: "investigate", mode: "handoff", request: "handoff review" }],
] as const) {
  test("command parses only exact subcommand words: " + JSON.stringify(args), () => {
    assert.deepEqual(parseCommand(args), expected);
  });
}
for (const args of ["", " \n ", "min", "min \n ", "set extra", "set min Q"]) {
  test("invalid command arguments fail without authorization: " + JSON.stringify(args), () => {
    assert.throws(() => parseCommand(args), /Usage: \/escalate/);
  });
}

test("default handoff explicitly separates evidence, hypotheses, assessment and unresolved questions", () => {
  const prompt = dispatchPrompt({ mode: "handoff", request: "Q" });
  for (const part of ["rich", "structured handoff", "requirements", "confirmed facts with evidence",
    "attempted approaches", "current assessment", "unresolved questions", "never forward the raw conversation", "verify"]) {
    assert(prompt.includes(part), part);
  }
});

test("min dispatch respects caller judgment, mandates UTF-8 bound and prohibits question bypass", () => {
  const prompt = dispatchPrompt({ mode: "min", request: "Q" });
  for (const part of ["500 UTF-8 bytes", "verbatim", "Respect the main model's current assessment", "Do not move extra context into question"]) {
    assert(prompt.includes(part), part);
  }
});

const authorized = { mode: "min" as const, request: "Original request." };
for (const context of [undefined, "", "a".repeat(500), "가".repeat(166) + "ab", "🙂".repeat(125)]) {
  test("min accepts at most 500 UTF-8 bytes and pins the original question: " + (context?.length ?? "omitted"), () => {
    assert.deepEqual(investigationInput({ question: "Extra hidden context!", context }, authorized),
      { question: authorized.request, context });
    assert(Buffer.byteLength(context ?? "", "utf8") <= MIN_CONTEXT_BYTES);
  });
}
for (const context of ["a".repeat(501), "가".repeat(167), "🙂".repeat(126)]) {
  test("min rejects oversized Unicode context, never truncating or echoing it: " + context.length, () => {
    assert.throws(() => investigationInput({ question: "Q", context }, authorized), (error: Error) => {
      assert.match(error.message, /500 UTF-8 bytes/);
      assert(!error.message.includes(context));
      return true;
    });
  });
}

test("handoff allows rich reference data and a self-contained prepared question", () => {
  const input = { question: "Prepared question", context: "x".repeat(20_000) };
  assert.deepEqual(investigationInput(input, { mode: "handoff", request: "Original request" }), input);
});
