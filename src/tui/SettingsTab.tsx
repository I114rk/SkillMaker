import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

import type Anthropic from "@anthropic-ai/sdk";

import { loadConfig, saveConfig, type StoredConfig } from "../config/store.js";
import { maskSecret } from "../util/paths.js";

interface SettingField {
  key: keyof StoredConfig;
  label: string;
  hint: string;
  secret?: boolean;
}

const FIELDS: SettingField[] = [
  { key: "baseURL", label: "Base URL", hint: "https://api.anthropic.com" },
  { key: "model", label: "Model", hint: "claude-opus-5" },
  { key: "apiKey", label: "API key", hint: "sk-…", secret: true },
  {
    key: "apiKeyEnv",
    label: "or read key from env var",
    hint: "ANTHROPIC_API_KEY",
  },
];

export interface SettingsTabProps {
  active: boolean;
  config: StoredConfig;
  onSaved: (config: StoredConfig) => void;
}

/**
 * Edit the persisted settings in place.
 *
 * Saving writes `~/.config/SkillMaker/config.json`; the parent is notified so
 * the other tabs pick up the new client without a restart.
 */
export function SettingsTab({ active, config, onSaved }: SettingsTabProps): React.ReactElement {
  const [draft, setDraft] = useState<StoredConfig>(config);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<string>("");

  useInput(
    (input, key) => {
      if (editing) return;
      if (key.escape) {
        setEditing(false);
        return;
      }
      if (key.upArrow) {
        setCursor((c) => (c - 1 + FIELDS.length) % FIELDS.length);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c + 1) % FIELDS.length);
        return;
      }
      if (key.return) {
        setEditing(true);
        return;
      }
      if (input === "s") {
        try {
          saveConfig(draft);
          onSaved(loadConfig());
          setStatus("saved");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (input === "r") {
        setDraft(loadConfig());
        setStatus("reloaded");
      }
    },
    { isActive: active },
  );

  const field = FIELDS[cursor]!;
  const value = draft[field.key];

  const renderValue = (): string => {
    if (value === undefined || value === "") return "(empty)";
    return field.secret ? maskSecret(String(value)) : String(value);
  };

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Text,
      { dimColor: true },
      "Settings are saved to ~/.config/SkillMaker/config.json and take precedence",
    ),
    React.createElement(
      Text,
      { dimColor: true },
      "over ANTHROPIC_BASE_URL, ANTHROPIC_MODEL and ANTHROPIC_API_KEY.",
    ),
    React.createElement(Text, null, " "),
    ...FIELDS.map((f, index) =>
      React.createElement(
        Text,
        {
          key: f.key,
          color: index === cursor ? "cyan" : undefined,
          bold: index === cursor,
        },
        `${index === cursor ? "›" : " "} ${f.label.padEnd(24)} ${
          f.key === field.key && editing
            ? ""
            : f.key === "apiKey" && draft.apiKey
              ? maskSecret(draft.apiKey)
              : draft.apiKeyEnv && f.key === "apiKeyEnv"
                ? `$${draft.apiKeyEnv}`
                : draft[f.key]
                  ? String(draft[f.key])
                  : "(empty)"
        }`,
      ),
    ),
    editing
      ? React.createElement(
          Box,
          null,
          React.createElement(Text, { color: "cyan" }, "› "),
          React.createElement(TextInput, {
            value: value === undefined ? "" : String(value),
            onChange: (next) =>
              setDraft((prev) => ({ ...prev, [field.key]: next === "" ? undefined : next })),
            onSubmit: () => setEditing(false),
          }),
        )
      : null,
    React.createElement(Text, null, " "),
    React.createElement(
      Text,
      { dimColor: true },
      editing
        ? "Enter save field · Esc cancel"
        : "Enter edit · s save to disk · r reload · Tab switch tabs",
    ),
    status
      ? React.createElement(
          Text,
          { color: status === "saved" || status === "reloaded" ? "green" : "red" },
          ` ${status}`,
        )
      : null,
  );
}
