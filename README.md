# pi-escalate

Explicit, headless read-only investigation with another model. **Keep your main model unchanged, and add only the final result you need to its context.**

`@hyein-cbio/pi-escalate` adds **`/escalate-set`** to choose the target and **`/escalate <request>`** to investigate, backed by the codemode tool `tools.escalate({ question, context? })`. Each invocation creates a transient in-memory Pi agent with **`read`, `grep`, `find`, and `ls` only**. It never switches the main model, inherits the main conversation, or persists child transcripts.

This is not an automatic model router. **Only `/escalate` grants permission for one investigation.** Autonomous tool calls and natural-language requests alone are rejected by code, not just discouraged in the prompt. There are no complexity classifiers or failure-streak triggers.

## Install

Requires Pi's codemode, structured tool results, and nested-usage accounting APIs. Tested with **Pi 1.0.3** and Node.js 22.19+.

Install from npm:

```sh
pi install npm:@hyein-cbio/pi-escalate
```

Enable Pi's built-in codemode if it is not already enabled. Add `"+codemode"` to `defaultTools` in your Pi `settings.json`, preserving any existing entries:

```json
{
  "defaultTools": ["+codemode"]
}
```

Reload/restart Pi after installing or enabling codemode. The extension does not activate codemode or change the main tool selection itself.

## Configure: exactly two settings

In Pi's interactive TUI, run:

```text
/escalate-set
```

This opens a two-step, searchable settings TUI:

1. Choose an authenticated physical chat model from Pi's available-model registry. Virtual routers and models without configured authentication are excluded.
2. Choose one of that model's supported thinking levels. Non-reasoning models offer only `off`.

Type to filter by slug/name, use the selection keys (normally ↑/↓), and press Enter to choose. Existing saved choices are highlighted. Enter on the second screen saves both values; Escape at either screen cancels without changing the file. The UI honors Pi's selection keybindings and uses its active theme.

The command makes no LLM requests, adds no conversation context, does not change the main model/effort or tool selection, and **never grants escalation permission**. It requires TUI mode and an idle session with no queued work; custom terminal UI is not available in RPC/print/JSON modes. Settings UI code loads only when this command is invoked.

Selections are revalidated before saving. Both fields are written together by same-directory atomic rename, with a private file mode, and temporary staging files are cleaned up. Changes are effective on the next investigation without reloading.

Alternatively, edit `<Pi agent directory>/pi-escalate.json` manually (normally `~/.pi/agent/pi-escalate.json`):

```json
{
  "model": "your-provider/your-model-id",
  "reasoningLevel": "high"
}
```

- **`model`**: required, exact `provider/model-id` from Pi's chat model registry. The first slash separates the provider; model IDs may contain further slashes. No fuzzy aliases, main-model fallback, or virtual routers.
- **`reasoningLevel`**: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Defaults to `high` when omitted. The level must be supported by the target model according to Pi's catalog; unsupported levels fail instead of silently downgrading. Use `off` for a non-reasoning model.

Authentication and endpoints come from Pi's existing provider configuration (`/login`, environment credentials, or `models.json`), not this file. `PI_CODING_AGENT_DIR` is respected through Pi's `getAgentDir()` API. The extension reads the file on every call, so editing these two values does not require reloading.

Unknown keys, malformed JSON, missing models, and missing authentication fail concisely. `/escalate-set` can replace invalid settings after both selections, but cancellation leaves them untouched. Investigation writes no child transcripts or reports; setup writes only the explicit configuration. There are no project overrides, per-call model/effort overrides, output-size settings, or hidden routing defaults.

## Use: `/escalate`

```text
/escalate Inspect src/foo.ts for errors the main model may have missed. Give evidence and a reproduction case.
```

