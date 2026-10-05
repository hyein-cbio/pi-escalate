import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface EscalateConfig {
  model: string;
  reasoningLevel: ModelThinkingLevel;
}

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseConfig(value: unknown): EscalateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pi-escalate: configuration must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "model" && key !== "reasoningLevel")) {
    throw new Error("pi-escalate: only model and reasoningLevel are configurable.");
  }
  if (
    typeof input.model !== "string" ||
    !/^[^/\s]+\/\S+$/.test(input.model)
  ) {
    throw new Error("pi-escalate: model must be an exact provider/model-id slug.");
  }
  const reasoningLevel = input.reasoningLevel === undefined ? "high" : input.reasoningLevel;
  if (typeof reasoningLevel !== "string" || !levels.has(reasoningLevel)) {
    throw new Error("pi-escalate: invalid reasoningLevel; use off, minimal, low, medium, high, xhigh, or max.");
  }
  return { model: input.model, reasoningLevel: reasoningLevel as ModelThinkingLevel };
}

export async function readOptionalConfig(path: string): Promise<EscalateConfig | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error("pi-escalate: cannot read pi-escalate.json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("pi-escalate: pi-escalate.json is not valid JSON.");
  }
  return parseConfig(value);
}

export async function readConfig(path: string): Promise<EscalateConfig> {
  const config = await readOptionalConfig(path);
  if (!config) {
    throw new Error("pi-escalate: use /escalate-set or create <Pi agent directory>/pi-escalate.json with model and reasoningLevel.");
  }
  return config;
}

/** Same-directory rename: readers see either the complete old or complete new config. */
export async function writeConfig(path: string, config: EscalateConfig): Promise<void> {
  const value = parseConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(path), ".pi-escalate-"));
  try {
    const file = join(staging, "config.json");
    await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(file, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
