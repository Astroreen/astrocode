// Fallback configuration (locked decision #3, docs/porting-plan.md): flat, no
// categories. Parsed from the plugin's own options object in
// .opencode/opencode.jsonc:
//
//   "plugin": [["astrocode", { "fallback": { ... } }]]
//
// Shape:
//   { fallback: {
//       enabled, retry_on_errors: number[], cooldown_seconds,
//       cooldown_seconds_by_model: {"provider/model": number},
//       same_model_max_retries, same_model_max_wait_seconds,
//       models: string[] (global chain) } }
//
// `cooldown_seconds_by_model` (plan T14): per-model cooldown overrides keyed by
// the full "provider/model" id (case-insensitive). A model absent from the map
// uses the global `cooldown_seconds`. Applied when the fallback chain selects
// its next link: a model whose cooldown window is still active is skipped.
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
  cooldown_seconds: number;
  /**
   * Per-model cooldown overrides (plan T14), keyed by "provider/model"
   * (keys lowercased at parse time). A model absent here uses the global
   * `cooldown_seconds`; an explicit 0 disables the cooldown for that model.
   */
  cooldown_seconds_by_model: Record<string, number>;
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
  cooldown_seconds: 60,
  cooldown_seconds_by_model: {},
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

// Per-model cooldown map (plan T14). Keys must be "provider/model" strings
// (lowercased so lookups are case-insensitive, matching how provider ids are
// compared elsewhere in the fallback engine); values go through the same
// asNonNegativeInt discipline as the scalar fields. Invalid entries are
// dropped, never fatal — same defensive style as asStringArray above.
function asCooldownSecondsByModel(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const seconds = asNonNegativeInt(raw);
    const name = key.trim().toLowerCase();
    if (seconds === undefined || !name || !name.includes("/")) continue;
    out[name] = seconds;
  }
  return out;
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
    cooldown_seconds:
      asNonNegativeInt(input.cooldown_seconds) ??
      DEFAULT_FALLBACK_CONFIG.cooldown_seconds,
    cooldown_seconds_by_model: asCooldownSecondsByModel(
      input.cooldown_seconds_by_model ?? input.cooldownSecondsByModel,
    ),
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

// Effective cooldown for one model (plan T14): the per-model override wins;
// everything else — including an unknown/unparseable model string — uses the
// global `cooldown_seconds`.
export function cooldownSecondsFor(
  config: FallbackConfig,
  model: string | undefined,
): number {
  if (!model) return config.cooldown_seconds;
  const override = config.cooldown_seconds_by_model[model.trim().toLowerCase()];
  return override ?? config.cooldown_seconds;
}