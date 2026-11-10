# Host compatibility

## Runtime policy versus tested versions

The minimum host is **Pi 0.99.0** (`@earendil-works/pi-coding-agent`). The bootstrap accepts stable releases in these lines:

```text
>=0.99.0 <0.100.0 || >=1.0.0 <2.0.0
```

Stable future **1.x minor releases are not automatically blacklisted**. This relies on the stable major line's API compatibility plus essential capability checks; it is not a claim that every future release was tested. New 0.x minor lines, 2.x/other major lines, prereleases, and unrecognized version strings need validation before changing this policy. SemVer build metadata is accepted but does not certify a custom fork.

Pi 1.0.0+ is recommended for its smaller codemode prompt footprint. Node.js **22.19+** remains the engine requirement from Pi's published package metadata. See [validation](#validation) for the checked environments; the exact Node.js 22.19 floor was not separately rerun.

## Why 0.99.0

Pi's [v0.99.0 release notes](https://github.com/earendil-works/pi/releases/tag/v0.99.0) introduced the decisive orchestration contract:

- Built-in codemode and tool search.
- Tool `exposure`, `outputSchema` / `structuredContent`, and nested `ctx.executeTool()` calls.
- Nested tool usage added to calling-tool/session accounting.

Function names alone cannot establish these semantics. The preceding 0.87.1 package lacks this contract, even though several other helpers already exist there. Pi [v1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0) made codemode leaner rather than introducing it for the first time.

The current implementation also needs registry streaming/auth, the Agent's `prepareRequest` / `finishTurn` / tool hooks, native read-only tools, session identity/run signals, and TUI input/select/keybindings. Type checks and behavioral tests at the floor validate their use, including budgets, structured output, and aggregated usage.

## Bounded search across host versions

The investigation's own bounded grep uses the same path-relative glob semantics as Pi 1.5.1 without requiring that release. Directory searches run ripgrep inside the canonical search `path` against `.`; reported filenames are resolved against that same directory before boundary validation and display. Single-file searches retain their existing invocation. Leading `./` in globs is ignored, including after a negating `!`.

This shared implementation works on older supported hosts as well as Pi 1.5.1; no version probe or duplicate search is needed. It deliberately retains controlled no-config/no-follow execution, no automatic binary downloads, and per-result boundary checks rather than delegating to the host's grep. The minimum host and peer dependency policy are unchanged.

## Host-provided peer dependencies

All five host peers remain **`"*"`**, as required by Pi's [package guidance](https://github.com/earendil-works/pi/blob/v1.0.3/packages/coding-agent/docs/packages.md#declare-dependencies):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`
- `typebox`

Do not bundle a second set or install independent runtime copies. Use the matching packages supplied by one Pi installation. The runtime gate checks the coding-agent host version and required capabilities; **it does not prove that all peer package versions match**, and it does not certify arbitrary forks. TypeBox is checked for the schema-building functions used by this extension, not artificially restricted to one tested minor line.

## Failure behavior

The public `src/index.ts` is an asynchronous bootstrap. It imports the host namespace, checks the version, and validates registration APIs before importing the implementation's newer named exports. Missing capabilities produce a `pi-escalate: incompatible Pi host` error with an upgrade/restart instruction before any commands, hooks, or tools are registered.

A constructor-only Agent probe checks that the required hooks are retained. It starts no model request, creates no session, and subscribes to nothing. Keeping hook fields is a useful diagnostic, not proof of behavioral correctness; the budget and usage tests remain essential.

Commands validate essential context methods. Run-signal validation happens only when an explicit escalation grant is active, not on ordinary parent runs. Missing registry streaming is diagnosed before lookup/auth/requests and outside the generic provider-error sanitization path. TUI checks happen only when `/escalate set` opens settings.

Both `/escalate <request>` (handoff) and `/escalate min <request>` authorize one read-only investigation; `/escalate set` grants none. There are still only two persistent configuration values. Enter applies a session-only override, while Ctrl+S also saves those defaults.

