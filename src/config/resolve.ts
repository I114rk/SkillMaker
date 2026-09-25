import { loadConfig, type StoredConfig } from "./store.js";
import { SkillMakerError } from "../util/errors.js";
import { maskSecret } from "../util/paths.js";

/** Where a resolved value came from - printed so the user can see what won. */
export type Source = "flag" | "config" | "env" | "default" | "missing";

export interface Resolved<T> {
  value: T;
  source: Source;
}

export interface ResolvedSettings {
  baseURL: Resolved<string | undefined>;
  model: Resolved<string>;
  apiKey: Resolved<string>;
}

export interface FlagOverrides {
  baseURL?: string;
  model?: string;
  apiKey?: string;
}

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Env vars consulted, in order, for each setting. */
const ENV = {
  baseURL: ["ANTHROPIC_BASE_URL"],
  model: ["ANTHROPIC_MODEL"],
  apiKey: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
} as const;

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function pick<T>(
  flag: string | undefined,
  configValue: string | undefined,
  envValue: string | undefined,
  fallback: T,
): Resolved<T> {
  if (flag) return { value: flag as T, source: "flag" };
  if (configValue) return { value: configValue as T, source: "config" };
  if (envValue) return { value: envValue as T, source: "env" };
  return { value: fallback, source: fallback === undefined ? "missing" : "default" };
}

/**
 * Merge CLI flags, the config file, and the environment.
 *
 * Precedence is flag -> config -> env -> default: what you saved with
 * `skillmaker config` deliberately beats whatever happens to be exported in
 * your shell, and a one-off flag beats both.
 */
export function resolveSettings(
  flags: FlagOverrides = {},
  config: StoredConfig = loadConfig(),
): ResolvedSettings {
  const apiKeyFromEnvConfig = config.apiKeyEnv
    ? process.env[config.apiKeyEnv]?.trim()
    : undefined;
  const configKey = config.apiKey?.trim() || apiKeyFromEnvConfig;

  const apiKey = pick<string | undefined>(
    flags.apiKey,
    configKey,
    firstEnv(ENV.apiKey),
    undefined,
  );

  if (!apiKey.value) {
    throw new SkillMakerError(
      "no API key configured. Run `skillmaker config` to set one, or export ANTHROPIC_API_KEY.",
    );
  }

  return {
    baseURL: pick<string | undefined>(
      flags.baseURL,
      config.baseURL?.trim(),
      firstEnv(ENV.baseURL),
      undefined,
    ),
    model: pick<string>(flags.model, config.model?.trim(), firstEnv(ENV.model), DEFAULT_MODEL),
    apiKey: apiKey as Resolved<string>,
  };
}

const ORIGIN_NOTE: Record<Source, string> = {
  flag: "flag",
  config: "config",
  env: "env",
  default: "default",
  missing: "not set",
};

/**
 * Render the resolved settings for display, masking the key.
 *
 * `--verbose` in the CLI decides whether this is printed at all; the api key is
 * always masked, and the `apiKeyEnv` indirection is called out so a user who
 * stored a variable name does not think the value itself is in the file.
 */
export function describeSettings(
  settings: ResolvedSettings,
  config?: StoredConfig,
): string[] {
  const lines: string[] = [];
  const push = (label: string, value: string | undefined, source: Source): void => {
    lines.push(`${label}: ${value ?? "-"} (${ORIGIN_NOTE[source]})`);
  };

  push("base url", settings.baseURL.value ?? DEFAULT_BASE_URL, settings.baseURL.source);
  push("model", settings.model.value, settings.model.source);
  push("api key", maskSecret(settings.apiKey.value), settings.apiKey.source);

  if (config?.apiKeyEnv && settings.apiKey.source === "config") {
    lines.push(`  (read from $${config.apiKeyEnv})`);
  }
  return lines;
}
