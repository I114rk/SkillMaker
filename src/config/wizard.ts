import { confirm, isCancel, password, select, text } from "@clack/prompts";

import { DEFAULT_MODEL, resolveSettings, type FlagOverrides } from "./resolve.js";
import { loadConfig, saveConfig, type StoredConfig } from "./store.js";
import { SkillMakerError } from "../util/errors.js";
import { maskSecret } from "../util/paths.js";

interface ModelOption {
  value: string;
  label: string;
}

/**
 * Ask the API which models it serves, so the wizard offers real choices.
 *
 * A local routing proxy reports its own catalogue here, which is exactly the
 * case where a hardcoded list would be wrong.
 */
async function fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return [];
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) =>
        typeof entry === "object" && entry !== null
          ? String((entry as { id?: unknown }).id ?? "")
          : "",
      )
      .filter((id) => id !== "");
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unwrap a prompt result, turning the cancel symbol into an error.
 *
 * The type argument is explicit at each call site because the prompt helpers
 * return `T | symbol` and inference alone binds T to the whole union.
 */
function ensure<T>(value: unknown): T {
  if (isCancel(value)) {
    throw new SkillMakerError("cancelled");
  }
  return value as T;
}

/**
 * Interactive setup, run on first use or via `skillmaker config`.
 *
 * Values already in the config are offered as defaults, so re-running the
 * wizard is an edit rather than a reset.
 */
export async function runConfigWizard(
  overrides: FlagOverrides = {},
  options: { force?: boolean } = {},
): Promise<StoredConfig> {
  const existing = loadConfig();

  // Pick up anything supplied by flags or the environment as a starting point.
  let seed: { baseURL?: string; model?: string; apiKey?: string };
  try {
    const resolved = resolveSettings(overrides, existing);
    seed = {
      baseURL: resolved.baseURL.value,
      model: resolved.model.value,
      apiKey: resolved.apiKey.value,
    };
  } catch {
    // No key configured anywhere - that is precisely why we are here.
    seed = {
      baseURL: overrides.baseURL ?? existing.baseURL,
      model: overrides.model ?? existing.model,
    };
  }

  const baseURL = ensure<string>(
    await text({
      message: "API base URL",
      placeholder: "https://api.anthropic.com",
      initialValue: seed.baseURL ?? existing.baseURL ?? "",
      validate: (value) => {
        const v = (value ?? "").trim();
        if (v === "") return undefined;
        try {
          new URL(v);
          return undefined;
        } catch {
          return "Enter a valid URL, or leave empty for the default";
        }
      },
    }),
  ).trim();

  const apiKey = ensure<string>(
    await password({
      message: "API key",
      validate: (value) => ((value ?? "").trim() === "" ? "An API key is required" : undefined),
    }),
  ).trim();

  const effectiveBase = baseURL || seed.baseURL || "https://api.anthropic.com";

  let models: ModelOption[] = [];
  const discovered = await fetchModels(effectiveBase, apiKey);
  if (discovered.length > 0) {
    models = discovered.map((id) => ({ value: id, label: id }));
    if (!models.some((m) => m.value === DEFAULT_MODEL)) {
      models.unshift({ value: DEFAULT_MODEL, label: `${DEFAULT_MODEL} (default)` });
    }
  }

  let model: string;
  if (models.length > 0) {
    const preset = seed.model ?? existing.model ?? DEFAULT_MODEL;
    model = ensure<string>(
      await select({
        message: "Model",
        options: models,
        initialValue: models.some((m) => m.value === preset) ? preset : models[0]!.value,
      }),
    );
  } else {
    model = ensure<string>(
      await text({
        message: "Model name",
        placeholder: DEFAULT_MODEL,
        initialValue: seed.model ?? existing.model ?? DEFAULT_MODEL,
      }),
    ).trim() || DEFAULT_MODEL;
  }

  const storeKey = ensure<boolean>(
    await confirm({
      message: "Store the API key in the config file? (No = read it from an environment variable instead)",
      initialValue: true,
    }),
  );

  let apiKeyEnv: string | undefined;
  if (!storeKey) {
    apiKeyEnv = ensure<string>(
      await text({
        message: "Environment variable holding the key",
        placeholder: "ANTHROPIC_API_KEY",
        initialValue: existing.apiKeyEnv ?? "ANTHROPIC_API_KEY",
      }),
    ).trim();
  }

  const stored: StoredConfig = {
    baseURL: effectiveBase,
    model,
    ...(storeKey ? { apiKey } : { apiKeyEnv }),
  };

  const written = saveConfig(stored);
  process.stdout.write(
    [
      "",
      `wrote ${written}`,
      `  base url: ${effectiveBase}`,
      `  model:    ${model}`,
      storeKey
        ? `  api key:  ${maskSecret(apiKey)} (stored in the clear - protect this file)`
        : `  api key:  read from $${apiKeyEnv}`,
      "",
    ].join("\n"),
  );

  return stored;
}

/**
 * Run the wizard only when there is nothing usable to run with.
 *
 * A first `skillmaker create` with no configuration prompts for setup; once the
 * config exists this returns immediately.
 */
export async function ensureConfigured(overrides: FlagOverrides = {}): Promise<void> {
  try {
    resolveSettings(overrides);
  } catch (error) {
    if (!(error instanceof SkillMakerError)) throw error;
    if (!optionsInteractive()) {
      throw new SkillMakerError(
        "no API key configured and stdin is not a terminal. " +
          "Run `skillmaker config` first, or set ANTHROPIC_API_KEY.",
      );
    }
    process.stdout.write("No configuration found - let's set one up.\n");
    await runConfigWizard(overrides);
  }
}

function optionsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
