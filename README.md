# pi-escalate

Explicit, headless read-only investigation with an oracle model. **Keep your main model unchanged, choose rich handoff or minimal injected context, and add only the final result you need back to the main context.**

`@hyein-cbio/pi-escalate` provides **`/escalate set`** for settings, **`/escalate <request>`** for rich handoff investigations, and **`/escalate min <request>`** for at most 500 bytes of added context. The codemode tool remains `tools.escalate({ question, context? })`. Each invocation creates a transient in-memory Pi agent with **`read`, `grep`, `find`, and `ls` only**. It never switches the main model, automatically inherits the main conversation, or persists child transcripts.

This is not an automatic model router. **Only `/escalate <request>` or `/escalate min <request>` grants permission for one investigation; `/escalate set` never does.** Autonomous tool calls and natural-language requests alone are rejected by code, not just discouraged in the prompt. There are no complexity classifiers or failure-streak triggers.

## Install

Requires a stable **Pi 0.99.x or 1.x** release (`@earendil-works/pi-coding-agent`), with **0.99.0 as the minimum**, and **Node.js 22.19+**. **Pi 1.0.0+ is recommended** for its smaller codemode prompt footprint. Stable future 1.x minors are allowed subject to essential capability checks, not automatically blacklisted; this is not a claim that every future version was tested. See [host compatibility](COMPATIBILITY.md) for the runtime policy and reproducible checks.

Pi [0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0) introduced the required built-in codemode, tool exposure, structured tool results, nested execution, and usage-accounting APIs. Pi [1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0) made codemode leaner; it is not the first version that provides these APIs.

Verified compatibility for pi-escalate 0.2.0:

| Pi version | Type check | Tests |
|---|---|---|
| 1.0.3 | Passed | 159/159 passed |
| 0.99.0 / 1.0.0 | Allowed by runtime policy | Not rerun for 0.2.0 |

