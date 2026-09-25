import path from "node:path";

import { parseArgs, USAGE, type ParsedArgs } from "./args.js";
import { runConfigWizard, ensureConfigured } from "./config/wizard.js";
import { describeSettings, resolveSettings } from "./config/resolve.js";
import { loadConfig } from "./config/store.js";
import { askClarifications, resolveInstallTarget } from "./create.js";
import { createClient } from "./llm/client.js";
import { generateSkill } from "./skill/generate.js";
import { installSkill, writeSkill } from "./skill/render.js";
import { startTui } from "./tui/App.js";
import { DEFAULT_ASSISTANT_NAME } from "./chat/prompt.js";
import { SkillMakerError, UsageError, ValidationError } from "./util/errors.js";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

function stdout(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function flagOverrides(args: ParsedArgs): { baseURL?: string; model?: string; apiKey?: string } {
  const overrides: { baseURL?: string; model?: string; apiKey?: string } = {};
  if (args.baseURL) overrides.baseURL = args.baseURL;
  if (args.model) overrides.model = args.model;
  if (args.apiKey) overrides.apiKey = args.apiKey;
  return overrides;
}

async function runConfig(args: ParsedArgs): Promise<number> {
  await runConfigWizard(flagOverrides(args), { force: true });
  return EXIT_OK;
}

async function runCreate(args: ParsedArgs): Promise<number> {
  const description = args.positional.join(" ").trim();
  if (description === "") {
    throw new UsageError(
      "create needs a description, e.g. `skillmaker create \"summarise git history\"`",
    );
  }

  const overrides = flagOverrides(args);
  await ensureConfigured(overrides);

  const config = loadConfig();
  const settings = resolveSettings(overrides, config);

  if (args.verbose) {
    for (const line of describeSettings(settings, config)) stdout(line);
  }

  const client = createClient(settings);

  let clarifications: string[] = [];
  if (args.ask && process.stdin.isTTY) {
    const answers = await askClarifications(description);
    clarifications = answers.lines;
  }

  const status = (message: string): void => {
    process.stderr.write(`  ${message}\n`);
  };

  const sourceDir = args.from ? path.resolve(args.from) : undefined;

  stdout("");
  status("generating…");

  const { skill, iterations } = await generateSkill({
    client,
    model: settings.model.value,
    request: description,
    clarifications,
    ...(sourceDir ? { sourceDir } : {}),
    web: args.web,
    onStatus: status,
  });

  const outputRoot = path.resolve(args.out ?? ".");
  const { skillDir, files } = writeSkill(skill, outputRoot);

  stdout("");
  stdout(`${skill.name} → ${path.relative(process.cwd(), skillDir) || "."}`);
  for (const file of files) stdout(`  ${file}`);
  stdout(`  ${iterations} model turn(s)`);

  if (args.install) {
    const installRoot = await resolveInstallTarget(true);
    if (installRoot) {
      const installed = installSkill(skillDir, installRoot, { force: args.force });
      stdout(`  installed → ${installed}`);
    } else {
      stdout("  skipped install");
    }
  }

  return EXIT_OK;
}

/**
 * `skillmaker chat` - open the interactive UI directly on the Chat tab.
 *
 * The chat lives in the TUI rather than a separate REPL so there is one
 * interface to maintain and the Settings tab is always one keypress away.
 */
async function runChat(args: ParsedArgs): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new SkillMakerError("chat needs an interactive terminal");
  }

  const config = loadConfig();
  const name = args.name?.trim() || DEFAULT_ASSISTANT_NAME;

  if (args.name || args.system) {
    stdout(`starting chat as ${name}`);
  }

  await startTui({
    initialTab: "chat",
    ...(args.name ? { assistantName: args.name } : {}),
    ...(args.system ? { systemFile: path.resolve(args.system) } : {}),
  });
  return EXIT_OK;
}

async function runTui(): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new SkillMakerError(
      "the interactive UI needs a terminal. Use `skillmaker create \"...\"` instead.",
    );
  }
  await startTui();
  return EXIT_OK;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "help":
      stdout(USAGE);
      return EXIT_OK;
    case "version": {
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const here = path.dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(
        readFileSync(path.join(here, "..", "package.json"), "utf8"),
      ) as { version?: string };
      stdout(`skillmaker ${pkg.version ?? "0.0.0"}`);
      return EXIT_OK;
    }
    case "config":
      return runConfig(args);
    case "chat":
      return runChat(args);
    case "tui":
      return runTui();
    case "create":
      return runCreate(args);
    default:
      throw new UsageError(`unknown command: ${args.command}\n\n${USAGE}`);
  }
}

/** Entry point used by `bin/skillmaker.mjs`. */
export async function run(argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    if (error instanceof ValidationError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.stderr.write(
        "The model could not produce a spec-compliant skill. Try a more specific description,\n" +
          "or add --from <dir> with reference material.\n",
      );
      process.exitCode = EXIT_FAIL;
      return;
    }
    if (error instanceof SkillMakerError) {
      process.stderr.write(`\nerror: ${error.message}\n`);
      process.exitCode = EXIT_FAIL;
      return;
    }
    if (error instanceof Error && error.name === "AbortError") {
      process.exitCode = 130;
      return;
    }
    process.stderr.write(`\nunexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = EXIT_FAIL;
  }
}
