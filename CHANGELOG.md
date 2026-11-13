# Changelog

## Unreleased

### Security scope correction

- Raise the development-only Undici override from `^8.12.3` to `^8.12.4`; retain the locked `8.12.4` development dependency. PR #1 updated this repository's development tree, not the Undici used by an installed Pi host.
- Document the host-level remediation and a dispatcher-relative version check. Installing this extension from Git or npm does not patch Pi's HTTP dependencies; the host must be updated or reinstalled with its own root override.
- Add regression checks for the development override, locked Undici versions, and the Undici resolved and loaded from the development Pi host's HTTP dispatcher. These checks do not certify users' separate Pi installations.

### Validation

- On Node.js 22.23.1 / macOS with the locked Pi 1.0.3 development host, type checking and all 171 tests passed without skips after a clean install. The new dispatcher check detected the stale installed Undici `8.10.2` before reinstalling and loaded `8.12.4` afterward.
- The documented host-resolution snippet, npm package dry-run, and whitespace check passed. A disposable production-only install using Pi's npm dependency flags confirmed that development Undici is omitted; this is not a rerun of the full Git-install matrix reported in `COMPATIBILITY.md`.

## 0.2.2 — 2026-11-10

### Fixes

- Resolve grep globs relative to the requested search directory, matching Pi 1.5.1 semantics on all supported hosts. Resolve reported paths against the same directory for boundary checks and labels, while preserving single-file searches and no-config/no-follow protections.
- Ignore leading `./` in grep globs, including negated globs. The minimum Pi version remains 0.99.0; no new runtime dependency or version branch is required.

### Improvements

- Preserve explicit escalation authorization with Pi 1.5 user-message starts while rejecting custom-message starts.
- Run locked/latest Pi compatibility checks in one ephemeral Modal App on pushes, same-repository PRs, monthly schedules, and manual dispatch.

### Validation

- Type checks and all 169 tests passed without skips on Pi 0.99.0, 1.0.3, 1.5.0, and 1.5.1 with Node.js 26.13.0 on macOS. Disposable checks pin and verify every installed Pi-family package; the checkout retains its existing 1.0.3 dependency tree.
- Regression coverage includes nested directory globs, output-path boundary validation, path aliases, leading `./`, negation, context, and unchanged single-file searches.
- CodeRabbit reviewed the five-file bounded-grep change and reported no findings before the version bump.
- npm packaging and whitespace checks passed. The exact Node.js 22.19 floor and other operating systems were not separately rerun for this release; see `COMPATIBILITY.md`.

**Full Changelog:** https://github.com/hyein-cbio/pi-escalate/compare/v0.2.1...v0.2.2

## 0.2.1 — 2026-10-14

### Improvements

- Add English `set` and `min` argument-completion suggestions after `/escalate `.
- Filter by the first-word prefix without interfering with free-form handoff questions or the request following `min`.
- Insert a trailing space when selecting `min` so the request can be entered immediately.
- Keep completion passive: it never opens settings, dispatches a request, or grants escalation permission.

### Validation

- Type check and all 163 tests passed on Pi 1.0.3 with Node.js 26.11.1 on macOS.
- Regression coverage includes English descriptions, prefix filtering, suppression after subcommands/question text, and insertion through Pi's actual autocomplete provider.
- npm packaging and whitespace checks passed.
- Older accepted Pi hosts and the Node.js 22.19 engine floor were not separately rerun; see `COMPATIBILITY.md`.

**Full Changelog:** https://github.com/hyein-cbio/pi-escalate/compare/v0.2.0...v0.2.1

## 0.2.0 — 2026-10-14

### Breaking changes

- Replace `/escalate-set` with `/escalate set`. The old command is removed without an alias.
- Make `/escalate <request>` use rich structured handoff context by default. Use `/escalate min <request>` for minimal context.
- Enter in the settings TUI now applies settings to the current session only. Press Ctrl+S to also save defaults to `pi-escalate.json`.

### Features

- Prepare handoffs containing goals, requirements, constraints, evidence-backed facts, attempted approaches, the main model's assessment, and unresolved questions. Separate facts from hypotheses.
- Enforce a 500-byte UTF-8 cap on additional context in min mode. Pin the oracle's question to the original user request so extra context cannot bypass the cap through the question field. Oversized context is rejected, not silently truncated.
- Prefer current-session model/thinking settings over saved defaults. Highlight current and saved values separately, preserve prior settings on cancellation/save failure, and discard temporary settings on session replacement/shutdown or extension reload.
- Show one UI notification with the effective oracle model and thinking level immediately before its first request; keep it out of model context and the final report.

### Preserved guarantees

- Never switch the main model or automatically inherit its conversation/instructions.
- Each command authorizes one fresh read-only investigation using only `read`, `grep`, `find`, and `ls` inside the workspace boundary.
- Return only the final oracle report; no extension-owned child transcripts or execution logs.
- Keep the existing request/tool budgets, cancellation, output limits, and usage accounting.

### Validation

- Type check and all 159 tests passed on Pi 1.0.3 with Node.js 26.11.1 on macOS.
- CodeRabbit reviewed all 14 changed implementation/documentation/test files and reported no new findings before the version bump.
- npm packaging and whitespace checks passed.
- Older accepted Pi hosts and the Node.js 22.19 engine floor were not separately rerun for this release; see `COMPATIBILITY.md`.

**Full Changelog:** https://github.com/hyein-cbio/pi-escalate/compare/v0.1.3...v0.2.0