The 0.2.0 release was checked on 2026-10-14 with Node.js 26.11.1 on macOS using the locally installed Pi 1.0.3 dependency tree. Tests exercise the real SDK, extension loader, codemode, and local HTTP provider fixtures; no paid model calls are required. Packaging and whitespace checks also passed. This is not a full exact-version compatibility-matrix run, and the Node.js 22.19 engine floor was not separately exercised. See [validation details and historical results](COMPATIBILITY.md#validation).

Install from npm:

```sh
pi install npm:@hyein-cbio/pi-escalate
```

### Required: enable codemode

**Installing this package alone does not enable investigation.** Pi's built-in `codemode` tool must be active; it is off by default unless another integration enables it. `/escalate set` still works without codemode, but both investigation modes stop before dispatch when codemode is inactive.

Add `"+codemode"` to `defaultTools` in `<Pi agent directory>/settings.json` (normally `~/.pi/agent/settings.json`, or the directory selected by `PI_CODING_AGENT_DIR`). For project-only activation, use the trusted project's `.pi/settings.json` instead. Preserve all existing settings and `defaultTools` entries:

```json
{
  "defaultTools": ["+codemode"]
}
```

Run `/reload` or restart Pi after installing or adding codemode, then retry `/escalate`. The extension does not edit Pi settings, activate codemode, or change the main tool selection itself. This is a **Pi host setting**, separate from the investigator's two settings in `pi-escalate.json`.

If the inactive-codemode warning persists:

- Project `defaultTools` may replace the user-level tool selection or remove codemode with `"-codemode"`; include `"+codemode"` in the effective project list.
- `--tools` replaces the selection even on reload. Include `codemode` alongside every other desired tool, for example `pi --tools read,bash,edit,write,codemode`. `--no-tools` and `--no-builtin-tools` also override `defaultTools`; remove those overrides if you want settings to control tool selection.
- If you explicitly disabled `builtin:codemode`, re-enable that built-in extension too. Tool selection cannot activate an extension that was not loaded.

## Commands

```text
/escalate set             # Choose oracle model and thinking level
/escalate <request>       # Default: rich handoff context
/escalate min <request>   # Minimal context: at most 500 UTF-8 bytes
```

Only the exact first words `set` and `min` are reserved subcommands. `/escalate set` accepts no extra arguments; investigation commands require a nonempty request. The old `/escalate-set` command is removed, not retained as an alias.

## Configure: session settings and saved defaults

In Pi's interactive TUI, run `/escalate set`. This opens two searchable screens:

1. Choose an authenticated physical chat model from Pi's available-model registry. Virtual routers and models without configured authentication are excluded.
2. Choose a supported thinking level. Non-reasoning models offer only `off`.

Type to filter, use the selection keys (normally ↑/↓), then:

- **Enter**: advance from the model screen; on the thinking screen, apply both choices to this session only. The config file remains byte-for-byte unchanged and is not created during first-time setup.
- **Ctrl+S**: on the thinking screen, apply both choices and save them as defaults in `pi-escalate.json`. On the model screen, advance and request saving after the thinking selection; Enter on the second screen then completes that save.
- **Escape** at either screen: cancel without changing session settings or config, even if Ctrl+S was pressed on the first screen.

The picker highlights the **current** values separately from **saved** defaults. Selection/navigation/cancel honor Pi's selection keybindings; Ctrl+S is the explicit save key. Both values are revalidated before applying. A failed save leaves the previous session settings active.

The command makes no LLM requests, adds no conversation context, does not change the main model/effort or tool selection, and **never grants escalation permission**. It requires TUI mode and an idle session with no queued work. Custom terminal UI is unavailable in RPC/print/JSON modes. Settings UI code loads only on this path; codemode need not be active to configure settings.

Investigations use the **current session override first**, otherwise read the saved config on every call. Overrides survive ordinary agent runs and tree navigation within the session, but are held only in memory: new/resumed sessions, session shutdown, extension reload, and process restart discard them. They are not written into session transcripts. A different session ID cannot use another session's override. External config edits affect the next investigation only when no session override is active.

Saved defaults live at `<Pi agent directory>/pi-escalate.json` (normally `~/.pi/agent/pi-escalate.json`):

```json
{
  "model": "your-provider/your-model-id",
  "reasoningLevel": "high"
}
```

There are exactly two persistent settings:

- **`model`**: required, exact `provider/model-id` from Pi's chat model registry. The first slash separates the provider; model IDs may contain further slashes. No fuzzy aliases, main-model fallback, or virtual routers.
- **`reasoningLevel`**: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Defaults to `high` when omitted. The level must be supported; unsupported levels fail instead of silently downgrading. Use `off` for a non-reasoning model.

Authentication/endpoints come from Pi's existing provider configuration, not this file. `PI_CODING_AGENT_DIR` is respected through `getAgentDir()`. Ctrl+S writes both fields together by same-directory atomic rename with a private file mode and cleans temporary staging files.

Unknown keys, malformed JSON, missing models, and missing authentication fail concisely when used. `/escalate set` can apply a valid session override without altering an invalid saved config; only Ctrl+S replaces it. There are no project overrides, per-tool-call model/effort overrides, output-size settings, or hidden routing defaults. Context mode is chosen by the command, not saved in config.

## Investigate: handoff or min

### Default: rich handoff

```text
/escalate Inspect src/foo.ts for errors the main model may have missed. Give evidence and a reproduction case.
```

Your **existing main model** prepares a self-contained question and a rich, relevant structured handoff in `context`: goals, user requirements/constraints, relevant files/functions, verified facts with evidence, attempted approaches and outcomes, its current assessment, and unresolved questions. Facts and hypotheses must be clearly separated. Irrelevant history and secrets are omitted; the raw conversation is never automatically copied.

### Minimal context

```text
/escalate min Check whether the suspected race in src/foo.ts is real.
```

The main model respects its current assessment and supplies only indispensable additional context, optionally including a short assessment, constraints, or file paths. **The executor enforces at most 500 UTF-8 bytes on the entire `context` string**, including whitespace/headings; this is not a character count. Missing or empty context is valid. Oversized context fails before any oracle request/start notification and consumes permission; it is not silently truncated.

The oracle's question is pinned to the original user request after `min`, not the model-prepared question. This prevents hiding extra context in `question` to bypass the bound. The user's request itself is not counted against the added-context limit. Neither the fixed system prompt/tool schemas nor evidence the oracle reads itself is part of that 500-byte injection budget.

### Shared execution behavior

Both modes start a fresh oracle Agent with no automatic conversation/instruction inheritance. The oracle reads/searches independently in the parent's working directory, checks handoff claims where evidence permits, and may investigate over multiple model turns. The caller's assessment is a starting point, not an authoritative conclusion. Only the final report returns to the main model; intermediate text/thinking/tool results stay private.

When its first model request starts, interactive and RPC clients receive one informational notification showing the effective `provider/model-id` and thinking level, for example `pi-escalate: investigating with your-provider/your-model-id · thinking high`. This includes session-only choices. It is not repeated for later turns or included in either conversation or the returned report. Rejected/pre-cancelled requests produce no start notification; print/JSON modes emit no notification or extra stdout.

The oracle cannot run shell commands, tests, edits, or writes. It may propose a reproduction procedure or fix, but cannot claim execution. Investigation does not implement fixes. One command authorizes **one isolated execution**, not one provider request.

Investigation refuses empty requests, a busy session, queued messages, an open settings dialog, or inactive codemode. It does not silently queue, activate tools, or switch the main model. A dispatch message with your request and the selected preparation instructions enters the parent conversation. If required context is unclear, the main model is instructed to ask rather than guess.

Permission and context mode are held in memory, bound to the session/current agent run signal, and consumed before asynchronous work. A second call—even in the same script—is denied. Failed attempts consume permission too; use a new command to retry. Unused permission is revoked on run completion, changed input, session start/tree navigation/shutdown, or extension reload. Old commands in history do not reauthorize calls. Tool arguments cannot change the authorized context mode.

### Internal codemode call

During the authorized `/escalate` run, the main model uses this shape:

```js
const result = await tools.escalate({
  question: "Which invariant does this implementation violate, if any?",
  context: "Goal: ...\nRequirements: ...\nVerified facts/evidence: ...\nAssessment/hypotheses: ...\nAttempts: ...\nOpen questions: ...",
});
text(result.answer);
```

The script receives:

```ts
{ answer: string; truncated: boolean }
```

`escalate` has `exposure: "codemode"`: it is discoverable without activation, but is not a separate direct model-facing tool declaration by default. Pi's codemode tool catalog can list it. Its executor still checks the command permission; tool discovery or activation does not grant permission.

### Keep large inputs out of the main model's context

Prefer file paths and evidence pointers over raw dumps in the handoff; the investigator can gather evidence itself. In min mode, keep any supplied context within the enforced 500-byte limit, and the original user request remains the oracle's question:

```js
const result = await tools.escalate({
  question: "Inspect src/relevant-file.ts for a concurrency bug. Cite the invariant and file/line evidence.",
});
text(result.answer);
if (result.truncated) text("Investigation or answer reached a fixed limit.");
```

If you already need to supply a particular excerpt or external reference, prepare it **inside the script**, then print only the final result:

```js
const source = await tools.read({ path: "src/relevant-file.ts" });
const result = await tools.escalate({
  question: "Can concurrent callers break this invariant? Give a specific counterexample or say why not.",
  context: source,
});
text(result.answer);
if (result.truncated) text("Investigation or answer reached a fixed limit.");
```

Supplied reference data and the target's own tool results remain inside the script/child pipeline rather than becoming standalone parent tool results. The target receives the authorized question/context, a small private system prompt, and fixed read-only tools—not automatically inherited main conversation, project instructions, skills, extensions, or MCP servers. The main model summarizes relevant history as a handoff by default, or minimizes added context in min mode; it must not forward raw conversation history. Each new investigation starts independently.

Do not put huge inputs literally into the codemode source: the source itself is part of the parent conversation. Do not `text(context)`, `console.log(context)`, or `store()` reference material you want to keep out of the parent context/storage. `store()` persists values in Pi's session. Tools used to gather inputs must themselves be active or callable.

## Fixed execution policy

- At most one investigator execution per `/escalate`. It uses Pi's `Agent` loop in memory, without creating an `AgentSession`, loading resources, or providing steering/resume APIs.
- Exactly **`read`, `grep`, `find`, `ls`**, with file contents confined to the real path of the parent's working directory. Internal symlinks and normal path aliases are allowed; unrelated external links do not fail an entire search. No bash, PowerShell, edit, write, codemode, nested escalation, or MCP tools. A response that requests any tool outside this allowlist fails before its tool batch executes.
- Fixed limits: **12 model requests total**, **24 actual tool executions**, and **15 minutes for the entire investigation**. The last available request is reserved for a tool-free final report; reaching the tool limit also triggers that final-report phase. A limited report is marked `truncated: true`, with a notice that further verification may be needed. If the target still tries to use tools instead of reporting, execution fails rather than continuing indefinitely.
- Tool results are private to the child. Native Pi tool limits apply, and individual text blocks are further capped at **12,000 UTF-16 code units** with a notice to use read offsets or narrower searches. Missing files and failed tools are returned to the target as error evidence. Images are omitted from tool results when the target lacks image support.
- A small private system prompt asks for an evidence-based final answer, normally below 1,000 words, in the question's language. Intermediate assistant text and thinking are never returned to the parent.
- Returned final answer is capped at **12,000 UTF-16 code units**, including any character-limit notice. `truncated` also reports a provider generation limit or investigator execution limit.
- Generation is capped at **16,384 tokens per model request**, or the model's smaller declared maximum. Some providers count reasoning within this budget, so the final answer can be shorter or absent.
- Cancellation follows the parent tool/session signal and aborts the child's model requests and native tools. The outer deadline still returns if a custom provider ignores cancellation; underlying provider shutdown remains best-effort, not OS-process containment. Provider SDK retries are requested off (`maxRetries: 0`); individual providers may differ in how they honor options.
- SSE transport and no prompt-cache retention are requested on every request. This does not guarantee provider-side deletion or zero retention.
- Tool names and schemas come from Pi's read-only tools. Read/ls use boundary-checked native operations; grep/find use controlled ripgrep/fd invocations with no symlink following. Ripgrep configuration/preprocessors are disabled. Existing binaries are checked in Pi's bin directory or PATH; missing binaries produce a tool error rather than an automatic download. Install current `rg` and `fd` (or `fdfind`) beforehand. Searches respect ignore rules, cap results at 1,000 and raw utility output at 2 MiB, and report clipping; the investigator's 12,000-character text cap still applies.
- Errors do not echo provider error bodies, submitted context, or credentials. Usage and cost are summed over all completed target responses, including a completed failed response, and passed to parent tool accounting without printing them into the answer.

### Filesystem read boundary

Each investigation pins `realpath(cwd)` as its read root. Containment is checked **after canonicalization**, so macOS `/var`/`/private/var` aliases, a symlinked cwd, and alternative paths to the same internal file do not get falsely rejected. A sibling with a similar name is still outside. Direct access to a symlink resolving outside the root is denied; internal symlinks are permitted.

Recursive searches do not automatically follow symlink directories. External or broken links are omitted from find/ls results instead of failing the entire operation. An internal directory link can be searched explicitly by setting the tool's `path`; it resolves to its permitted canonical target. No preliminary traversal of hidden/ignored trees is performed, so an ignored external `node_modules` dependency does not veto an unrelated source search. Grep validates each reported file before returning match/context events streamed by ripgrep, without loading whole files for context. Partial traversal failures retain usable search output with a warning.

Literal Unicode filenames are preserved. `@`, `~`, file URLs, and supported Windows drive shorthands resolve before checking; Unicode-space fallback is used only if the literal path is missing. Read/ls receive encoded canonical file URLs so Pi cannot normalize a verified filename into another file. Boundary failures remain private child tool evidence and grant no additional execution.

This is an application-level boundary, **not an OS sandbox**. Concurrent path replacement, hard links, mounts, and utilities' ignore-file access are not isolated. Keep the workspace and binaries trusted. Sensitive files **inside** the root remain readable. Parent extensions' permission hooks are not inherited. The boundary controls the investigator's own file access, not reference material deliberately supplied through `context`. There is no new boundary configuration key: settings remain model and reasoning level only.

## What is—and is not—recorded

**Investigation writes no execution logs, artifacts, or child session transcripts.** The extension's only persistent data is `pi-escalate.json`, saved explicitly with Ctrl+S through `/escalate set` (or edited by you). It does not create a `SessionManager`, append custom entries, or persist permission state. `/escalate` uses `sendUserMessage` to dispatch the request to the unchanged main model; that short request is stored by the parent session as normal input.

That is not a claim that the entire Pi/provider stack is record-free:

- The parent codemode script and whatever it prints remain in the normal parent conversation.
- Pi records bounded nested-call metadata, including arguments when they fit its budget. In Pi 1.0.3, codemode also retains up to a 200-character argument preview in UI metadata. This may include part of your supplied question/context. These records are not standalone model-visible child tool messages.
- Parent tool hooks, observers, debugging extensions, and external clients may see the outer `escalate` call/result. The child's native tool calls stay inside its private agent loop and are not forwarded as parent nested calls or progress updates. Provider implementations can still observe the child requests, including evidence collected by its tools.
- Oversized codemode output may be written to a temp file by codemode. One bounded answer normally stays below its default output budget; printing many answers or lowering that budget can still trigger a spill.
- The provider/proxy may retain requests. `cacheRetention: "none"` is a cache preference, not a deletion guarantee.

The primary contract is **controlled context injection, only the final report added back to the main model, and no extension-owned child execution records**, not secrecy from the host or provider.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

No compilation step is needed for Pi: it loads the TypeScript entry point. Host packages are peer dependencies; development copies are not bundled in the published package.

Tests include a real Pi SDK + slash commands + codemode + local OpenAI-compatible HTTP fixture, with no external API credentials or paid model calls. They exercise multi-turn investigation with all four native tools and verify that only the final report reaches the parent, intermediate text/thinking/tool results stay private, model/effort remain unchanged, usage is aggregated, and no child files are created. Tests also cover forbidden and mixed tool batches, request/tool budgets, the tool-free final-report phase, failed reads, output clipping, missing search binaries, independent executions, and sanitized later-turn failures. The real extension loader also exercises the lazy settings UI with simulated keyboard input and verifies it makes no model calls, appends no context, and grants no permission. Tests cover handoff/min dispatch, UTF-8 limits and question-bypass prevention, Enter/Ctrl+S, cancellation/save failures, temporary-setting precedence and lifecycle isolation, and once-only start notifications. Native TUI component tests cover searching, selection defaults, remapped keys, focus, Unicode/narrow rendering, cancellation, supported model/effort lists, and atomic saves. Other unit tests cover permission lifetime/session/signal boundaries, configuration, cancellation/deadlines, result limits, and tool registration.

## Name

This project is independent of [`@hmemcpy/pi-escalate`](https://github.com/hmemcpy/pi-escalate), which automatically routes the main session between models. This package performs isolated, explicitly requested consultations instead.

## License

MIT
