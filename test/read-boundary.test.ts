import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createInvestigationTools, READ_ONLY_TOOL_NAMES } from "../src/investigation-tools.ts";

const SOURCE = "const safeNeedle = true;\nconst other = 1;\n";
const SECRET = "OUTSIDE-SECRET-NEEDLE";

async function workspace() {
  const base = await mkdtemp(join(tmpdir(), "pi-read-boundary-"));
  const root = join(base, "project");
  const outside = join(base, "project-private");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "src", "safe.ts"), SOURCE);
  await writeFile(join(root, ".gitignore"), "node_modules/\nignored/\n");
  await writeFile(join(outside, "secret.ts"), SECRET);
  await symlink(outside, join(root, "escape"), "dir");
  await symlink(join(outside, "secret.ts"), join(root, "escape.ts"), "file");
  await symlink(join(outside, "missing"), join(root, "broken.ts"), "file");
  await symlink(join(root, "src", "safe.ts"), join(root, "inside.ts"), "file");
  await symlink(join(root, "src"), join(root, "internal-dir"), "dir");
  await symlink(root, join(base, "alias"), "dir");
  return { base, root, outside, dispose: () => rm(base, { recursive: true, force: true }) };
}

for (const name of READ_ONLY_TOOL_NAMES) {
  test(name + " rejects external content, traversal, sibling-prefix paths and escaping links", async () => {
    const w = await workspace();
    try {
      const tool = createInvestigationTools(w.root).find((item) => item.name === name)!;
      const suffix = name === "read" || name === "grep" ? "secret.ts" : "";
      for (const path of [join(w.outside, suffix), `../project-private/${suffix}`, `src/../../project-private/${suffix}`,
        `escape/${suffix}`, "escape.ts", `@${join(w.outside, suffix)}`, pathToFileURL(join(w.outside, suffix)).href, "~"]) {
        await assert.rejects(tool.execute("reject", { path, pattern: "*" }), /cwd filesystem boundary/);
      }
    } finally { await w.dispose(); }
  });

  test(name + " accepts real paths, OS aliases, internal symlinks and a symlinked cwd", async () => {
    const w = await workspace();
    try {
      const tool = createInvestigationTools(join(w.base, "alias")).find((item) => item.name === name)!;
      const canonical = await realpath(w.root);
      const suffix = name === "read" || name === "grep" ? "src/safe.ts" : "src";
      for (const path of [suffix, join(w.root, suffix), join(canonical, suffix), join(w.base, "alias", suffix),
        pathToFileURL(join(w.root, suffix)).href, name === "read" || name === "grep" ? "inside.ts" : "internal-dir"]) {
        const output = JSON.stringify(await tool.execute("safe", { path, pattern: name === "grep" ? "safeNeedle" : "*.ts" }));
        assert(!output.includes(SECRET));
        if (name === "read" || name === "grep") assert(output.includes("safeNeedle"));
      }
      await rename(w.root, join(w.base, "old-project"));
      await symlink(w.outside, w.root, "dir");
      await assert.rejects(tool.execute("replace", { path: "secret.ts", pattern: "*" }), /cwd filesystem boundary/);
    } finally { await w.dispose(); }
  });
}

for (const name of ["grep", "find"] as const) {
  test(name + " skips unrelated external/broken links without blocking a safe recursive search", async () => {
    const w = await workspace();
    try {
      await mkdir(join(w.root, "node_modules"));
      await symlink(w.outside, join(w.root, "node_modules", "dependency"), "dir");
      await mkdir(join(w.root, "ignored"));
      await symlink(w.outside, join(w.root, "ignored", "escape"), "dir");
      await mkdir(join(w.root, ".hidden"));
      await symlink(w.outside, join(w.root, ".hidden", "escape"), "dir");
      await symlink(w.root, join(w.root, "src", "cycle"), "dir");
      const tool = createInvestigationTools(w.root).find((item) => item.name === name)!;
      const output = JSON.stringify(await tool.execute("search", {
        pattern: name === "grep" ? "safeNeedle|OUTSIDE-SECRET" : "*.ts", path: ".", glob: "*.ts",
      }));
      assert(output.includes("safe.ts"));
      assert(!output.includes("escape.ts"));
      assert(!output.includes("broken.ts"));
      assert(!output.includes(SECRET));
      const targeted = JSON.stringify(await tool.execute("targeted", {
        path: "internal-dir", pattern: name === "grep" ? "safeNeedle" : "*.ts",
      }));
      assert(targeted.includes("safe.ts"));
    } finally { await w.dispose(); }
  });
}