The command asks your **existing main model** to identify relevant files, prepare a self-contained question and minimal context, and call the investigator once through codemode. The target can read and search independently in the parent's working directory, inspect tool results, and continue its investigation over multiple model turns. Only its final report is returned to the main model. Name files or provide a clear reference; if the request is ambiguous, the main model is instructed to ask rather than guess.

The target cannot run shell commands, tests, edits, or writes. It may propose a reproduction procedure or fix, but must not claim it executed them. This command requests investigation, not implementation. One `/escalate` means **one isolated execution**, not one provider request.

The command refuses empty requests, a busy session, queued messages, or inactive codemode. It does not silently queue, enable tools, or change models. A short dispatch message containing your request and preparation instructions enters the normal parent conversation.

Permission is in-memory, bound to the session and current agent run signal, and consumed before asynchronous work begins. A second call—even in the same script—is denied. A failed attempt consumes permission too; use `/escalate` again to retry. Unused permission is revoked when the run ends, input changes, or the session starts, navigates its tree, or shuts down. Reloading the extension creates a fresh permission state. Old slash commands in history do not reauthorize calls.

### Internal codemode call

During the authorized `/escalate` run, the main model uses this shape:

```js
const result = await tools.escalate({
  question: "Which invariant does this implementation violate, if any?",
  context: "Only the relevant implementation and its intended contract.",
});
text(result.answer);
```

The script receives:

```ts
{ answer: string; truncated: boolean }
```

`escalate` has `exposure: "codemode"`: it is discoverable without activation, but is not a separate direct model-facing tool declaration by default. Pi's codemode tool catalog can list it. Its executor still checks the command permission; tool discovery or activation does not grant permission.

### Keep large inputs out of the main model's context

Usually, give the investigator file paths and a focused question; it can gather evidence itself:

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

Supplied reference data and the target's own tool results remain inside the script/child pipeline rather than becoming standalone parent tool results. The target receives the supplied question/context, a small private system prompt, and its fixed read-only tools—not automatically inherited main conversation, project instructions, skills, extensions, or MCP servers. The main model chooses the supplied input and is instructed not to forward conversation history. Each new `/escalate` investigation starts independently.

Do not put huge inputs literally into the codemode source: the source itself is part of the parent conversation. Do not `text(context)`, `console.log(context)`, or `store()` reference material you want to keep out of the parent context/storage. `store()` persists values in Pi's session. Tools used to gather inputs must themselves be active or callable.

## Fixed execution policy

- At most one investigator execution per `/escalate`. It uses Pi's `Agent` loop in memory, without creating an `AgentSession`, loading resources, or providing steering/resume APIs.
- Exactly **`read`, `grep`, `find`, `ls`** in the parent's working directory. No bash, PowerShell, edit, write, codemode, nested escalation, or MCP tools. A response that requests any tool outside this allowlist fails before its tool batch executes.
- Fixed limits: **12 model requests total**, **24 actual tool executions**, and **15 minutes for the entire investigation**. The last available request is reserved for a tool-free final report; reaching the tool limit also triggers that final-report phase. A limited report is marked `truncated: true`, with a notice that further verification may be needed. If the target still tries to use tools instead of reporting, execution fails rather than continuing indefinitely.
- Tool results are private to the child. Native Pi tool limits apply, and individual text blocks are further capped at **12,000 UTF-16 code units** with a notice to use read offsets or narrower searches. Missing files and failed tools are returned to the target as error evidence. Images are omitted from tool results when the target lacks image support.
- A small private system prompt asks for an evidence-based final answer, normally below 1,000 words, in the question's language. Intermediate assistant text and thinking are never returned to the parent.
- Returned final answer is capped at **12,000 UTF-16 code units**, including any character-limit notice. `truncated` also reports a provider generation limit or investigator execution limit.
- Generation is capped at **16,384 tokens per model request**, or the model's smaller declared maximum. Some providers count reasoning within this budget, so the final answer can be shorter or absent.
- Cancellation follows the parent tool/session signal and aborts the child's model requests and native tools. The outer deadline still returns if a custom provider ignores cancellation; underlying provider shutdown remains best-effort, not OS-process containment. Provider SDK retries are requested off (`maxRetries: 0`); individual providers may differ in how they honor options.
- SSE transport and no prompt-cache retention are requested on every request. This does not guarantee provider-side deletion or zero retention.
- Search uses Pi's native ripgrep/fd tools. Existing binaries are checked in Pi's bin directory or PATH; missing binaries produce a tool error rather than requesting an automatic download. Install `rg` and `fd` (or `fdfind`) beforehand if necessary.
- Errors do not echo provider error bodies, submitted context, or credentials. Usage and cost are summed over all completed target responses, including a completed failed response, and passed to parent tool accounting without printing them into the answer.

