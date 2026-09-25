import fs from "node:fs";
import path from "node:path";
import { confirm, isCancel, multiselect, text } from "@clack/prompts";

import { SkillMakerError, ValidationError } from "./util/errors.js";
import { claudeSkillsDir } from "./util/paths.js";

/** Categories we ask about, each mapping to a concrete requirement. */
const FOCUS_AREAS = [
  { value: "workflow", label: "A step-by-step workflow the agent should follow" },
  { value: "scripts", label: "Bundled scripts the skill should run" },
  { value: "references", label: "Reference docs (API notes, formats, domain rules)" },
  { value: "examples", label: "Worked examples and edge cases" },
  { value: "tools", label: "A specific set of tools the skill may use" },
] as const;

export interface Clarifications {
  lines: string[];
}

/**
 * Unwrap a prompt result, turning the cancel symbol into an error.
 *
 * The type argument is explicit at each call site because the prompt helpers
 * return `T | symbol` and inference alone binds T to the whole union.
 */
function ensure<T>(value: unknown): T {
  if (isCancel(value)) throw new SkillMakerError("cancelled");
  return value as T;
}

/**
 * Ask what the description did not already cover.
 *
 * Only invoked when the user did not pass `--no-ask`. The questions are a fixed
 * script rather than model-generated: it keeps the turn count predictable, and
 * a fixed set is easy to skip entirely when the description is already detailed.
 */
export async function askClarifications(description: string): Promise<Clarifications> {
  const lines: string[] = [];

  const areas = ensure<readonly string[]>(
    await multiselect({
      message: "What should the skill contain? (space to toggle, enter to confirm)",
      options: [...FOCUS_AREAS],
      required: false,
    }),
  );
  if (areas.length > 0) {
    const labels = FOCUS_AREAS.filter((a) => areas.includes(a.value)).map((a) => a.label);
    lines.push(`Include: ${labels.join("; ")}.`);
  }

  const triggers = ensure<string>(
    await text({
      message:
        "What would a user say to make this skill activate? (optional, leave empty to let the model decide)",
      placeholder: "e.g. \"fill in this PDF form\"",
    }),
  ).trim();
  if (triggers) lines.push(`Trigger phrases a user would say: ${triggers}`);

  const avoids = ensure<string>(
    await text({
      message: "Anything the skill must NOT do? (optional)",
      placeholder: "leave empty for none",
    }),
  ).trim();
  if (avoids) lines.push(`Avoid: ${avoids}`);

  // Only worth asking when the description is thin - a detailed request has
  // already answered this.
  if (description.trim().length < 200) {
    const more = ensure<string>(
      await text({
        message: "Any other requirements? (optional)",
        placeholder: "leave empty to continue",
      }),
    ).trim();
    if (more) lines.push(more);
  }

  return { lines };
}

export interface InstallDecision {
  install: boolean;
}

/**
 * Resolve where the skill should be written.
 *
 * `--install` targets `~/.claude/skills`, which may not exist on a fresh
 * machine. Creating it is a change outside the working directory, so we ask
 * rather than assume.
 */
export async function resolveInstallTarget(install: boolean): Promise<string | undefined> {
  if (!install) return undefined;

  const target = claudeSkillsDir();

  if (fs.existsSync(path.dirname(target)) && !fs.existsSync(target)) {
    const create = ensure<boolean>(
      await confirm({
        message: `${target} does not exist. Create it?`,
        initialValue: true,
      }),
    );
    if (!create) return undefined;
    fs.mkdirSync(target, { recursive: true });
  }

  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) {
    throw new SkillMakerError(
      `${parent} does not exist - is Claude Code installed for this user?`,
    );
  }

  return target;
}

export { ValidationError };
