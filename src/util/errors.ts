/** Base class for every error SkillMaker raises deliberately. */
export class SkillMakerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Bad CLI usage: unknown command, missing argument, conflicting flags. */
export class UsageError extends SkillMakerError {}

/**
 * The API rejected the request body with `content-blocked`.
 *
 * The rejection is content-based and reproducible: the same prompt fails every
 * time, so re-sending the identical text is pointless. Callers must reword.
 */
export class ContentBlockedError extends SkillMakerError {
  readonly prompt: string;

  constructor(prompt: string, detail?: string) {
    super(
      `the API rejected this request as blocked content${detail ? ` (${detail})` : ""}`,
    );
    this.prompt = prompt;
  }
}

/** The model's output did not satisfy the Agent Skills specification. */
export class ValidationError extends SkillMakerError {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`generated skill failed validation:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}
