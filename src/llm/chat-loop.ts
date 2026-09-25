import Anthropic from "@anthropic-ai/sdk";

import { ContentBlockedError, SkillMakerError } from "../util/errors.js";
import type { LoopTool } from "./loop.js";

export interface ChatTurnOptions {
  client: Anthropic;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: LoopTool[];
  maxIterations?: number;
  maxTokens?: number;
  /** Called with assistant text as it streams. */
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export interface ChatTurnResult {
  /** The assistant's visible text for this turn. */
  text: string;
  /** Full turn content, to append to history. */
  content: Anthropic.ContentBlock[];
}

const MAX_ITERATIONS = 16;
const MAX_TOKENS = 16_000;
const MAX_REWORD_ATTEMPTS = 2;

function isContentBlocked(error: unknown): boolean {
  if (!(error instanceof Anthropic.BadRequestError)) return false;
  const body = (error as { error?: unknown }).error;
  if (typeof body !== "object" || body === null) return false;
  const inner = (body as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return false;
  return (inner as { code?: unknown }).code === "content-blocked";
}

function asToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Run one chat turn, executing any tool calls the model makes.
 *
 * Unlike `runToolLoop` there is no terminal tool - the turn ends when the model
 * stops asking for tools. The caller's `messages` array is mutated in place so
 * the conversation history stays in one place.
 *
 * Streaming is used on every turn because chat responses can be long, and the
 * text callback fires as deltas arrive.
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const {
    client,
    model,
    system,
    messages,
    tools = [],
    maxIterations = MAX_ITERATIONS,
    maxTokens = MAX_TOKENS,
    onText,
    onToolCall,
    signal,
  } = options;

  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const turnText: string[] = [];
  const turnContent: Anthropic.ContentBlock[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let message: Anthropic.Message | undefined;

    for (let attempt = 0; ; attempt++) {
      try {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            system,
            ...(tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  })) as Anthropic.ToolUnion[],
                }
              : {}),
            messages,
          },
          { signal },
        );

        if (onText) stream.on("text", (delta) => onText(delta));
        message = await stream.finalMessage();
        break;
      } catch (error) {
        if (isContentBlocked(error)) {
          throw new ContentBlockedError(
            "(chat message)",
            attempt >= MAX_REWORD_ATTEMPTS
              ? "reworded retries were also rejected"
              : "try rephrasing your message",
          );
        }
        if (error instanceof Anthropic.APIUserAbortError) {
          return { text: turnText.join(""), content: turnContent };
        }
        throw error;
      }
    }

    if (!message) throw new SkillMakerError("no response from the model");

    turnContent.push(...message.content);
    for (const block of message.content) {
      if (block.type === "text") turnText.push(block.text);
    }

    if (message.stop_reason === "refusal") {
      throw new SkillMakerError(
        "the model declined this request" +
          (message.stop_details?.category ? ` (${message.stop_details.category})` : ""),
      );
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      messages.push({ role: "assistant", content: message.content });
      return { text: turnText.join(""), content: turnContent };
    }

    // The assistant turn has to be in history for the results to make sense.
    messages.push({ role: "assistant", content: message.content });

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

    messages.push({ role: "user", content: results });
  }

  throw new SkillMakerError(`the model kept calling tools for ${maxIterations} turns`);
}