### Read-only is not a filesystem sandbox

The four tools use Pi's normal path semantics: relative paths resolve from the parent's `cwd`, and absolute paths, parent-directory paths, and symlinks are not confined to that directory. They run with the host user's filesystem access. Only use a trusted model/provider, and do not treat the tool allowlist as a boundary against reading sensitive files. The child has its own fixed tool hooks and does not inherit parent extensions' filesystem permission hooks; filesystem confinement would require a separate design.

## What is—and is not—recorded

**Investigation writes no execution logs, artifacts, or child session transcripts.** The extension's only persistent data is `pi-escalate.json`, saved explicitly through `/escalate-set` (or edited by you). It does not create a `SessionManager`, append custom entries, or persist permission state. `/escalate` uses `sendUserMessage` to dispatch the request to the unchanged main model; that short request is stored by the parent session as normal input.

That is not a claim that the entire Pi/provider stack is record-free:

- The parent codemode script and whatever it prints remain in the normal parent conversation.
- Pi records bounded nested-call metadata, including arguments when they fit its budget. In Pi 1.0.3, codemode also retains up to a 200-character argument preview in UI metadata. This may include part of your supplied question/context. These records are not standalone model-visible child tool messages.
- Parent tool hooks, observers, debugging extensions, and external clients may see the outer `escalate` call/result. The child's native tool calls stay inside its private agent loop and are not forwarded as parent nested calls or progress updates. Provider implementations can still observe the child requests, including evidence collected by its tools.
- Oversized codemode output may be written to a temp file by codemode. One bounded answer normally stays below its default output budget; printing many answers or lowering that budget can still trigger a spill.
- The provider/proxy may retain requests. `cacheRetention: "none"` is a cache preference, not a deletion guarantee.

The primary contract is **minimal additional model context and no extension-owned child execution records**, not secrecy from the host or provider.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

No compilation step is needed for Pi: it loads the TypeScript entry point. Host packages are peer dependencies; development copies are not bundled in the published package.

Tests include a real Pi SDK + slash commands + codemode + local OpenAI-compatible HTTP fixture, with no external API credentials or paid model calls. They exercise multi-turn investigation with all four native tools and verify that only the final report reaches the parent, intermediate text/thinking/tool results stay private, model/effort remain unchanged, usage is aggregated, and no child files are created. Tests also cover forbidden and mixed tool batches, request/tool budgets, the tool-free final-report phase, failed reads, output clipping, missing search binaries, independent executions, and sanitized later-turn failures. The real extension loader also exercises the lazy settings UI with simulated keyboard input and verifies it makes no model calls, appends no context, and grants no permission. Native TUI component tests cover searching, selection defaults, remapped keys, focus, Unicode/narrow rendering, cancellation, supported model/effort lists, and atomic saves. Other unit tests cover permission lifetime/session/signal boundaries, configuration, cancellation/deadlines, result limits, and tool registration.

## Name

This project is independent of [`@hmemcpy/pi-escalate`](https://github.com/hmemcpy/pi-escalate), which automatically routes the main session between models. This package performs isolated, explicitly requested consultations instead.

## License

MIT
