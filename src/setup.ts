import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import * as tuiApi from "@earendil-works/pi-tui";
import type { Component, Focusable, KeybindingsManager, SelectItem, SelectList } from "@earendil-works/pi-tui";
import { readOptionalConfig, writeConfig, type EscalateConfig } from "./config.ts";
import { assertFunctions, assertRegistry } from "./compatibility.ts";

/** Searchable picker composed from Pi's native input and selection components. */
export class SetupPicker implements Component, Focusable {
  private readonly search = new tuiApi.Input({ prompt: "Search: ", placeholder: "type to filter" });
  private list!: SelectList;
  private filtered: SelectItem[] = [];
  private closed = false;

  constructor(
    private readonly title: string,
    private readonly items: SelectItem[],
    private readonly initial: string | undefined,
    private readonly theme: Pick<Theme, "fg" | "bold">,
    private readonly keys: KeybindingsManager,
    private readonly done: (value: string | undefined) => void,
    private readonly requestRender: () => void,
    private readonly saves = false,
  ) {
    assertFunctions(keys, ["matches", "getKeys"], "keybindings");
    assertFunctions(theme, ["fg", "bold"], "theme");
    this.rebuild();
  }

  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }

  private rebuild(): void {
    const query = this.search.getValue().trim().toLowerCase();
    this.filtered = this.items.filter((item) =>
      `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(query));
    this.list = new tuiApi.SelectList(this.filtered, 8, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    if (!query && this.initial) {
      const index = this.filtered.findIndex((item) => item.value === this.initial);
      if (index >= 0) this.list.setSelectedIndex(index);
    }
  }

  private finish(value: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.done(value);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.keys.matches(data, "tui.select.cancel")) return this.finish(undefined);
    if (this.keys.matches(data, "tui.select.confirm")) {
      const item = this.list.getSelectedItem();
      if (item) this.finish(item.value);
      return;
    }
    const direction = this.keys.matches(data, "tui.select.up") ? -1 :
      this.keys.matches(data, "tui.select.down") ? 1 : 0;
    if (direction && this.filtered.length) {
      const index = this.filtered.indexOf(this.list.getSelectedItem()!);
      this.list.setSelectedIndex((index + direction + this.filtered.length) % this.filtered.length);
    } else {
      const previous = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== previous) this.rebuild();
    }
    this.requestRender();
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const confirm = this.keys.getKeys("tui.select.confirm").join("/");
    const cancel = this.keys.getKeys("tui.select.cancel").join("/");
    return [
      this.theme.fg("accent", this.theme.bold(this.title)),
      "",
      ...this.search.render(width),
      "",
      ...(this.filtered.length ? this.list.render(width) : [this.theme.fg("warning", "No matching options")]),
      "",
      this.theme.fg("dim", `${confirm} ${this.saves ? "save" : "select"} · ${cancel} cancel · type to search`),
    ].map((line) => tuiApi.truncateToWidth(line, width));
  }
}

export function availableTargets(ctx: Pick<ExtensionCommandContext, "modelRegistry">): Model<Api>[] {
  const unique = new Map<string, Model<Api>>();
  for (const model of ctx.modelRegistry.getAvailable()) {
    if (model.api !== "pi-virtual" && ctx.modelRegistry.hasConfiguredAuth(model)) {
      unique.set(`${model.provider}/${model.id}`, model);
    }
  }
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, model]) => model);
}

async function pick(
  ctx: ExtensionCommandContext, title: string, items: SelectItem[], initial?: string, saves = false,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    assertFunctions(tui, ["requestRender"], "TUI");
    return new SetupPicker(title, items, initial, theme, keys, done, () => tui.requestRender(), saves);
  });
}

export async function configureEscalation(ctx: ExtensionCommandContext, path: string): Promise<void> {
  // TUI dependencies are checked only on the settings path, never during headless work.
  assertFunctions(tuiApi, ["Input", "SelectList", "truncateToWidth"], "pi-tui");
  assertFunctions(ctx.ui, ["custom", "notify"], "UI");
  assertRegistry(ctx.modelRegistry, true);
  const models = availableTargets(ctx);
  if (!models.length) {
    ctx.ui.notify("pi-escalate: no authenticated chat models available. Configure a provider with /login or models.json.", "warning");
    return;
  }
  const session = ctx.sessionManager.getSessionId();
  let previous: EscalateConfig | undefined;
  try {
    previous = await readOptionalConfig(path);
  } catch {
    ctx.ui.notify("pi-escalate: existing settings are unreadable or invalid. Confirming both selections will replace them.", "warning");
  }
  const slug = await pick(ctx, "Escalate settings · 1/2 · Target model", models.map((model) => {
    const value = `${model.provider}/${model.id}`;
    return { value, label: value, description: model.name + (value === previous?.model ? " (saved)" : "") };
  }), previous?.model);
  if (slug === undefined) return;
  const model = models.find((item) => `${item.provider}/${item.id}` === slug);
  if (!model) throw new Error("pi-escalate: selected model is unavailable.");
  const levels = getSupportedThinkingLevels(model);
  const savedLevel = previous?.model === slug ? previous.reasoningLevel : undefined;
  const initial = savedLevel && levels.includes(savedLevel) ? savedLevel :
    levels.includes("high") ? "high" : levels[0];
  const level = await pick(ctx, `Escalate settings · 2/2 · ${slug}`, levels.map((value) => ({
    value, label: value, description: value === savedLevel ? "saved" : undefined,
  })), initial, true);
  if (level === undefined) return;
  if (!levels.some((item) => item === level)) throw new Error("pi-escalate: selected thinking level is unsupported.");
  if (ctx.sessionManager.getSessionId() !== session || !ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.ui.notify("pi-escalate: session changed or work started; settings were not saved.", "warning");
    return;
  }
  // Revalidate the chosen model immediately before writing, without making a model request.
  const current = availableTargets(ctx).find((item) => `${item.provider}/${item.id}` === slug);
  if (!current || !getSupportedThinkingLevels(current).some((item) => item === level)) {
    ctx.ui.notify("pi-escalate: model availability changed; settings were not saved.", "warning");
    return;
  }
  await writeConfig(path, { model: slug, reasoningLevel: level as EscalateConfig["reasoningLevel"] });
  ctx.ui.notify(`pi-escalate: saved ${slug} · thinking ${level}`, "info");
}
