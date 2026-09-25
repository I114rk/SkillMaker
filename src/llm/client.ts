import Anthropic from "@anthropic-ai/sdk";

import { DEFAULT_BASE_URL, type ResolvedSettings } from "../config/resolve.js";

/**
 * Build an SDK client from resolved settings.
 *
 * `baseURL` is omitted rather than defaulted when unset, so the SDK's own
 * resolution (including `ANTHROPIC_BASE_URL`) keeps working.
 */
export function createClient(settings: ResolvedSettings): Anthropic {
  const baseURL = settings.baseURL.value ?? DEFAULT_BASE_URL;
  return new Anthropic({
    apiKey: settings.apiKey.value,
    baseURL,
    maxRetries: 3,
  });
}

export type { Anthropic };
