import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

import type Anthropic from "@anthropic-ai/sdk";

import { generateSkill } from "../skill/generate.js";
import { writeSkill, installSkill } from "../skill/render.js";
import { resolveInstallTarget } from "../create.js";
import type { ResolvedSettings } from "../config/resolve.js";
import { claudeSkillsDir } from "../util/paths.js";

type Phase = "idle" | "running" | "done" | "error";

export interface GenerateTabProps {
  active: boolean;
  client: Anthropic | undefined;
  settings: ResolvedSettings | undefined;
  onNeedSettings: () => void;
}

interface LogLine {
  kind: "status" | "error" | "ok";
  text: string;
}

/**
 * The Generate tab: type a description, watch progress, get a skill on disk.
 *
 * Generation takes minutes, so the log is the main feedback surface - each
 * status line is a real event from the generation loop, not a spinner.
 */
export function GenerateTab({
  active,
  client,
  settings,
  onNeedSettings,
}: GenerateTabProps): React.ReactElement {
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState("");
  const [out, setOut] = useState("");
  const [install, setInstall] = useState(false);
  const [installForce, setInstallForce] = useState(false);
  const [web, setWeb] = useState(false);
  const [focus, setFocus] = useState<"description" | "from" | "out" | "toggles">("description");
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<LogLine[]>([]);
  const [result, setResult] = useState<string>("");

  const push = (line: LogLine): void => setLog((prev) => [...prev.slice(-200), line]);
  const busy = phase === "running";

  // Enter in the Description field starts the run. The single-key toggles only
  // apply once the toggles row itself has focus - otherwise typing a
  // description containing "w" or "i" would flip them mid-sentence.
  const cycle = (direction: 1 | -1): void =>
    setFocus((f) => {
      const order: (typeof f)[] = ["description", "from", "out", "toggles"];
      const next = (order.indexOf(f) + direction + order.length) % order.length;
      return order[next]!;
    });

  useInput(
    (input, key) => {
      if (busy) return;
      if (key.tab || key.downArrow) {
        cycle(1);
        return;
      }
      if (key.upArrow) {
        cycle(-1);
        return;
      }
      if (focus !== "toggles") return;
      if (input === "i") setInstall((v) => !v);
      if (input === "f") setInstallForce((v) => !v);
      if (input === "w") setWeb((v) => !v);
      if (input === "s" && !client) onNeedSettings();
    },
    { isActive: active },
  );

  async function run(): Promise<void> {
    if (!client || !settings) {
      onNeedSettings();
      return;
    }
    if (description.trim() === "") {
      push({ kind: "error", text: "describe the skill you want first" });
      return;
    }

    setPhase("running");
    setLog([]);
    setResult("");

    try {
      const { skill, iterations } = await generateSkill({
        client,
        model: settings.model.value,
        request: description.trim(),
        ...(from.trim() ? { sourceDir: from.trim() } : {}),
        web,
        onStatus: (message) => push({ kind: "status", text: message }),
      });

      const root = out.trim() === "" ? process.cwd() : out.trim();
      const { skillDir, files } = writeSkill(skill, root);
      push({ kind: "ok", text: `${skill.name} → ${skillDir}` });
      for (const file of files) push({ kind: "status", text: `  ${file}` });
      push({ kind: "status", text: `  ${iterations} model turn(s)` });

      if (install) {
        const target = await resolveInstallTarget(true);
        if (target) {
          const installed = installSkill(skillDir, target, { force: installForce });
          push({ kind: "ok", text: `installed → ${installed}` });
        } else {
          push({ kind: "status", text: "install skipped" });
        }
      }

      setResult(skillDir);
      setPhase("done");
    } catch (error) {
      push({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      setPhase("error");
    }
  }

  if (!client) {
    return React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "yellow" }, "Not configured yet."),
      React.createElement(Text, null, "Open the Settings tab (Tab) to set a base URL, model and API key."),
    );
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    id: typeof focus,
    placeholder: string,
  ): React.ReactElement =>
    React.createElement(
      Box,
      { key: id },
      React.createElement(
        Text,
        { color: focus === id ? "cyan" : undefined, bold: focus === id },
        `${focus === id ? "›" : " "} ${label.padEnd(13)}`,
      ),
      React.createElement(TextInput, {
        value,
        onChange: set,
        onSubmit: () => {
          if (id === "description") void run();
        },
        focus: active && focus === id && !busy,
        placeholder,
      }),
    );

  const toggles = (
    <Box key="toggles">
      <Text color={focus === "toggles" ? "cyan" : undefined} bold={focus === "toggles"}>
        {`${focus === "toggles" ? "›" : " "} `}
      </Text>
      <Text color={install ? "green" : "gray"}>
        {`${install ? "[x]" : "[ ]"} install to ${claudeSkillsDir()}`}
      </Text>
      <Text dimColor> (i)</Text>
      <Text color={installForce ? "green" : "gray"}>
        {`   ${installForce ? "[x]" : "[ ]"} replace if present`}
      </Text>
      <Text dimColor> (f)</Text>
      <Text color={web ? "green" : "gray"}>{`   ${web ? "[x]" : "[ ]"} web search`}</Text>
      <Text dimColor> (w)</Text>
    </Box>
  );

  const visible = log.slice(-14);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    field("Description", description, setDescription, "description", "e.g. extract tables from PDFs"),
    field("From dir", from, setFrom, "from", "(optional) folder or codebase to read"),
    field("Output dir", out, setOut, "out", `(default) ${process.cwd()}`),
    toggles,
    React.createElement(Text, null, " "),
    busy
      ? React.createElement(Text, { color: "cyan" }, "● generating… (this takes a few minutes)")
      : React.createElement(
          Text,
          { dimColor: true },
          "Enter in the Description field starts generation",
        ),
    ...visible.map((line, index) =>
      React.createElement(
        Text,
        {
          key: `${index}-${line.kind}`,
          color: line.kind === "error" ? "red" : line.kind === "ok" ? "green" : undefined,
          dimColor: line.kind === "status",
        },
        `  ${line.text}`,
      ),
    ),
    phase === "done" && result
      ? React.createElement(Text, { color: "green" }, `\n  done → ${result}`)
      : null,
  );
}
