import fs from "node:fs";

import { SkillMakerError } from "../util/errors.js";

export const DEFAULT_ASSISTANT_NAME = "SkillMaker";

/** Fallback system prompt, used when `--system` is not given. */
export function defaultSystemPrompt(name: string, root: string): string {
  return `You are ${name}, a helpful assistant working in a terminal.

You are running in the directory ${root}, and you have tools to list, read and write files
inside it. Use them when the user asks about their files - do not guess at file contents.

Keep answers concise and concrete. Prefer showing the exact command or code over describing
it. If a request is ambiguous, ask before acting.

You can write files, so you can help the user build things directly - but never write outside
the working directory, and confirm before overwriting something that already exists unless the
user has clearly asked you to.`;
}

/**
 * Load the chat system prompt.
 *
 * `--system` points at a markdown file; `{{name}}` and `{{root}}` inside it are
 * substituted so a single prompt file can be reused across assistants.
 */
export function loadSystemPrompt(options: {
  name: string;
  root: string;
  systemFile?: string;
}): string {
  const { name, root, systemFile } = options;

  if (!systemFile) return defaultSystemPrompt(name, root);

  let raw: string;
  try {
    raw = fs.readFileSync(systemFile, "utf8");
  } catch (cause) {
    throw new SkillMakerError(`cannot read system prompt file: ${systemFile}`, { cause });
  }

  if (raw.trim() === "") {
    throw new SkillMakerError(`system prompt file is empty: ${systemFile}`);
  }

  return raw.replaceAll("{{name}}", name).replaceAll("{{root}}", root);
}
