// astrocode's own config file loader.
//
// Goal (user requirement): astrocode must NOT require stuffing its settings into
// `.opencode/opencode.jsonc`. The plugin loads a dedicated file itself, searched
// relative to the project/worktree:
//
//   astrocode.jsonc / astrocode.json
//   .opencode/astrocode.jsonc / .opencode/astrocode.json
//
// File shape:
// {
//   "agents": {
//     "sisyphus": {
//       "model": "anthropic/claude-sonnet-4-6",
//       "fallback_models": ["openrouter/~deepseek/deepseek-flash-latest"],
//       "color": "#00CED1"
//     }
//   },
//   "fallback": {
//     "enabled": true,
//     "retry_on_errors": [429, 500, 502, 503, 504],
//     "max_attempts": 3,
//     "cooldown_seconds": 60,
//     "models": ["openrouter/~deepseek/deepseek-flash-latest"]  // global chain
//   }
// }
//
// Inline plugin options (the second tuple element in opencode.jsonc) are still
// honored and override the file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFallbackConfig, type FallbackConfig } from "../fallback/config";
import type { SamplingSettings } from "../models/tuning";

export type { SamplingSettings };

export interface AgentSettings {
  model?: string;
  fallbackModels?: string[];
  color?: string;
}

export interface AstrocodeConfig {
  fallback: FallbackConfig;
  agents: Record<string, AgentSettings>;
  /** Global default model applied to agents with no per-agent `model`. */
  model?: string;
  /** Per-family sampling overrides; unknown families fall back to defaults. */
  sampling: Record<string, SamplingSettings>;
  /** Extra directories scanned for `<name>/SKILL.md` and symlinked in. */
  skills: { extraDirs: string[] };
  /** Opt-in idle continuation when a session stops with unfinished todos. */
  idleContinuation: { enabled: boolean; max?: number };
  /** Inject family reasoning/thinking options (claude thinking, gpt effort). */
  reasoning: { enabled: boolean };
}

export const EMPTY_ASTROCODE_CONFIG: AstrocodeConfig = {
  fallback: parseFallbackConfig(undefined),
  agents: {},
  sampling: {},
  skills: { extraDirs: [] },
  idleContinuation: { enabled: false },
  reasoning: { enabled: true },
};

const CONFIG_FILE_NAMES = [
  "astrocode.jsonc",
  "astrocode.json",
  join(".opencode", "astrocode.jsonc"),
  join(".opencode", "astrocode.json"),
];

// Minimal JSONC -> JSON sanitizer: strips // and /* */ comments (string-aware)
// and trailing commas. Good enough for hand-written config files.
export function sanitizeJsonc(input: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return out.length > 0 ? out.map((entry) => entry.trim()) : undefined;
}

function parseAgentSettings(raw: unknown): Record<string, AgentSettings> {
  const out: Record<string, AgentSettings> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const settings: AgentSettings = {};
    const model = asString(entry.model);
    if (model) settings.model = model;
    const fallback = asStringList(entry.fallback_models ?? entry.fallbackModels);
    if (fallback) settings.fallbackModels = fallback;
    const color = asString(entry.color);
    if (color) settings.color = color;
    out[name] = settings;
  }
  return out;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSampling(raw: unknown): Record<string, SamplingSettings> {
  const out: Record<string, SamplingSettings> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [family, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const settings: SamplingSettings = {};
    const temperature = asNumber(entry.temperature);
    if (temperature !== undefined) settings.temperature = temperature;
    const topP = asNumber(entry.topP ?? entry.top_p);
    if (topP !== undefined) settings.topP = topP;
    if (Object.keys(settings).length > 0) out[family] = settings;
  }
  return out;
}

function findConfigFile(searchDirs: string[]): string | undefined {
  for (const dir of searchDirs) {
    if (!dir) continue;
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function loadAstrocodeConfig(
  searchDirs: string[],
  inlineOptions?: unknown,
): AstrocodeConfig {
  let fileRaw: Record<string, unknown> = {};
  const path = findConfigFile(searchDirs);
  if (path) {
    try {
      const parsed = JSON.parse(sanitizeJsonc(readFileSync(path, "utf8")));
      if (parsed && typeof parsed === "object") {
        fileRaw = parsed as Record<string, unknown>;
      }
    } catch {
      // malformed config file: fall back to defaults + inline options
    }
  }

  const inline =
    inlineOptions && typeof inlineOptions === "object"
      ? (inlineOptions as Record<string, unknown>)
      : {};

  const mergedFallback = {
    ...((fileRaw.fallback as Record<string, unknown>) ?? {}),
    ...((inline.fallback as Record<string, unknown>) ?? {}),
  };

  const fileAgents = parseAgentSettings(fileRaw.agents);
  const inlineAgents = parseAgentSettings(inline.agents);
  const agents: Record<string, AgentSettings> = { ...fileAgents };
  // Per-agent merge: an inline override of `model` keeps the file's
  // `fallback_models`/`color` unless the inline entry sets them too.
  for (const [name, settings] of Object.entries(inlineAgents)) {
    agents[name] = { ...(fileAgents[name] ?? {}), ...settings };
  }

  const sampling = {
    ...parseSampling(fileRaw.sampling),
    ...parseSampling(inline.sampling),
  };

  const fileSkills = (fileRaw.skills as Record<string, unknown>) ?? {};
  const inlineSkills = (inline.skills as Record<string, unknown>) ?? {};
  const extraDirs =
    asStringList(inlineSkills.extraDirs ?? inlineSkills.extra_dirs) ??
    asStringList(fileSkills.extraDirs ?? fileSkills.extra_dirs) ??
    [];

  const fileIdle = (fileRaw.idleContinuation as Record<string, unknown>) ?? {};
  const inlineIdle = (inline.idleContinuation as Record<string, unknown>) ?? {};
  const idleEnabled =
    typeof inlineIdle.enabled === "boolean"
      ? inlineIdle.enabled
      : typeof fileIdle.enabled === "boolean"
        ? fileIdle.enabled
        : false;
  const idleMax = asNumber(inlineIdle.max ?? fileIdle.max);

  const fileReasoning = (fileRaw.reasoning as Record<string, unknown>) ?? {};
  const inlineReasoning = (inline.reasoning as Record<string, unknown>) ?? {};
  const reasoningEnabled =
    typeof inlineReasoning.enabled === "boolean"
      ? inlineReasoning.enabled
      : typeof fileReasoning.enabled === "boolean"
        ? fileReasoning.enabled
        : true;

  return {
    fallback: parseFallbackConfig(mergedFallback),
    agents,
    model: asString(inline.model) ?? asString(fileRaw.model),
    sampling,
    skills: { extraDirs },
    idleContinuation:
      idleMax !== undefined
        ? { enabled: idleEnabled, max: idleMax }
        : { enabled: idleEnabled },
    reasoning: { enabled: reasoningEnabled },
  };
}