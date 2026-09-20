// Fallback configuration (locked decision #3, docs/porting-plan.md): flat, no
// categories. Parsed from the plugin's own options object in
// .opencode/opencode.jsonc:
//
//   "plugin": [["astrocode", { "fallback": { ... } }]]
//
// Shape:
//   { fallback: {
//       enabled, retry_on_errors: number[], max_attempts, cooldown_seconds,
//       models: string[] (global chain),
//       agents: { <name>: { models: string[] } } (full replace, no merge) } }

export interface FallbackAgentOverride {
  models: string[];
}

export interface FallbackConfig {
  enabled: boolean;
  retry_on_errors: number[];
  max_attempts: number;
  cooldown_seconds: number;
  models: string[];
  agents: Record<string, FallbackAgentOverride>;
}

export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  enabled: false,
  retry_on_errors: [429, 500, 502, 503, 504],
  max_attempts: 3,
  cooldown_seconds: 60,
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

function parseAgents(raw: unknown): Record<string, FallbackAgentOverride> {
  const agents: Record<string, FallbackAgentOverride> = {};
  if (!raw || typeof raw !== "object") return agents;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    agents[name] = {
      models: asStringArray(entry.fallback_models ?? entry.models),
    };
  }
  return agents;
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
    models: asStringArray(input.models),
    agents: parseAgents(input.agents),
  };
}