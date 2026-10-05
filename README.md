# pi-escalate

One-shot, headless consultation with another model. **Keep your main model unchanged, and add only the result you need to its context.**

`@hyein-cbio/pi-escalate` adds **`/escalate-set`** to choose the target and **`/escalate <request>`** to consult it, backed by the codemode tool `tools.escalate({ question, context? })`. It does not create a child agent session, switch models, inherit conversation history into the target request, or save consultation transcripts.

This is not an automatic model router. **Only `/escalate` grants permission to call the target model, once.** Autonomous tool calls and natural-language requests alone are rejected by code, not just discouraged in the prompt. There are no complexity classifiers or failure-streak triggers.

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

Selections are revalidated before saving. Both fields are written together by same-directory atomic rename, with a private file mode, and temporary staging files are cleaned up. Changes are effective on the next consultation without reloading.

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

Unknown keys, malformed JSON, missing models, and missing authentication fail concisely. `/escalate-set` can replace invalid settings after both selections, but cancellation leaves them untouched. Consultation creates no files; setup writes only the explicit configuration. There are no project overrides, per-call model/effort overrides, output-size settings, or hidden routing defaults.

## Use: `/escalate`

```text
/escalate Inspect src/foo.ts for errors the main model may have missed. Give evidence and a reproduction case.
```

The command asks your **existing main model** to prepare a self-contained question and minimal reference data, call the target once through codemode, and report the answer. It does not hand control of the main session to the target model. Name files or provide a clear reference; if the request is ambiguous, the main model is instructed to ask rather than guess. This command requests consultation, not implementation of suggested fixes.

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

Read and prepare reference data **inside the script**, then print only the consultation result:

```js
const source = await tools.read({ path: "src/relevant-file.ts" });
const result = await tools.escalate({
  question: "Can concurrent callers break this invariant? Give a specific counterexample or say why not.",
  context: source,
});
text(result.answer);
if (result.truncated) text("Consultation answer was truncated.");
```

The original file contents remain inside the script/tool pipeline rather than becoming a standalone parent tool result. The target only gets the supplied question and context—not automatically inherited main conversation, project instructions, skills, system prompt, or tools. The main model chooses the supplied input; it is instructed not to forward conversation history. Each new `/escalate` consultation starts independently.

Do not put huge inputs literally into the codemode source: the source itself is part of the parent conversation. Do not `text(context)`, `console.log(context)`, or `store()` reference material you want to keep out of the parent context/storage. `store()` persists values in Pi's session. Tools used to gather inputs must themselves be active or callable.

## Fixed execution policy

- At most one target request per `/escalate`; **no target agent loop, tools, progress messages, application retries, follow-ups, or resume**. The main model still uses its normal loop to prepare input and report the result.
- A small private system prompt asks for a direct answer, normally below 1,000 words, in the question's language.
- Returned answer is capped at **12,000 UTF-16 code units**, including a truncation notice when the character cap is reached. This is an upper bound, not a target length. `truncated` is also true when the provider stops at its generation limit.
- Generation is capped at **16,384 tokens**, or the model's smaller declared maximum. Some providers count reasoning within this budget, so the returned answer can be shorter or absent.
- Cancellation follows the calling tool/session signal. A fixed **five-minute deadline** bounds the request. Provider SDK retries are requested off (`maxRetries: 0`); individual providers may differ in how they honor options.
- SSE transport and no prompt-cache retention are requested. This avoids requesting a reusable WebSocket conversation, but does not guarantee provider-side deletion or zero retention.
- Thinking and raw provider responses are discarded. Empty answers, provider errors, and unexpected tool calls fail rather than masquerading as successful answers.
- Errors do not echo provider error bodies, submitted context, or credentials. Reported usage is included in tool accounting without printing it into the answer; when a completed failed response supplies usage, that usage is retained too.

## What is—and is not—recorded

**Consultation writes no execution logs, artifacts, or child session transcripts.** The extension's only persistent data is `pi-escalate.json`, saved explicitly through `/escalate-set` (or edited by you). It does not create a `SessionManager`, append custom entries, or persist permission state. `/escalate` uses `sendUserMessage` to dispatch the request to the unchanged main model; that short request is stored by the parent session as normal input.

That is not a claim that the entire Pi/provider stack is record-free:

- The parent codemode script and whatever it prints remain in the normal parent conversation.
- Pi records bounded nested-call metadata, including arguments when they fit its budget. In Pi 1.0.3, codemode also retains up to a 200-character argument preview in UI metadata. This may include part of your supplied question/context. These records are not standalone model-visible child tool messages.
- Pi's tool hooks, observers, debugging extensions, and external clients may see calls and results. This extension does not bypass or redact their records.
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

Tests include a real Pi SDK + slash commands + codemode + local OpenAI-compatible HTTP fixture, with no external API credentials or paid model calls. They check that autonomous calls never reach the target, `/escalate` authorizes only one call, the main model and effort remain unchanged, reference data and target thinking stay out of the next parent request, usage is aggregated, provider errors are sanitized without retrying, and no child files are created. The real extension loader also exercises the lazy settings UI with simulated keyboard input and verifies it makes no model calls, appends no context, and grants no permission. Native TUI component tests cover searching, selection defaults, remapped keys, focus, Unicode/narrow rendering, cancellation, supported model/effort lists, and atomic saves. Other unit tests cover permission lifetime/session/signal boundaries, configuration, cancellation/deadlines, result limits, and tool registration.

## Name

This project is independent of [`@hmemcpy/pi-escalate`](https://github.com/hmemcpy/pi-escalate), which automatically routes the main session between models. This package performs isolated, explicitly requested consultations instead.

## License

MIT
