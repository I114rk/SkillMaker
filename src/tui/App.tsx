import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

import type Anthropic from "@anthropic-ai/sdk";

import { resolveSettings, describeSettings, type ResolvedSettings } from "../config/resolve.js";
import { loadConfig } from "../config/store.js";
import { createClient } from "../llm/client.js";
import { SkillMakerError } from "../util/errors.js";
import { GenerateTab } from "./GenerateTab.js";
import { ChatTab } from "./ChatTab.js";
import { SettingsTab } from "./SettingsTab.js";

export type TabId = "generate" | "chat" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "generate", label: "Generate" },
  { id: "chat", label: "Chat" },
  { id: "settings", label: "Settings" },
];

export interface TuiOptions {
  /** Start on this tab; defaults to Generate, or Settings when unconfigured. */
  initialTab?: TabId;
  /** Assistant name shown in the Chat tab. */
  assistantName?: string;
  /** Path to a markdown system prompt for the Chat tab. */
  systemFile?: string;
}

function TabBar({ active }: { active: TabId }): React.ReactElement {
  return React.createElement(
    Box,
    { marginBottom: 1 },
    ...TABS.flatMap((tab, index) => {
      const isActive = tab.id === active;
      const node = React.createElement(
        Text,
        {
          key: tab.id,
          backgroundColor: isActive ? "cyan" : undefined,
          color: isActive ? "black" : "gray",
          bold: isActive,
        },
        ` ${tab.label} `,
      );
      return index === 0
        ? [node]
        : [React.createElement(Text, { key: `${tab.id}-sep`, dimColor: true }, "│"), node];
    }),
  );
}

function App({ initialTab, assistantName, systemFile }: TuiOptions): React.ReactElement {
  const { exit } = useApp();

  const [config, setConfig] = useState(() => loadConfig());

  // Settings can be unusable on first run (no API key anywhere); the Settings
  // tab is then the only useful place to be.
  const initial = useMemo(() => {
    if (initialTab) return initialTab;
    try {
      resolveSettings({}, loadConfig());
      return "generate" as TabId;
    } catch {
      return "settings" as TabId;
    }
  }, [initialTab]);

  const [tab, setTab] = useState<TabId>(initial);

  let settings: ResolvedSettings | undefined;
  let settingsError: string | undefined;
  try {
    settings = resolveSettings({}, config);
  } catch (error) {
    settingsError = error instanceof SkillMakerError ? error.message : String(error);
  }

  const client: Anthropic | undefined = useMemo(
    () => (settings ? createClient(settings) : undefined),
    [settings?.apiKey.value, settings?.baseURL.value, settings?.model.value],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    // Tab cycles forward, Shift+Tab backward.
    if (key.tab) {
      const direction = key.shift ? -1 : 1;
      const index = TABS.findIndex((t) => t.id === tab);
      const next = (index + direction + TABS.length) % TABS.length;
      setTab(TABS[next]!.id);
    }
  });

  const header = settings
    ? describeSettings(settings, config)[1]
    : `not configured - ${settingsError ?? ""}`;

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Box,
      { justifyContent: "space-between", width: "100%" },
      React.createElement(Text, { bold: true, color: "cyan" }, " skillmaker "),
      React.createElement(Text, { dimColor: true }, `${header} `),
    ),
    React.createElement(TabBar, { active: tab }),
    tab === "generate"
      ? React.createElement(GenerateTab, {
          active: true,
          client,
          settings,
          onNeedSettings: () => setTab("settings"),
        })
      : null,
    tab === "chat"
      ? React.createElement(ChatTab, {
          active: true,
          client,
          settings,
          onNeedSettings: () => setTab("settings"),
          ...(assistantName ? { assistantName } : {}),
          ...(systemFile ? { systemFile } : {}),
        })
      : null,
    tab === "settings"
      ? React.createElement(SettingsTab, {
          active: true,
          config,
          onSaved: (next) => setConfig(next),
        })
      : null,
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(
        Text,
        { dimColor: true },
        "Tab switch tabs · ↑↓ move · Enter confirm · Esc back · Ctrl+C quit",
      ),
    ),
  );
}

/** Launch the interactive TUI. Resolves when the user quits. */
export async function startTui(options: TuiOptions = {}): Promise<void> {
  const app = render(React.createElement(App, options), {
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await app.waitUntilExit();
}