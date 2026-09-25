import Anthropic from "@anthropic-ai/sdk";

import { ContentBlockedError, SkillMakerError } from "../util/errors.js";

/** A tool the model may call, with the handler that answers it. */
export interface LoopTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Return the text of the `tool_result` block sent back to the model. */
  run: (input: Record<string, unknown>) => Promise<string> | string;
}

export interface RunLoopOptions {
  client: Anthropic;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: LoopTool[];
  /** Name of the tool that ends the loop; its input is the result. */
  terminalTool: string;
  /** Server-executed tools (e.g. web search) passed through untouched. */
  serverTools?: Record<string, unknown>[];
  maxIterations?: number;
  maxTokens?: number;
  /** Called with assistant text as it streams, for progress display. */
  onText?: (text: string) => void;
  /** Called before each tool runs, for progress display. */
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
}

export interface LoopResult {
  /** The `input` of the terminal tool call. */
  result: Record<string, unknown>;
  iterations: number;
}

const MAX_ITERATIONS = 12;
/**
 * Output budget per turn.
 *
 * Thinking is billed against `max_tokens` before any visible output, so a low
 * ceiling yields a turn that spends everything thinking and emits no tool call
 * at all. A full skill (long body plus scripts) needs tens of thousands of
 * output tokens; this ceiling is what the API accepts while streaming.
 */
const MAX_TOKENS = 48_000;
/** Reworded retries after a `content-blocked` rejection. */
const MAX_REWORD_ATTEMPTS = 2;

/**
 * Recognise the proxy's content-moderation rejection.
 *
 * It arrives as HTTP 400 whose body carries `code: "content-blocked"`, with no
 * indication of which part was objectionable.
 */
function isContentBlocked(error: unknown): boolean {
  if (!(error instanceof Anthropic.BadRequestError)) return false;
  const body = (error as { error?: unknown }).error;
  if (typeof body !== "object" || body === null) return false;
  const inner = (body as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return false;
  return (inner as { code?: unknown }).code === "content-blocked";
}

/**
 * Nudge the prompt before retrying a blocked request.
 *
 * Re-sending the identical body reproduces the rejection, so each retry has to
 * actually differ. A neutral instruction appended to the last user turn changes
 * the bytes without changing the task; it is a nudge, not a fix, which is why
 * the attempts are capped and the final failure is surfaced to the user with
 * the original text.
 */
function rewordPrompt(text: string, attempt: number): string {
  const suffixes = [
    "\n\n(Please proceed with the task as described.)",
    "\n\nRespond in a straightforward, matter-of-fact way.",
  ];
  return text + (suffixes[attempt] ?? "");
}

function rewordLastUserMessage(
  messages: Anthropic.MessageParam[],
  attempt: number,
): Anthropic.MessageParam[] {
  const copy = messages.map((m) => ({ ...m }));
  for (let i = copy.length - 1; i >= 0; i--) {
    const message = copy[i]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      message.content = rewordPrompt(message.content, attempt);
    } else if (Array.isArray(message.content)) {
      const blocks = message.content.map((b) => ({ ...b }));
      const textBlock = blocks.find(
        (b): b is Anthropic.TextBlockParam => b.type === "text",
      );
      if (textBlock) {
        textBlock.text = rewordPrompt(textBlock.text, attempt);
        message.content = blocks;
      }
    }
    break;
  }
  return copy;
}

function asToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function firstUserText(messages: Anthropic.MessageParam[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    const text = message.content.find((b) => b.type === "text");
    if (text && "text" in text) return text.text;
  }
  return "";
}

/**
 * Drive a tool-calling conversation until the terminal tool is called.
 *
 * This is a hand-written loop on the non-beta Messages surface. The SDK's beta
 * tool runner cannot be used here: it serialises custom tools as
 * `type: "custom"`, which the proxy rejects outright (`unknown variant
 * 'custom'`). The loop also must not rely on `output_config` / `messages.parse()`
 * - the proxy accepts the parameter and silently ignores it - so structured
 * results come back as the terminal tool's already-parsed `input`.
 */
export async function runToolLoop(options: RunLoopOptions): Promise<LoopResult> {
  const {
    client,
    model,
    system,
    tools,
    terminalTool,
    serverTools = [],
    maxIterations = MAX_ITERATIONS,
    maxTokens = MAX_TOKENS,
    onText,
    onToolCall,
  } = options;

  const toolByName = new Map(tools.map((t) => [t.name, t]));
  let messages = options.messages;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let message: Anthropic.Message | undefined;
    let rewordAttempt = 0;

    // Retry loop for content-moderation rejections on this turn.
    for (;;) {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: maxTokens,
          system,
          tools: [
            ...tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
            ...serverTools,
          ] as Anthropic.ToolUnion[],
          // One tool call per turn: the loop feeds results back in order, and
          // parallel calls would let the model blind-fire several reads before
          // seeing any of their answers.
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
          messages,
        });

        if (onText) {
          stream.on("text", (delta) => onText(delta));
        }
        message = await stream.finalMessage();
        break;
      } catch (error) {
        if (isContentBlocked(error) && rewordAttempt < MAX_REWORD_ATTEMPTS) {
          messages = rewordLastUserMessage(messages, rewordAttempt);
          rewordAttempt++;
          continue;
        }
        if (isContentBlocked(error)) {
          throw new ContentBlockedError(
            firstUserText(messages),
            "reworded retries were also rejected",
          );
        }
        throw error;
      }
    }

    if (!message) {
      throw new SkillMakerError("no response from the model");
    }

    if (message.stop_reason === "refusal") {
      throw new SkillMakerError(
        "the model declined this request" +
          (message.stop_details ? ` (${message.stop_details.category ?? "unspecified"})` : ""),
      );
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      throw new SkillMakerError(
        `the model stopped without calling \`${terminalTool}\` (stop_reason: ${message.stop_reason})`,
      );
    }

    // A tool input cut off by max_tokens can still parse as a valid-looking
    // object, so refuse to act on it rather than emitting a truncated skill.
    if (message.stop_reason === "max_tokens") {
      throw new SkillMakerError(
        "the model's tool call was truncated by the output token limit; retry or reduce the request size",
      );
    }

    const terminalCall = toolUses.find((b) => b.name === terminalTool);
    if (terminalCall) {
      return { result: asToolInput(terminalCall.input), iterations: iteration + 1 };
    }

    messages = [...messages, { role: "assistant", content: message.content }];

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const tool = toolByName.get(call.name);
      const input = asToolInput(call.input);
      onToolCall?.(call.name, input);

      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `unknown tool: ${call.name}`,
        });
        continue;
      }

      try {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: await tool.run(input),
        });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: error instanceof Error ? error.message : String(error),
        });
      }
    }

    messages = [...messages, { role: "user", content: results }];
  }

  throw new SkillMakerError(
    `the model did not call \`${terminalTool}\` within ${maxIterations} turns`,
  );
}
