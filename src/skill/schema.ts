import { z } from "zod";

/**
 * The shape of a skill as the model must submit it.
 *
 * The Agent Skills specification (agentskills.io/specification) fixes the
 * frontmatter rules; the constraints below mirror them so a bad generation is
 * caught here rather than by the loader.
 */
export const RESOURCE_SCHEMA = z.object({
  /** Path relative to the skill root, e.g. `references/REFERENCE.md`. */
  path: z.string().min(1),
  content: z.string(),
  /** Marks the file executable (mode 0755) after writing. */
  executable: z.boolean().optional(),
});

export const SUBMIT_SKILL_SCHEMA = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "must be lowercase letters, digits and single hyphens, with no leading, trailing or doubled hyphen",
    ),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowed_tools: z.string().optional(),
  /** Markdown body of SKILL.md, without frontmatter. */
  body: z.string().min(1),
  resources: z.array(RESOURCE_SCHEMA).default([]),
});

export type SubmittedSkill = z.infer<typeof SUBMIT_SKILL_SCHEMA>;
export type SubmittedResource = z.infer<typeof RESOURCE_SCHEMA>;

/** Maximum body length recommended by the spec; longer means "split it out". */
export const MAX_BODY_LINES = 500;
/** Minimum cacheable prefix, and a useful floor for a description's substance. */
const MIN_DESCRIPTION_CHARS = 40;

/**
 * Checks the spec states in prose rather than in a regex.
 *
 * Returns human-readable problems; an empty array means the skill is valid.
 * `directoryName` is compared against `name` because the spec requires them to
 * match - Claude Code resolves a skill by its directory.
 */
export function checkSpec(
  skill: SubmittedSkill,
  directoryName?: string,
): string[] {
  const problems: string[] = [];

  if (directoryName !== undefined && skill.name !== directoryName) {
    problems.push(
      `name "${skill.name}" must match the directory name "${directoryName}"`,
    );
  }

  if (skill.description.trim().length < MIN_DESCRIPTION_CHARS) {
    problems.push(
      "description is too thin - it must say both what the skill does and when to use it",
    );
  } else if (!/\buse (when|for|this|it)\b/i.test(skill.description)) {
    problems.push(
      "description does not say when to use the skill - add a phrase such as \"Use when ...\" with the triggers a user would mention",
    );
  }

  const bodyLines = skill.body.split("\n").length;
  if (bodyLines > MAX_BODY_LINES) {
    problems.push(
      `body is ${bodyLines} lines (max ${MAX_BODY_LINES}) - move detail into references/ and link to it`,
    );
  }

  // Frontmatter must not be duplicated inside the body: render.ts writes it.
  if (/^\s*---\s*$/m.test(skill.body.split("\n")[0] ?? "")) {
    problems.push(
      "body starts with a `---` frontmatter fence - return only the markdown body and let the tool write the frontmatter",
    );
  }

  const seen = new Set<string>();
  for (const resource of skill.resources) {
    const normalized = resource.path.replace(/^\.\//, "");
    if (seen.has(normalized)) {
      problems.push(`resource listed twice: ${normalized}`);
    }
    seen.add(normalized);

    if (normalized === "SKILL.md") {
      problems.push("SKILL.md is written from `body` - do not list it as a resource");
    }
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      problems.push(`resource path must stay inside the skill directory: ${resource.path}`);
    }
    // The spec asks references to stay one level below SKILL.md.
    const depth = normalized.split("/").length;
    if (depth > 2 && normalized.startsWith("references/")) {
      problems.push(
        `reference files should not nest more than one level deep: ${normalized}`,
      );
    }
  }

  return problems;
}

/**
 * Parse an untrusted tool input into a skill.
 *
 * Throws a `ValidationError`-shaped problem list rather than a Zod error so the
 * repair loop can hand the model readable field-level feedback.
 */
export function parseSubmittedSkill(
  input: Record<string, unknown>,
  directoryName?: string,
): { skill: SubmittedSkill; problems: string[] } {
  const parsed = SUBMIT_SKILL_SCHEMA.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return {
      skill: { ...(input as SubmittedSkill), resources: [] },
      problems,
    };
  }
  return { skill: parsed.data, problems: checkSpec(parsed.data, directoryName) };
}
