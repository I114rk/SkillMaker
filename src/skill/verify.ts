import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SubmittedResource } from "./schema.js";

/** How long a single syntax check may run before we give up on it. */
const CHECK_TIMEOUT_MS = 15_000;

export interface VerifyResult {
  /** Human-readable problems, ready to be fed back to the model. */
  problems: string[];
  /** Notes about checks that could not run (missing interpreters). */
  notes: string[];
}

/**
 * A syntax check command for a resource, or undefined if we have no checker.
 *
 * These read the source on stdin where the interpreter allows it, so nothing
 * is written to disk before the skill has been accepted.
 */
function checkerFor(filePath: string): { command: string; args: string[] } | undefined {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".py":
      return {
        command: "python3",
        args: ["-c", "import ast, sys; ast.parse(sys.stdin.read())"],
      };
    case ".sh":
    case ".bash":
      return { command: "bash", args: ["-n"] };
    case ".js":
    case ".mjs":
    case ".cjs":
      return { command: "node", args: ["--check"] };
    default:
      return undefined;
  }
}

/**
 * Syntax-check a resource the model wrote.
 *
 * A skill that ships a script which cannot even be parsed is worse than one
 * with no script at all: the agent follows SKILL.md into a dead end. Catching
 * a stray line here costs one model turn and saves that failure at use time.
 * Checks that cannot run at all (no interpreter) are reported as notes rather
 * than problems - a missing python3 on the generating machine says nothing
 * about the skill.
 */
export function checkResource(resource: SubmittedResource): VerifyResult {
  const checker = checkerFor(resource.path);
  if (!checker) return { problems: [], notes: [] };

  let stdinFile: string | undefined;
  let args = checker.args;

  if (checker.command === "node") {
    // `node --check` only reads from a path, so this one needs a temp file.
    stdinFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "skillmaker-check-")),
      path.basename(resource.path),
    );
    fs.writeFileSync(stdinFile, resource.content, "utf8");
    args = [...checker.args, stdinFile];
  }

  try {
    const result = spawnSync(checker.command, args, {
      input: checker.command === "node" ? undefined : resource.content,
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { problems: [], notes: [`${resource.path}: ${checker.command} not found, skipped`] };
      }
      return { problems: [`${resource.path}: ${result.error.message}`], notes: [] };
    }

    if (result.status !== 0) {
      const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(0, 6).join(" / ");
      return {
        problems: [`${resource.path} does not parse - fix the syntax: ${detail}`],
        notes: [],
      };
    }

    return { problems: [], notes: [] };
  } finally {
    if (stdinFile) fs.rmSync(path.dirname(stdinFile), { recursive: true, force: true });
  }
}

/** Run every executable-ish resource through its syntax checker. */
export function checkResources(resources: SubmittedResource[]): VerifyResult {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const resource of resources) {
    const result = checkResource(resource);
    problems.push(...result.problems);
    notes.push(...result.notes);
  }
  return { problems, notes };
}
