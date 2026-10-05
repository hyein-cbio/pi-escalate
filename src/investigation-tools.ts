import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { createReadOnlyTools, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

async function binaryAvailable(names: string[], signal?: AbortSignal): Promise<boolean> {
  for (const name of names) {
    signal?.throwIfAborted();
    try {
      await access(join(getAgentDir(), "bin", name + (process.platform === "win32" ? ".exe" : "")));
      return true;
    } catch { /* Try PATH without installing anything. */ }
    const found = await new Promise<boolean>((resolve) => {
      execFile(name, ["--version"], { timeout: 2_000, signal }, (error) => resolve(!error));
    });
    signal?.throwIfAborted();
    if (found) return true;
  }
  return false;
}

/** Native Pi read-only tools, with no automatic binary downloads or parent tool bridge. */
export function createInvestigationTools(cwd: string): AgentTool[] {
  const available = new Set<string>();
  return createReadOnlyTools(cwd).map((tool) => ({
    ...tool,
    async execute(id, params, signal) {
      const binary = tool.name === "grep" ? "rg" : tool.name === "find" ? "fd" : undefined;
      if (binary && !available.has(binary)) {
        const names = binary === "fd" ? ["fd", "fdfind"] : ["rg"];
        if (!(await binaryAvailable(names, signal))) {
          throw new Error(`Read-only investigation needs ${binary} installed in PATH or Pi's bin directory; no download was attempted.`);
        }
        available.add(binary);
      }
      // Keep child progress/results private. The native tool receives only its own abort signal.
      return tool.execute(id, params, signal);
    },
  }));
}
