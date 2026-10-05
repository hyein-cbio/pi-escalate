/** Host peers remain "*"; the public bootstrap enforces this runtime policy. */
export const MIN_PI_VERSION = "0.99.0";
export const SUPPORTED_PI_RANGE = ">=0.99.0 <0.100.0 || >=1.0.0 <2.0.0";

export function incompatibleHost(reason: string): never {
  throw new Error(`pi-escalate: incompatible Pi host (${reason}). Requires Pi ${SUPPORTED_PI_RANGE} with the host's matching Pi packages. Install a supported Pi release and restart Pi.`);
}

export function assertHostVersion(version: unknown): void {
  // Stable SemVer only. Build metadata does not change compatibility; prereleases do.
  const match = typeof version === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || !((match[1] === "0" && match[2] === "99") || match[1] === "1")) {
    const label = typeof version === "string" ? JSON.stringify(version.slice(0, 80)) : "unrecognized version";
    incompatibleHost(`unsupported version ${label}`);
  }
}

export function assertFunctions(value: unknown, names: readonly string[], label: string): void {
  const object = value as Record<string, unknown> | null | undefined;
  const missing = names.filter((name) => typeof object?.[name] !== "function");
  if (missing.length) incompatibleHost(`missing ${missing.map((name) => `${label}.${name}`).join(", ")}`);
}

export function assertSessionContext(ctx: unknown): void {
  assertFunctions((ctx as { sessionManager?: unknown })?.sessionManager, ["getSessionId"], "sessionManager");
}

export function assertCommandContext(ctx: unknown): void {
  assertFunctions(ctx, ["isIdle", "hasPendingMessages"], "context");
  assertSessionContext(ctx);
  const context = ctx as { hasUI?: boolean; ui?: unknown };
  if (context.hasUI) assertFunctions(context.ui, ["notify"], "UI");
}

export function assertRunSignal(signal: unknown): void {
  assertFunctions(signal, ["throwIfAborted", "addEventListener", "removeEventListener"], "context.signal");
  if (typeof (signal as { aborted?: unknown }).aborted !== "boolean") incompatibleHost("missing context.signal.aborted");
}

export function assertRegistry(registry: unknown, settings = false): void {
  assertFunctions(registry, settings ? ["getAvailable", "hasConfiguredAuth"] :
    ["find", "hasConfiguredAuth", "streamSimple"], "modelRegistry");
}
