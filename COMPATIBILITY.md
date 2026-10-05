# Host compatibility

## Runtime policy versus tested versions

The minimum host is **Pi 0.99.0** (`@earendil-works/pi-coding-agent`). The bootstrap accepts stable releases in these lines:

```text
>=0.99.0 <0.100.0 || >=1.0.0 <2.0.0
```

Stable future **1.x minor releases are not automatically blacklisted**. This relies on the stable major line's API compatibility plus essential capability checks; it is not a claim that every future release was tested. New 0.x minor lines, 2.x/other major lines, prereleases, and unrecognized version strings need validation before changing this policy. SemVer build metadata is accepted but does not certify a custom fork.

Pi 1.0.0+ is recommended for its smaller codemode prompt footprint. Node.js **22.19+** remains the engine requirement from Pi's published package metadata. The recorded checks used **Node.js 22.23.1** on macOS; the exact Node.js 22.19 floor was not separately rerun.

## Why 0.99.0

Pi's [v0.99.0 release notes](https://github.com/earendil-works/pi/releases/tag/v0.99.0) introduced the decisive orchestration contract:

- Built-in codemode and tool search.
- Tool `exposure`, `outputSchema` / `structuredContent`, and nested `ctx.executeTool()` calls.
- Nested tool usage added to calling-tool/session accounting.

Function names alone cannot establish these semantics. The preceding 0.87.1 package lacks this contract, even though several other helpers already exist there. Pi [v1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0) made codemode leaner rather than introducing it for the first time.

The current implementation also needs registry streaming/auth, the Agent's `prepareRequest` / `finishTurn` / tool hooks, native read-only tools, session identity/run signals, and TUI input/select/keybindings. Type checks and behavioral tests at the floor validate their use, including budgets, structured output, and aggregated usage.

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

Commands validate essential context methods. Run-signal validation happens only when an explicit escalation grant is active, not on ordinary parent runs. Missing registry streaming is diagnosed before lookup/auth/requests and outside the generic provider-error sanitization path. TUI checks happen only when `/escalate-set` opens settings.

These checks do not change invocation authority, model selection, tools, configuration, or transcript policy. `/escalate` still authorizes one read-only investigation; there are still only two configurable values.

## Validation

Validated on Node.js 22.23.1 with published npm packages:

| Pi packages | Verification |
|---|---|
| 0.87.1 | Actual public bootstrap rejected the host before any registration or request. |
| 0.99.0 | Type check and all 115 tests passed with every Pi-family dependency pinned to 0.99.0. |
| 1.0.0 | Type check and all 115 tests passed with every Pi-family dependency pinned to 1.0.0. |
| 1.0.3 | Type check and all 115 tests passed on the development baseline. |
| Other stable 0.99.x / 1.x releases | Allowed by runtime policy and subject to capability checks; not all individually tested. |

The complete dependency trees were checked to rule out newer Pi packages contaminating the older-host checks. The 0.87.1 rejection path was tested separately; an unsupported host is not expected to run the investigation suite.

Tests use the real SDK/extension loader/codemode with local HTTP provider fixtures; no real provider credentials or paid calls are required. Coverage includes permission revocation, unchanged parent model/effort, private child context, native read-only tools, budgets, cancellation, usage, and lazy settings UI. Install `rg` and `fd` (or `fdfind`) before native search tests.

## Reproduce an exact-version check

Use a disposable **copy** of the checkout, including its source, tests, manifest, and this document. Do not replace the real checkout's dependencies or lockfile. In the disposable copy:

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
