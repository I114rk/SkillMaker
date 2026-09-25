import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillMakerError } from "./errors.js";

/** `~/.config/SkillMaker` (or `$XDG_CONFIG_HOME/SkillMaker` when set). */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "SkillMaker");
}

/** `~/.config/SkillMaker/config.json` - where the wizard persists settings. */
export function configFile(): string {
  return path.join(configDir(), "config.json");
}

/** `~/.claude/skills` - the user-level skill directory Claude Code reads. */
export function claudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function escapes(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return false;
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Resolve `relative` against `root`, refusing anything that escapes it.
 *
 * Model output is untrusted, so every path that comes back from the API - a
 * generated resource, a `write_file` argument - goes through here before it
 * touches the filesystem.
 */
export function resolveInside(root: string, relative: string): string {
  if (relative.trim() === "") {
    throw new SkillMakerError("path must not be empty");
  }
  if (path.isAbsolute(relative)) {
    throw new SkillMakerError(`path must be relative, got absolute path: ${relative}`);
  }
  const target = path.resolve(root, relative);
  if (escapes(path.resolve(root), target)) {
    throw new SkillMakerError(`path escapes the output directory: ${relative}`);
  }
  return target;
}

/**
 * Lexical checks miss symlinks: a directory inside `root` can link elsewhere.
 * Call this at write time, once the parent directories are known to exist.
 */
export function assertRealPathInside(root: string, target: string): void {
  const realRoot = fs.realpathSync(root);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (escapes(realRoot, realProbe)) {
    throw new SkillMakerError(
      `${path.relative(realRoot, realProbe)} resolves outside the output directory via a symlink`,
    );
  }
}

/** `sk-ant-…Rqk` - enough to recognise a key without printing it whole. */
export function maskSecret(value: string): string {
  if (value.length <= 10) return "***";
  return `${value.slice(0, 6)}…${value.slice(-3)}`;
}
