import path from "node:path";

import type Anthropic from "@anthropic-ai/sdk";

import { runToolLoop, type LoopTool } from "../llm/loop.js";
import { ValidationError } from "../util/errors.js";
import {
  GENERATE_SYSTEM_PROMPT,
  SOURCE_MATERIAL_NOTE,
  repairMessage,
} from "./prompt.js";
import { parseSubmittedSkill, type SubmittedSkill } from "./schema.js";
import { checkResources } from "./verify.js";
import {
  readSourceFile,
  renderSourceListing,
  scanSourceTree,
  type SourceTree,
} from "./sources.js";

/** Validated-output repair attempts before giving up. */
const MAX_REPAIR_ROUNDS = 2;

export interface GenerateOptions {
  client: Anthropic;
  model: string;
  /** The user's description of the skill they want. */
  request: string;
  /** Answers to the wizard's clarifying questions, appended to the request. */
  clarifications?: string[];
  /** Directory of source material the model may read. */
  sourceDir?: string;
  /** Enable the server-side web search tool for current facts. */
  web?: boolean;
  onStatus?: (message: string) => void;
}

export interface GenerateResult {
  skill: SubmittedSkill;
  /** How many API turns were spent, including repair rounds. */
  iterations: number;
}

/** The single tool that terminates generation and carries the whole skill. */
const SUBMIT_SKILL_TOOL = {
  name: "submit_skill",
  description:
    "Submit the finished Agent Skill. Call this exactly once, when the skill is complete. " +
    "The frontmatter is built from these fields - do not include it in `body`.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Skill name: lowercase letters, digits and single hyphens, max 64 chars. Must equal the directory name.",
      },
      description: {
        type: "string",
        description:
          "Max 1024 chars. Say what the skill does AND when to use it, including the words a user would type.",
      },
      license: { type: "string", description: "Optional license name or reference." },
      compatibility: {
        type: "string",
        description: "Optional, max 500 chars: environment requirements.",
      },
      metadata: {
        type: "object",
        description: "Optional string key-value pairs (e.g. author, version).",
        additionalProperties: { type: "string" },
      },
      allowed_tools: {
        type: "string",
        description:
          "Optional space-separated list of pre-approved tools, e.g. \"Bash(git:*) Read\".",
      },
      body: {
        type: "string",
        description:
          "The markdown body of SKILL.md, without frontmatter. Under 500 lines; push detail into resources.",
      },
      resources: {
        type: "array",
        description:
          "Additional files, e.g. references/REFERENCE.md or scripts/extract.py.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path relative to the skill root.",
            },
            content: { type: "string", description: "Full file content." },
            executable: {
              type: "boolean",
              description: "Set for scripts that must be runnable.",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    required: ["name", "description", "body"],
  },
} as const;

function buildUserMessage(request: string, clarifications: string[]): string {
  const parts = [`Create an Agent Skill for the following:\n\n${request}`];
  if (clarifications.length > 0) {
    parts.push(`\nAdditional requirements from the user:`);
    for (const line of clarifications) parts.push(`- ${line}`);
  }
  return parts.join("\n");
}

/**
 * Turn a description into a validated skill.
 *
 * Generation goes through a terminal tool call rather than structured outputs:
 * this proxy accepts `output_config` and silently ignores it, so the schema has
 * to be carried by a tool whose `input` arrives already parsed.
 */
export async function generateSkill(options: GenerateOptions): Promise<GenerateResult> {
  const { client, model, request, clarifications = [], sourceDir, web, onStatus } = options;

  let system = GENERATE_SYSTEM_PROMPT;
  if (sourceDir) system += SOURCE_MATERIAL_NOTE;

  // Source material is exposed as tools rather than pasted in, so a large
  // directory costs nothing until the model actually reads something.
  const tools: LoopTool[] = [];
  let tree: SourceTree | undefined;

  if (sourceDir) {
    tree = scanSourceTree(sourceDir);
    const listing = renderSourceListing(tree);
    onStatus?.(
      `source: ${tree.files.length} readable file(s) in ${path.relative(process.cwd(), tree.root) || "."}`,
    );

    tools.push({
      name: "list_source_files",
      description:
        "List the readable files in the source directory, with their sizes. Call this before reading anything.",
      inputSchema: { type: "object", properties: {} },
      run: () => listing,
    });

    tools.push({
      name: "read_source_file",
      description:
        "Read one file from the source directory. Use the exact path returned by list_source_files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the source root." },
        },
        required: ["path"],
      },
      run: (input) => {
        const relative = String(input.path ?? "");
        onStatus?.(`read ${relative}`);
        return readSourceFile(tree!, relative);
      },
    });
  }

  tools.push({
    ...SUBMIT_SKILL_TOOL,
    run: () => "received",
  });

  const serverTools: Record<string, unknown>[] = web
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]
    : [];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildUserMessage(request, clarifications) },
  ];

  let iterations = 0;

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    const result = await runToolLoop({
      client,
      model,
      system,
      messages,
      tools,
      serverTools,
      terminalTool: SUBMIT_SKILL_TOOL.name,
      onToolCall: (name) => {
        if (name !== SUBMIT_SKILL_TOOL.name) onStatus?.(`tool: ${name}`);
      },
    });

    iterations += result.iterations;

    // The directory name is the skill name, so compare against it directly.
    const directoryName =
      typeof result.result.name === "string" ? result.result.name : undefined;
    const { skill, problems } = parseSubmittedSkill(result.result, directoryName);

    if (problems.length === 0) {
      // Parsing the frontmatter is not the same as a skill that works. A
      // bundled script has to at least parse, so check before accepting.
      const { problems: scriptProblems, notes } = checkResources(skill.resources);
      for (const note of notes) onStatus?.(note);

      if (scriptProblems.length === 0) {
        return { skill, iterations };
      }

      if (round === MAX_REPAIR_ROUNDS) {
        throw new ValidationError(scriptProblems);
      }

      onStatus?.(`${scriptProblems.length} script(s) do not parse; asking for a fix`);
      messages.push(
        { role: "assistant", content: "Here is the skill I have so far." },
        { role: "user", content: repairMessage(scriptProblems) },
      );
      continue;
    }

    if (round === MAX_REPAIR_ROUNDS) {
      throw new ValidationError(problems);
    }

    onStatus?.(`validation found ${problems.length} problem(s); asking for a fix`);
    messages.push(
      { role: "assistant", content: "Here is the skill I have so far." },
      { role: "user", content: repairMessage(problems) },
    );
  }

  throw new ValidationError(["the model could not produce a valid skill"]);
}
