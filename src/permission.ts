import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertRunSignal, assertSessionContext } from "./compatibility.ts";
import type { InvestigationRequest } from "./request.ts";

/** Ephemeral, single-use permission. Never reconstructed from conversation history. */
export class EscalatePermission {
  private pending?: { session: string; prompt: string; input: InvestigationRequest };
  private grant?: { session: string; signal?: AbortSignal; input: InvestigationRequest };

  prepare(session: string, prompt: string, input: InvestigationRequest = { mode: "handoff", request: prompt }): void {
    this.clear();
    this.pending = { session, prompt, input: { ...input } };
  }

  observeInput(text: string, session: string): void {
    if (this.pending?.session !== session || this.pending.prompt !== text) this.clear();
  }

  beforeStart(prompt: string, session: string): void {
    const pending = this.pending;
    const allowed = pending?.session === session && pending.prompt === prompt;
    this.clear();
    if (allowed) this.grant = { session, input: pending.input };
  }

  start(ctx: ExtensionContext): void {
    // Ordinary parent runs need no escalation-specific signal checks.
    if (!this.grant) return;
    try {
      assertSessionContext(ctx);
      assertRunSignal(ctx.signal);
    } catch (error) {
      this.clear();
      throw error;
    }
    if (this.grant.session !== ctx.sessionManager.getSessionId() || !ctx.signal || ctx.signal.aborted) {
      this.clear();
      return;
    }
    this.grant.signal = ctx.signal;
  }

  consume(ctx: ExtensionContext): InvestigationRequest {
    const grant = this.grant;
    if (!grant || !grant.signal || grant.signal.aborted || grant.signal !== ctx.signal ||
      grant.session !== ctx.sessionManager.getSessionId()) {
      throw new Error("pi-escalate: use /escalate <request> to authorize one read-only investigation.");
    }
    // Consume synchronously, before any asynchronous work or provider call.
    this.clear();
    return grant.input;
  }

  clear(): void {
    this.pending = undefined;
    this.grant = undefined;
  }
}
