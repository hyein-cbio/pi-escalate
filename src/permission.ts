import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Ephemeral, single-use permission. Never reconstructed from conversation history. */
export class EscalatePermission {
  private pending?: { session: string; prompt: string };
  private grant?: { session: string; signal?: AbortSignal };

  prepare(session: string, prompt: string): void {
    this.clear();
    this.pending = { session, prompt };
  }

  observeInput(text: string, session: string): void {
    if (this.pending?.session !== session || this.pending.prompt !== text) this.clear();
  }

  beforeStart(prompt: string, session: string): void {
    const allowed = this.pending?.session === session && this.pending.prompt === prompt;
    this.clear();
    if (allowed) this.grant = { session };
  }

  start(ctx: ExtensionContext): void {
    if (this.grant?.session !== ctx.sessionManager.getSessionId() || !ctx.signal || ctx.signal.aborted) {
      this.clear();
      return;
    }
    this.grant.signal = ctx.signal;
  }

  consume(ctx: ExtensionContext): void {
    const grant = this.grant;
    if (!grant || !grant.signal || grant.signal.aborted || grant.signal !== ctx.signal ||
      grant.session !== ctx.sessionManager.getSessionId()) {
      throw new Error("pi-escalate: use /escalate <request> to authorize one consultation.");
    }
    // Consume synchronously, before any asynchronous work or provider call.
    this.clear();
  }

  clear(): void {
    this.pending = undefined;
    this.grant = undefined;
  }
}
