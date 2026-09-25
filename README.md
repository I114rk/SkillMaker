# SkillMaker

Generate [Claude Code Agent Skills](https://agentskills.io/specification) from a
plain-language description, and chat with any Anthropic-compatible API. One
command opens a TUI where **Tab** switches between Generate, Chat and Settings.

```bash
npm install
npm run build
node bin/skillmaker.mjs
```

## Commands

```
skillmaker                     open the TUI (Generate / Chat / Settings)
skillmaker "<description>"     shorthand for `create`
skillmaker create "<desc>"     generate a skill
skillmaker chat                open the TUI on the Chat tab
skillmaker config              set base URL, model and API key
```

Bare `skillmaker` is the normal entry point. On the first run the Settings tab
opens automatically because nothing is configured yet.

### `create` options

| Flag | Effect |
| --- | --- |
| `--from <dir>` | read source material from a directory (or a whole codebase: `--from .`) |
| `--out <dir>` | write the skill under `<dir>` instead of the current directory |
| `--install` | also copy the finished skill into `~/.claude/skills` |
| `--force` | replace an already-installed skill of the same name |
| `--no-ask` | skip the clarifying questions |
| `--web` | let the model search the web for current facts |

### `chat` options

| Flag | Effect |
| --- | --- |
| `--name <name>` | the assistant's name (default: `SkillMaker`) |
| `--system <file>` | read the system prompt from a markdown file |

### Any command

`--base-url <url>`, `--model <id>`, `--api-key <key>` override configuration for
one run; `--verbose` prints which source supplied each setting.

## Configuration

Settings live in `~/.config/SkillMaker/config.json`, written with mode `0600`.
Resolution order is **CLI flag → config file → environment → default**:

```
model: claude-opus-5 (config)
api key: sk-…Rqk (env)
```

The config file deliberately beats `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`,
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` — an explicit `skillmaker config`
should not be quietly overridden by a stray environment variable. The key is
stored either as a value or as the *name* of an environment variable to read
(`apiKeyEnv`). It is stored in plaintext, and the wizard says so.

## What a generated skill looks like

```
csv-to-markdown-table/
  SKILL.md                     frontmatter + instructions, under 500 lines
  scripts/csv_to_markdown.py
  references/conversion-rules.md
```

`SKILL.md` carries `name`, `description`, and optionally `license`,
`compatibility`, `metadata` and `allowed-tools`. The `description` must state
both *what* the skill does and *when* to use it, including the words a user
would actually type — that is what Claude Code matches against when deciding to
load the skill.

Generated scripts are syntax-checked before the skill is accepted, and a
failure is fed back to the model for a bounded number of repair rounds. A skill
whose bundled script does not even parse is worse than one with no script at
all.

## Notes on the implementation

This tool talks to Anthropic-compatible APIs directly. Three constraints of that
surface shape the code, and are worth knowing before changing it:

- **The agentic loop is hand-written** (`src/llm/loop.ts`) on the non-beta
  Messages API. The SDK's beta tool runner serialises custom tools as
  `type: "custom"`, which not every compatible router accepts.
- **Structured output goes through a terminal tool call.** `submit_skill`
  carries the whole skill as its `input`, which arrives already parsed, rather
  than relying on `output_config.format`.
- **Thinking blocks are echoed back verbatim** between turns. Dropping them is
  rejected by thinking-enabled backends.
- **`max_tokens` covers thinking plus output.** Too small a budget leaves no
  room for the tool call at all, so the loop streams with a generous ceiling.

Paths from the model are untrusted. Resources are resolved inside the output
directory lexically and re-checked through `realpath` after their parents exist,
so neither `../../evil.md` nor a symlink escapes.

## Security

`skillmaker --install` copies into `~/.claude/skills`, which Claude Code loads
and trusts. An existing skill is never replaced silently; `--force` is required.
Review a generated skill before installing it — it is model output.
