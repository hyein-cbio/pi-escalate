import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ERROR = "Read-only investigation path is outside the cwd filesystem boundary.";

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Pi-compatible shorthands; literal Unicode filenames are tried before space normalization. */
function resolveInput(input: string, root: string, spaces = false): string {
  let path = spaces ? input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ") : input;
  if (path.startsWith("@")) path = path.slice(1);
  if (process.platform === "win32" && !path.startsWith("//") && !path.includes("\\")) {
    const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) path = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    path = join(homedir(), path.slice(2));
  }
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(root, path);
}

/** Application-level read boundary, not an OS sandbox or an inode/TOCTOU guarantee. */
export class ReadBoundary {
  readonly root: string;

  constructor(cwd: string) {
    this.root = realpathSync(cwd);
  }

  async checkAbsolute(path: string): Promise<string> {
    const canonical = await realpath(path);
    if (!inside(this.root, canonical)) throw new Error(ERROR);
    return canonical;
  }

  async check(input: string): Promise<string> {
    const literal = resolveInput(input, this.root);
    try {
      return await this.checkAbsolute(literal);
    } catch (error) {
      // An existing external path must never be reinterpreted as an internal one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A broken literal symlink is still an existing entry, not a spelling fallback.
      try { await lstat(literal); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") {
          const normalized = resolveInput(input, this.root, true);
          if (normalized !== literal) return this.checkAbsolute(normalized);
        }
        throw error;
      }
      throw error;
    }
  }

  async allows(path: string): Promise<boolean> {
    try { await this.checkAbsolute(path); return true; }
    catch { return false; }
  }
}
