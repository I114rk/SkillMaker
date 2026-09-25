import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { SubmittedSkill } from "./schema.js";
import { assertRealPathInside, resolveInside } from "../util/paths.js";
import { SkillMakerError } from "../util/errors.js";

/** Frontmatter keys in the order the spec lists them. */
function frontmatter(skill: SubmittedSkill): Record<string, unknown> {
  const front: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.license) front.license = skill.license;
  if (skill.compatibility) front.compatibility = skill.compatibility;
  if (skill.metadata && Object.keys(skill.metadata).length > 0) {
    front.metadata = skill.metadata;
  }
  if (skill.allowed_tools) front["allowed-tools"] = skill.allowed_tools;
  return front;
}

/**
 * Assemble the complete SKILL.md text.
 *
 * The frontmatter is produced by the `yaml` package rather than string
 * concatenation so that a description containing a colon, a quote or a newline
 * cannot corrupt the document.
 */
export function renderSkillMarkdown(skill: SubmittedSkill): string {
  const yaml = stringifyYaml(frontmatter(skill), { lineWidth: 0 }).trimEnd();
  const body = skill.body.replace(/^\s*\n/, "").trimEnd();
  return `---\n${yaml}\n---\n\n${body}\n`;
}

export interface WriteResult {
  skillDir: string;
  files: string[];
}

/**
 * Write a validated skill to disk.
 *
 * Every path is treated as untrusted model output: `resolveInside` rejects
 * absolute paths and `..` lexically, and `assertRealPathInside` re-checks after
 * the parent directories exist so a symlinked subdirectory cannot redirect the
 * write outside the skill.
 */
export function writeSkill(
  skill: SubmittedSkill,
  outputRoot: string,
  directoryName: string = skill.name,
): WriteResult {
  const skillDir = path.resolve(outputRoot, directoryName);
  fs.mkdirSync(skillDir, { recursive: true });
  assertRealPathInside(outputRoot, skillDir);

  const files: string[] = [];
  const skillMd = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillMd, renderSkillMarkdown(skill), "utf8");
  files.push("SKILL.md");

  for (const resource of skill.resources) {
    const target = resolveInside(skillDir, resource.path);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    // Re-check now that intermediate directories exist: a directory created
    // here (or present from an earlier run) may itself be a symlink.
    assertRealPathInside(skillDir, target);

    fs.writeFileSync(target, resource.content, {
      encoding: "utf8",
      mode: resource.executable ? 0o755 : 0o644,
    });
    if (resource.executable) fs.chmodSync(target, 0o755);
    files.push(path.relative(skillDir, target));
  }

  return { skillDir, files };
}

/**
 * Copy a written skill into `~/.claude/skills/<name>`.
 *
 * An existing install is never replaced silently: the name is the user's, and
 * the copy may be the only version of a skill they hand-edited. Pass `force`
 * to overwrite deliberately. The copy is staged next to the target and renamed
 * into place, so a failure mid-copy leaves the previous install untouched.
 */
export function installSkill(
  skillDir: string,
  destinationRoot: string,
  options: { force?: boolean } = {},
): string {
  const target = path.join(destinationRoot, path.basename(skillDir));
  const exists = fs.existsSync(target);
  if (exists && !options.force) {
    throw new SkillMakerError(
      `${target} already exists - re-run with --force to replace it`,
    );
  }

  assertRealPathInside(destinationRoot, path.dirname(target));
  const staging = `${target}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(skillDir, staging, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}