## Validation

Verified compatibility for pi-escalate 0.2.2:

Checked on **2026-11-10**, using **Node.js 26.13.0 / macOS**. Type checks and **169/169 tests with no skips** passed on each host below. The 0.99.0, 1.5.0, and 1.5.1 checks used disposable copies with every installed Pi-family package pinned and verified against both the lockfile and installed metadata; 1.0.3 used the checkout's existing dependency tree. The original checkout's dependency versions were unchanged; only the package release version was updated in its manifest and lockfile. Package dry-run and whitespace checks also passed.

| Pi packages | Verification for 0.2.2 |
|---|---|
| 0.99.0 | Exact-version type check and all 169 tests passed. |
| 1.0.3 | Local type check and all 169 tests passed. |
| 1.5.0 | Exact-version type check and all 169 tests passed. |
| 1.5.1 | Exact-version type check and all 169 tests passed. |
| Other stable 0.99.x / 1.x releases | Allowed by runtime policy and subject to capability checks; not individually tested. |

The exact Node.js 22.19 engine floor and other operating systems were not separately exercised for this release. Local HTTP fixtures do not certify a live oracle-provider invocation. The minimum host remains Pi 0.99.0.

Regression tests cover path-relative and basename globs, leading `./`, negation, context, absolute/file-URL/aliased directory paths, a symlinked cwd, external-link omission, correct result-path validation, and unchanged single-file searches. The directory-glob regression failed before the fix with `No matches found.`.

### Historical v0.2.1 validation

Checked on **2026-10-14**, using **Node.js 26.11.1 / macOS** and the locally installed Pi **1.0.3** dependency tree. The type check, all **163/163 tests**, package dry-run, and whitespace checks passed. Older accepted hosts and the exact Node.js 22.19 floor were not separately rerun for that release. Coverage included English argument-completion suggestions and insertion through Pi's autocomplete provider, handoff/min preparation, the 500-byte UTF-8 limit, session-only settings, and the existing investigation boundaries and budgets.

### Historical v0.1.3 validation

