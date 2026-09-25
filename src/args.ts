import { UsageError } from "./util/errors.js";

export type Command = "create" | "chat" | "config" | "tui" | "help" | "version";

export interface ParsedArgs {
  command: Command;
  /** Positional arguments after the command (for `create`, the description). */
  positional: string[];
  from?: string;
  out?: string;
  install: boolean;
  force: boolean;
  ask: boolean;
  web: boolean;
  name?: string;
  system?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  verbose: boolean;
}

const COMMANDS = new Set<string>(["create", "chat", "config", "tui", "help", "version"]);

interface FlagSpec {
  key: keyof ParsedArgs | "help" | "version";
  takesValue: boolean;
}

const FLAGS: Record<string, FlagSpec> = {
  "--from": { key: "from", takesValue: true },
  "--out": { key: "out", takesValue: true },
  "--install": { key: "install", takesValue: false },
  "--force": { key: "force", takesValue: false },
  "--no-ask": { key: "ask", takesValue: false },
  "--ask": { key: "ask", takesValue: false },
  "--web": { key: "web", takesValue: false },
  "--name": { key: "name", takesValue: true },
  "--system": { key: "system", takesValue: true },
  "--base-url": { key: "baseURL", takesValue: true },
  "--model": { key: "model", takesValue: true },
  "--api-key": { key: "apiKey", takesValue: true },
  "--verbose": { key: "verbose", takesValue: false },
  "--help": { key: "help", takesValue: false },
  "-h": { key: "help", takesValue: false },
  "--version": { key: "version", takesValue: false },
  "-v": { key: "version", takesValue: false },
};

export const USAGE = `skillmaker - generate Claude Code Agent Skills, and chat with an API

Usage:
  skillmaker                               open the interactive UI (tabs: Generate / Chat / Settings)
  skillmaker tui                           same, explicitly
  skillmaker create "<description>" [options]
  skillmaker chat [options]
  skillmaker config
  skillmaker "<description>"                shorthand for \`create\`

Options for create:
  --from <dir>      read source material from a directory (or a codebase: --from .)
  --out <dir>       write the skill under <dir> instead of the current directory
  --install         also copy the finished skill into ~/.claude/skills
  --force           replace an already-installed skill of the same name
  --no-ask          skip the clarifying questions
  --web             let the model search the web for current facts

Options for chat:
  --name <name>     the assistant's name (default: SkillMaker)
  --system <file>   read the system prompt from a markdown file

Options for any command:
  --base-url <url>  override the API base URL
  --model <id>      override the model
  --api-key <key>   override the API key
  --verbose         show which setting came from where

Run \`skillmaker config\` to set a base URL, model and API key, saved to
~/.config/SkillMaker/config.json. Settings there take precedence over the
ANTHROPIC_BASE_URL, ANTHROPIC_MODEL and ANTHROPIC_API_KEY environment variables.`;

/**
 * Parse argv into a command plus options.
 *
 * Unknown flags are an error rather than silently ignored: a typo like
 * `--istall` should not quietly produce a skill that was never installed.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "tui",
    positional: [],
    install: false,
    force: false,
    ask: true,
    web: false,
    verbose: false,
  };

  let commandSeen = false;
  let sawFlagHelp = false;
  let sawFlagVersion = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--") {
      args.positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("-") && arg !== "-") {
      const [flag, inlineValue] = arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];

      const spec = FLAGS[flag];
      if (!spec) {
        throw new UsageError(`unknown option: ${flag}\n\n${USAGE}`);
      }

      if (flag === "--help" || flag === "-h") {
        sawFlagHelp = true;
        continue;
      }
      if (flag === "--version" || flag === "-v") {
        sawFlagVersion = true;
        continue;
      }

      if (spec.takesValue) {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) {
          throw new UsageError(`option ${flag} requires a value`);
        }
        (args as unknown as Record<string, unknown>)[spec.key] = value;
      } else {
        (args as unknown as Record<string, unknown>)[spec.key] =
          flag === "--no-ask" ? false : true;
      }
      continue;
    }

    if (!commandSeen && COMMANDS.has(arg)) {
      args.command = arg as Command;
      commandSeen = true;
      continue;
    }

    args.positional.push(arg);
  }

  if (sawFlagHelp) return { ...args, command: "help" };
  if (sawFlagVersion) return { ...args, command: "version" };

  // A bare description with no command is the common shorthand:
  // `skillmaker "summarise git history"` means `create`.
  if (args.command === "tui" && args.positional.length > 0) {
    return { ...args, command: "create" };
  }

  return args;
}
