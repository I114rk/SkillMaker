import fs from "node:fs";
import path from "node:path";

import { configDir, configFile } from "../util/paths.js";
import { SkillMakerError } from "../util/errors.js";

/** Everything the config file can hold. All fields are optional on disk. */
export interface StoredConfig {
  baseURL?: string;
  model?: string;
  /** The key itself. Stored in the clear - see the warning printed on save. */
  apiKey?: string;
  /** Alternative to `apiKey`: the name of an env var to read the key from. */
  apiKeyEnv?: string;
  version?: number;
}

export const CONFIG_VERSION = 1;

/** Read the config file. Returns `{}` when it does not exist yet. */
export function loadConfig(): StoredConfig {
  const file = configFile();
  if (!fs.existsSync(file)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (cause) {
    throw new SkillMakerError(`cannot read ${file}`, { cause });
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SkillMakerError(`${file} must contain a JSON object`);
    }
    return parsed as StoredConfig;
  } catch (cause) {
    if (cause instanceof SkillMakerError) throw cause;
    throw new SkillMakerError(`${file} is not valid JSON`, { cause });
  }
}

/**
 * Write the config file, creating `~/.config/SkillMaker` if needed.
 *
 * The file is written with `0600` because it may hold an API key, and it is
 * written via a temp file + rename so an interrupted save cannot truncate a
 * working config.
 */
export function saveConfig(config: StoredConfig): string {
  const dir = configDir();
  const file = configFile();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const payload: StoredConfig = { version: CONFIG_VERSION, ...config };
  // Drop undefined so the file stays readable and diffable.
  for (const key of Object.keys(payload) as (keyof StoredConfig)[]) {
    if (payload[key] === undefined || payload[key] === "") delete payload[key];
  }

  const tmp = path.join(dir, `config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

export function configExists(): boolean {
  return fs.existsSync(configFile());
}