Checked on **2026-10-07**, using **Node.js 24.19.0 on Linux** and published npm packages in disposable copies of [commit `8a0d08d10b2e5a4c12cc3a364a32f7197c68f848`](https://github.com/hyein-cbio/pi-escalate/commit/8a0d08d10b2e5a4c12cc3a364a32f7197c68f848) (`package.json` version `0.1.3`). The unmodified checkout passed the type check and **117/117 tests** on each of the three hosts. The results below include this documentation update and one added deterministic regression test, which requires exactly one verification marker matching `package.json` in each document; runtime source and package metadata are unchanged.

| Pi packages | Verification |
|---|---|
| 0.99.0 | Type check and all 118 tests passed with every Pi-family dependency pinned to 0.99.0. |
| 1.0.0 | Type check and all 118 tests passed with every Pi-family dependency pinned to 1.0.0. |
| 1.0.3 | Type check and all 118 tests passed with every Pi-family dependency pinned to 1.0.3. |
| Other stable 0.99.x / 1.x releases | Allowed by runtime policy and subject to capability checks; not all individually tested. |

This historical matrix applies to the published v0.1.3 baseline, not the v0.2.0 handoff/min and session-only settings changes. See the current release's validation above.

For that historical run, the complete dependency trees (`npm ls --all`) were checked for all three hosts: `pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-tui`, `pi-mcp`, `pi-telemetry`, and `chord` under `@earendil-works` all resolved exclusively to the requested version. No newer Pi packages contaminated the older-host checks.

Earlier **v0.1.2** validation used Node.js 22.23.1 on macOS: the type check and 115/115 tests passed on Pi 0.99.0, 1.0.0, and 1.0.3. It also separately verified that Pi 0.87.1's actual public bootstrap rejected the host before any registration or request. That unsupported-host check was not rerun for v0.1.3; an unsupported host is not expected to run the investigation suite. Neither set of checks separately exercised the exact Node.js 22.19 engine floor.

Tests use the real SDK/extension loader/codemode with local HTTP provider fixtures; no real provider credentials or paid calls are required. Coverage includes permission revocation, unchanged parent model/effort, private child context, native read-only tools, budgets, cancellation, usage, and lazy settings UI. Install `rg` and `fd` (or `fdfind`) before native search tests.

## Continuous functional checks

The [Compatibility workflow](.github/workflows/compatibility.yml) dispatches **one ephemeral Modal App per workflow run**, not one App per matrix cell. Two parallel inputs check the committed lockfile and an exact-version-pinned latest npm Pi family in separate temporary checkouts. The function scales to two containers (one active input per container). All Node/npm work, including the latest-version lookup, functional/regression tests, type check, dependency-tree inspection, and package dry-run, executes on Modal using Node.js 22 / Debian Linux. GitHub only installs the Python dispatcher and invokes Modal once. Each input also runs the offline Python CI regression tests. All cell results are collected; any failure fails the aggregate check.

Checks run on pushes to `main`, same-repository PRs, a monthly schedule (the 1st at 05:00 UTC), and manual dispatch. Fork PRs are skipped because Modal token secrets are unavailable. See [Modal setup and reproduction](README.md#compatibility-ci) for the required secrets, resource limits, and upload policy. The latest input rejects mixed Pi-family versions; lookup/install failures do not fall back to the locked host. A new unsupported major release intentionally fails rather than changing the runtime policy automatically. These automated runs do not replace the dated release-validation records above or claim that the minimum host was rerun.

The HTTP fixtures do not call Astra. A manually selected new Astra default needs a separate live smoke check; see the [development checklist](README.md#compatibility-ci). No oracle model is hard-coded by this extension, and CI does not change users’ saved/session settings.

### Modal migration verification — 2026-11-05

A [manual Modal run](https://modal.com/apps/hyein-sophia-cho/main/ap-F2dGzDDvox9n4e1d2RNiLQ) passed both inputs on Node.js **22.23.4 / Debian Trixie**, using locked Pi **1.0.3** and npm latest Pi **1.5.0**. Each passed the type check, **167/167 functional/regression tests with no skips**, **16 Python CI regression tests**, dependency-tree inspection, and package dry-run. Logs show two distinct Modal task IDs under the same App. The App completed and was confirmed stopped with zero tasks. Trixie provided ripgrep **14.1.1** and fd **10.2.0**; an initial Bookworm run correctly failed because its fd 8.6 lacks the required search flag.

This validates the dispatcher and remote checks, not GitHub Actions secret/branch-protection setup or a live Astra invocation. Workflow YAML, single-dispatch structure, fork gating, shell syntax, and whitespace were also checked locally.

## Reproduce an exact-version check

Use a disposable **copy** of the checkout, including its source, tests, manifest, README, and this document. Do not replace the real checkout's dependencies or lockfile. Keep `package.json`'s release version unchanged when pinning host dependencies so the documentation regression test checks the same release. In the disposable copy:

```sh
export VERSION=0.99.0 # also check 1.0.0 and 1.0.3
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const names = ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-codemode",
  "pi-tui", "pi-mcp", "pi-telemetry", "chord"];
pkg.private = true;
pkg.overrides ??= {};
for (const name of names) {
  const id = `@earendil-works/${name}`;
  pkg.devDependencies[id] = process.env.VERSION;
  pkg.overrides[id] = process.env.VERSION;
}
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
JS
npm install --ignore-scripts
npm ls --all
npm run check
node --import tsx --test test/*.test.ts
```

Inspect the full dependency tree: every Pi-family package, including transitive packages such as codemode, must have the requested version. Pinning just the four direct host imports is not sufficient evidence. The test command uses the same suite as `npm test` without the tsx CLI's IPC socket, which helps in restricted environments.
