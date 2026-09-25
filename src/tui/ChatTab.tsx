import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

import type Anthropic from "@anthropic-ai/sdk";

import { runChatTurn } from "../llm/chat-loop.js";
import { createChatTools } from "../chat/tools.js";
import { defaultSystemPrompt, loadSystemPrompt } from "../chat/prompt.js";
import type { ResolvedSettings } from "../config/resolve.js";

export interface ChatTabProps {
  active: boolean;
  client: Anthropic | undefined;
  settings: ResolvedSettings | undefined;
  onNeedSettings: () => void;
  /** Assistant name, from `--name`. */
  assistantName?: string;
  /** Markdown file with the system prompt, from `--system`. */
  systemFile?: string;
}

interface Line {
  kind: "user" | "assistant" | "note" | "error";
  text: string;
}

/**
 * The Chat tab: a conversation with file tools, scoped to the working directory.
 *
 * History lives in a ref (API state, not render state) so streaming deltas do
 * not touch it; `busy` blocks input while a turn is in flight.
 */
export function ChatTab({
  active,
  client,
  settings,
  onNeedSettings,
  assistantName,
  systemFile,
}: ChatTabProps): React.ReactElement {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");

  const history = useRef<Anthropic.MessageParam[]>([]);
  const abort = useRef<AbortController | null>(null);
  const root = process.cwd();
  const name = assistantName?.trim() || "SkillMaker";

  const tools = useMemo(
    () =>
      createChatTools({
        root,
        onNote: (message) => setLines((prev) => [...prev, { kind: "note", text: message }]),
      }),
    [root],
  );

  const system = useMemo(() => {
    try {
      return loadSystemPrompt({
        name,
        root,
        ...(systemFile ? { systemFile } : {}),
      });
    } catch (error) {
      // A missing or unreadable --system file should not take down the tab.
      return defaultSystemPrompt(name, root);
    }
  }, [root, name, systemFile]);

  useInput(
    (_input, key) => {
      if (!busy) return;
      // Escape aborts an in-flight turn.
      if (key.escape) {
        abort.current?.abort();
      }
    },
    { isActive: active },
  );

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    if (!client || !settings) {
      onNeedSettings();
      return;
    }

    if (trimmed === "/clear") {
      history.current = [];
      setLines([]);
      setInput("");
      return;
    }

    setInput("");
    setLines((prev) => [...prev, { kind: "user", text: trimmed }]);
    history.current.push({ role: "user", content: trimmed });

    setBusy(true);
    setStreaming("");
    abort.current = new AbortController();

    let buffered = "";
    try {
      const result = await runChatTurn({
        client,
        model: settings.model.value,
        system,
        messages: history.current,
        tools,
        signal: abort.current.signal,
        onText: (delta) => {
          buffered += delta;
          setStreaming(buffered);
        },
      });
      setStreaming("");
      if (result.text.trim() !== "") {
        setLines((prev) => [...prev, { kind: "assistant", text: result.text }]);
      }
    } catch (error) {
      setStreaming("");
      setLines((prev) => [
        ...prev,
        { kind: "error", text: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  if (!client) {
    return React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "yellow" }, "Not configured yet."),
      React.createElement(Text, null, "Open the Settings tab (Tab) first."),
    );
  }

  const visible = lines.slice(-12);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Text,
      { dimColor: true },
      `chatting in ${root} · /clear to reset · Esc aborts a reply`,
    ),
    React.createElement(Text, null, " "),
    ...visible.map((line, index) =>
      React.createElement(
        Text,
        {
          key: `${index}-${line.kind}`,
          color:
            line.kind === "error"
              ? "red"
              : line.kind === "note"
                ? "yellow"
                : line.kind === "user"
                  ? "cyan"
                  : undefined,
          dimColor: line.kind === "note",
        },
        line.kind === "user" ? `› ${line.text}` : `  ${line.text}`,
      ),
    ),
    busy
      ? React.createElement(
          Text,
          null,
          streaming ? `  ${streaming}` : React.createElement(Text, { dimColor: true }, "  …"),
        )
      : null,
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: "green" }, "› "),
      React.createElement(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: (value: string) => {
          void send(value);
        },
        focus: active && !busy,
        placeholder: busy ? "" : "ask something, or request a file",
      }),
    ),
  );
}
