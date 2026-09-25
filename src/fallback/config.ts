// Fallback configuration (locked decision #3, docs/porting-plan.md): flat, no
// categories. Parsed from the plugin's own options object in
// .opencode/opencode.jsonc:
//
//   "plugin": [["astrocode", { "fallback": { ... } }]]
//
// Shape:
//   { fallback: {
//       enabled, retry_on_errors: number[], max_attempts, cooldown_seconds,
//       same_model_max_retries, same_model_max_wait_seconds,
//       models: string[] (global chain) } }
//
// Per-agent chains are NOT configured here: the ONLY source is top-level
// `agents.<name>.fallback_models` in astrocode.jsonc. `loadAstrocodeConfig`
// bridges those into `FallbackConfig.agents` (a runtime carrier). A raw
// `fallback.agents` input is ignored.

export interface FallbackAgentOverride {
  models: string[];
}

export interface FallbackConfig {
  enabled: boolean;
  retry_on_errors: number[];
  max_attempts: number;
  cooldown_seconds: number;
  /** Transient errors: same-model retry budget before rotating. */
  same_model_max_retries: number;
  /** Waits longer than this skip same-model retry and rotate immediately. */
  same_model_max_wait_seconds: number;
  models: string[];
  /** Runtime carrier — populated by loadAstrocodeConfig from top-level
   * `agents[].fallback_models`; never parsed from `fallback.agents`. */
  agents: Record<string, FallbackAgentOverride>;
}

export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  enabled: false,
  retry_on_errors: [429, 500, 502, 503, 504],
  max_attempts: 3,
  cooldown_seconds: 60,
  same_model_max_retries: 2,
  same_model_max_wait_seconds: 300,
  models: [],
  agents: {},
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry.trim());
    }
  }
  return out;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      out.push(Math.floor(entry));
    }
  }
  return out.length > 0 ? out : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function parseFallbackConfig(raw: unknown): FallbackConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_FALLBACK_CONFIG, agents: {} };
  }
  const input = raw as Record<string, unknown>;

  return {
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : DEFAULT_FALLBACK_CONFIG.enabled,
    retry_on_errors:
      asNumberArray(input.retry_on_errors) ?? DEFAULT_FALLBACK_CONFIG.retry_on_errors,
    max_attempts:
      asNonNegativeInt(input.max_attempts) ?? DEFAULT_FALLBACK_CONFIG.max_attempts,
    cooldown_seconds:
      asNonNegativeInt(input.cooldown_seconds) ??
      DEFAULT_FALLBACK_CONFIG.cooldown_seconds,
    same_model_max_retries:
      asNonNegativeInt(input.same_model_max_retries) ??
      DEFAULT_FALLBACK_CONFIG.same_model_max_retries,
    same_model_max_wait_seconds:
      asNonNegativeInt(input.same_model_max_wait_seconds) ??
      DEFAULT_FALLBACK_CONFIG.same_model_max_wait_seconds,
    models: asStringArray(input.models),
    // `fallback.agents` input intentionally ignored — single source of truth
    // is top-level `agents[].fallback_models` (bridged by loadAstrocodeConfig).
    agents: {},
  };
}