import { Buffer } from "node:buffer";
import type { EscalateInput } from "./escalate.ts";

export const MIN_CONTEXT_BYTES = 500;
export interface InvestigationRequest {
  mode: "handoff" | "min";
  request: string;
}
export type EscalateCommand = { kind: "set" } | ({ kind: "investigate" } & InvestigationRequest);

export function parseCommand(args: string): EscalateCommand {
  const text = args.trim();
  const [first] = text.split(/\s+/, 1);
  if (first === "set") {
    if (text !== "set") throw new Error("Usage: /escalate set");
    return { kind: "set" };
  }
  const mode = first === "min" ? "min" : "handoff";
  const request = mode === "min" ? text.slice(3).trim() : text;
  if (!request) throw new Error("Usage: /escalate <request> | /escalate min <request> | /escalate set");
  return { kind: "investigate", mode, request };
}

export function dispatchPrompt(input: InvestigationRequest): string {
  const preparation = input.mode === "handoff" ? [
    "Mode: handoff (default). Prepare rich, relevant context as a structured handoff for the oracle model.",
    "Include the goal, user requirements and constraints, relevant files/functions, confirmed facts with evidence, attempted approaches and their outcomes, the main model's current assessment, and unresolved questions.",
    "Clearly separate verified facts from hypotheses and unverified claims. Omit irrelevant history and secrets; summarize, never forward the raw conversation.",
    "Make the question self-contained. The investigator should verify the handoff's claims independently where possible.",
  ] : [
    `Mode: min. Use the user's request verbatim as question. Additional context is optional and must be at most ${MIN_CONTEXT_BYTES} UTF-8 bytes, not characters.`,
    "Respect the main model's current assessment: briefly supply it as reference if relevant, with only indispensable constraints or file paths. Do not prepare a rich handoff or prefetch whole files.",
    "Do not move extra context into question to evade the byte limit; the executor uses the original user request as question. Oversized context is rejected, not silently truncated, and consumes this one-call permission.",
  ];
  return [
    `Escalate once: ${input.request}`,
    "Use codemode to prepare the requested context and call tools.escalate exactly once.",
    ...preparation,
    "The investigator can use read, grep, find, and ls in this working directory. Prefer evidence pointers over unnecessary file dumps.",
    "Do not print reference data. Print result.answer and note result.truncated if true.",
    "Summarize briefly without duplicating long output; do not implement fixes.",
    "If required context is unclear, ask the user instead of guessing or making an unrelated call.",
  ].join("\n");
}

/** Enforce the authorized mode, not a model-supplied per-call override. */
export function investigationInput(input: EscalateInput, authorized: InvestigationRequest): EscalateInput {
  if (authorized.mode === "handoff") return input;
  if (Buffer.byteLength(input.context ?? "", "utf8") > MIN_CONTEXT_BYTES) {
    throw new Error(`pi-escalate: /escalate min context must not exceed ${MIN_CONTEXT_BYTES} UTF-8 bytes. Use /escalate min again with shorter context, or /escalate for a rich handoff.`);
  }
  return { ...input, question: authorized.request };
}
