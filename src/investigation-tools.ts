import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReadOnlyTools, detectSupportedImageMimeTypeFromFile, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ReadBoundary } from "./read-boundary.ts";
import { boundedFind, boundedGrep } from "./bounded-search.ts";

export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

async function findBinary(names: string[], signal?: AbortSignal): Promise<string | undefined> {
  for (const name of names) {
    signal?.throwIfAborted();
    const cached = join(getAgentDir(), "bin", name + (process.platform === "win32" ? ".exe" : ""));
    try { await access(cached, constants.X_OK); return cached; }
    catch { /* Try PATH without installing anything. */ }
    const found = await new Promise<boolean>((resolve) => {
      execFile(name, ["--version"], { timeout: 2_000, signal }, (error) => resolve(!error));
    });
    signal?.throwIfAborted();
    if (found) return name;
  }
  return undefined;
}

/** Fixed read-only tools with a canonical read boundary and non-following recursive searches. */
export function createInvestigationTools(cwd: string): AgentTool[] {
  const boundary = new ReadBoundary(cwd);
  const binaries = new Map<string, string>();
  const tools = createReadOnlyTools(boundary.root, {
    read: { operations: {
      access: async (path) => access(await boundary.checkAbsolute(path), constants.R_OK),
      readFile: async (path) => readFile(await boundary.checkAbsolute(path)),
      detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(await boundary.checkAbsolute(path)),
    } },
    ls: { operations: {
      exists: async (path) => { await boundary.checkAbsolute(path); return true; },
      stat: async (path) => stat(await boundary.checkAbsolute(path)),
      readdir: async (path) => readdir(await boundary.checkAbsolute(path)),
    } },
  });
  return tools.map((tool) => ({
    ...tool,
    description: tool.description + " File contents must resolve within the real cwd. Internal symlinks and path aliases are allowed; external links are omitted from searches.",
    async execute(id, params, signal) {
      signal?.throwIfAborted();
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid investigation tool arguments.");
      const args = params as Record<string, unknown>;
      if ((args.path !== undefined && typeof args.path !== "string") ||
        (tool.name === "read" && typeof args.path !== "string")) throw new Error("Invalid investigation tool path.");
      const path = await boundary.check((args.path as string | undefined) || ".");
      signal?.throwIfAborted();
      const binary = tool.name === "grep" ? "rg" : tool.name === "find" ? "fd" : undefined;
      if (binary) {
        let executable = binaries.get(binary);
        if (!executable) {
          executable = await findBinary(binary === "fd" ? ["fd", "fdfind"] : ["rg"], signal);
          if (!executable) throw new Error(`Read-only investigation needs ${binary} installed in PATH or Pi's bin directory; no download was attempted.`);
          binaries.set(binary, executable);
        }
        return tool.name === "grep" ? boundedGrep(executable, args, path, boundary, signal) :
          boundedFind(executable, args, path, boundary, signal);
      }
      // Encode canonical filenames so Pi does not normalize their Unicode spaces again.
      return tool.execute(id, { ...args, path: pathToFileURL(path).href }, signal);
    },
  }));
}