test("ls omits escaped/broken entries but keeps internal links", async () => {
  const w = await workspace();
  try {
    const ls = createInvestigationTools(w.root).find((item) => item.name === "ls")!;
    const output = JSON.stringify(await ls.execute("ls", {}));
    assert(output.includes("inside.ts"));
    assert(output.includes("internal-dir"));
    assert(!output.includes("escape"));
    assert(!output.includes("broken"));
  } finally { await w.dispose(); }
});

test("literal Unicode-space filenames are not normalized into a different file", async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.root, "name\u202Fspace.ts"), "RIGHT-UNICODE-FILE");
    await writeFile(join(w.root, "name space.ts"), "WRONG-NORMALIZED-FILE");
    const read = createInvestigationTools(w.root).find((item) => item.name === "read")!;
    for (const path of ["name\u202Fspace.ts", pathToFileURL(join(w.root, "name\u202Fspace.ts")).href]) {
      const output = JSON.stringify(await read.execute("unicode", { path }));
      assert(output.includes("RIGHT-UNICODE-FILE"));
      assert(!output.includes("WRONG-NORMALIZED-FILE"));
    }
    await symlink(join(w.outside, "secret.ts"), join(w.root, "bad\u202Fspace.ts"));
    await writeFile(join(w.root, "bad space.ts"), SOURCE);
    await assert.rejects(read.execute("no-fallback", { path: "bad\u202Fspace.ts" }), /cwd filesystem boundary/);
    await symlink(join(w.outside, "missing"), join(w.root, "broken\u202Fspace.ts"));
    await writeFile(join(w.root, "broken space.ts"), "WRONG-FALLBACK");
    await assert.rejects(read.execute("broken-no-fallback", { path: "broken\u202Fspace.ts" }), /ENOENT/);
  } finally { await w.dispose(); }
});

test("grep preserves literal/case/context/glob behavior and cannot inherit follow/preprocessor configuration", async () => {
  const w = await workspace();
  const previous = process.env.RIPGREP_CONFIG_PATH;
  try {
    const config = join(w.base, "rg-config");
    await writeFile(config, "--follow\n--pre=definitely-not-a-valid-preprocessor\n");
    process.env.RIPGREP_CONFIG_PATH = config;
    const grep = createInvestigationTools(w.root).find((item) => item.name === "grep")!;
    const output = JSON.stringify(await grep.execute("flags", {
      path: ".", pattern: "SAFENEEDLE", ignoreCase: true, literal: true, context: 1, glob: "*.ts",
    }));
    assert(output.includes("safe.ts:1"));
    assert(output.includes("const other"));
    assert(!output.includes(SECRET));
    assert.equal(await readFile(join(w.root, "src", "safe.ts"), "utf8"), SOURCE);
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
    await w.dispose();
  }
});

for (const name of ["grep", "find"] as const) {
  test(name + " obeys result limits and already-aborted signals", async () => {
    const w = await workspace();
    try {
      await writeFile(join(w.root, "src", "more.ts"), SOURCE);
      const tool = createInvestigationTools(w.root).find((item) => item.name === name)!;
      const output = JSON.stringify(await tool.execute("limit", {
        path: "src", pattern: name === "grep" ? "safeNeedle" : "*.ts", limit: 1,
      }));
      assert(output.includes("limit reached"));
      await assert.rejects(tool.execute("abort", { path: ".", pattern: "*" }, AbortSignal.abort()), /abort/i);
    } finally { await w.dispose(); }
  });
}
