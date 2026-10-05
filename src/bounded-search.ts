import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ReadBoundary } from "./read-boundary.ts";

const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_RESULTS = 1_000;

interface SearchOutput { stdout: string; clipped: boolean; partial: boolean }

async function run(binary: string, args: string[], root: string, signal?: AbortSignal, emptyStatusOne = false): Promise<SearchOutput> {
  signal?.throwIfAborted();
  const env = { ...process.env };
  // No inherited ripgrep preprocessors, follow flags, or arbitrary extra options.
  delete env.RIPGREP_CONFIG_PATH;
  return new Promise((resolveResult, reject) => {
    execFile(binary, args, {
      cwd: root, encoding: "utf8", env, signal, maxBuffer: MAX_BUFFER, timeout: 900_000,
    }, (error, stdout, stderr) => {
      if (signal?.aborted) { reject(new Error("Operation aborted")); return; }
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const clipped = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && !!error?.message.startsWith("stdout");
      // ripgrep uses status 1 for an empty result, unlike fd.
      const emptyResult = emptyStatusOne && Number(code) === 1;
      // rg exits 2 (fd exits non-zero) on traversal errors even when results were produced.
      const partial = !!error && !clipped && !emptyResult && typeof code === "number" && stdout.length > 0;
      if (error && !clipped && !emptyResult && !partial) {
        reject(new Error(`Read-only search failed: ${(stderr || error.message).slice(0, 500)}`));
        return;
      }
      resolveResult({ stdout, clipped, partial });
    });
  });
}

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ?
    Math.max(1, Math.min(MAX_RESULTS, Math.floor(value))) : fallback;
}

function result(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

/** Controlled no-follow fd invocation; escaped/broken links are omitted, not fatal. */
export async function boundedFind(
  binary: string, args: Record<string, unknown>, path: string, boundary: ReadBoundary, signal?: AbortSignal,
): Promise<AgentToolResult<undefined>> {
  if (typeof args.pattern !== "string") throw new Error("Invalid find pattern.");
  const maximum = limit(args.limit, 1_000);
  let pattern = args.pattern;
  const flags = ["--glob", "--color=never", "--hidden", "--no-follow", "--no-require-git", "--print0",
    "--max-results", String(maximum + 1)];
  if (pattern.includes("/")) {
    flags.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pattern = `**/${pattern}`;
    if (process.platform === "win32") pattern = pattern.replaceAll("/", String.raw`[/\\]`);
  }
  flags.push("--", pattern, path);
  const output = await run(binary, flags, boundary.root, signal);
  const entries = output.stdout.split("\0");
  if (entries.at(-1) !== "") entries.pop(); // Discard a partial pathname after output clipping.
  const found: string[] = [];
  let skipped = false;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry) continue;
    const absolute = resolve(boundary.root, entry);
    if (!(await boundary.allows(absolute))) { skipped = true; continue; }
    if (found.length < maximum) {
      const label = relative(path, absolute).split("\\").join("/");
      found.push(label + (entry.endsWith("/") || entry.endsWith("\\") ? "/" : ""));
    }
  }
  const notes = [];
  if (output.clipped || entries.filter(Boolean).length > maximum) notes.push("Search result limit reached; narrow the path or pattern.");
  if (output.partial) notes.push("Some entries could not be read and were skipped.");
  if (skipped) notes.push("Out-of-boundary or unresolvable entries were omitted.");
  return result((found.join("\n") || "No safe files found in the bounded search results.") +
    (notes.length ? "\n\n[" + notes.join(" ") + "]" : ""));
}

/** Controlled no-config/no-follow rg; validate each reported file before exposing matched text. */
export async function boundedGrep(
  binary: string, args: Record<string, unknown>, path: string, boundary: ReadBoundary, signal?: AbortSignal,
): Promise<AgentToolResult<undefined>> {
  if (typeof args.pattern !== "string") throw new Error("Invalid grep pattern.");
  const maximum = limit(args.limit, 100);
  const context = typeof args.context === "number" && Number.isFinite(args.context) ?
    Math.max(0, Math.min(100, Math.floor(args.context))) : 0;
  const flags = ["--json", "--no-config", "--no-follow", "--color=never", "--hidden", "--max-count", String(maximum)];
  if (context) flags.push(`--context=${context}`);
  if (args.ignoreCase) flags.push("--ignore-case");
  if (args.literal) flags.push("--fixed-strings");
  if (typeof args.glob === "string") flags.push(`--glob=${args.glob}`);
  flags.push("--", args.pattern, path);
  const output = await run(binary, flags, boundary.root, signal, true);
  const isDirectory = (await stat(await boundary.checkAbsolute(path))).isDirectory();
  const found: string[] = [];
  let matches = 0;
  let skipped = false;
  let limited = output.clipped;
  for (const line of output.stdout.split("\n")) {
    signal?.throwIfAborted();
    let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "match" && event.type !== "context") continue;
    const file = event.data?.path?.text;
    const number = event.data?.line_number;
    if (typeof file !== "string" || typeof number !== "number") continue;
    try { await boundary.checkAbsolute(resolve(boundary.root, file)); }
    catch { skipped = true; continue; }
    if (event.type === "match") {
      if (matches >= maximum) { limited = true; break; }
      matches++;
    }
    const label = (isDirectory ? relative(path, resolve(boundary.root, file)) : basename(path)).split("\\").join("/");
    const text = (event.data?.lines?.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
    found.push(`${label}${event.type === "match" ? ":" : "-"}${number}: ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}`);
  }
  const notes = [];
  if (limited || matches === maximum) notes.push("Search result limit reached; narrow the path or pattern.");
  if (output.partial) notes.push("Some entries could not be read and were skipped.");
  if (skipped) notes.push("Out-of-boundary or unresolvable entries were omitted.");
  return result((found.join("\n") || "No matches found.") + (notes.length ? "\n\n[" + notes.join(" ") + "]" : ""));
}
