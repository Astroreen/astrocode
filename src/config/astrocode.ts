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
//     "cooldown_seconds": 60,
//     "models": ["openrouter/~deepseek/deepseek-flash-latest"]  // global chain
//   },
//   "telemetry": {
//     "enabled": true,
//     "dir": "/tmp/telemetry"  // optional dir root override
//   },
//   "budget": {
//     "enabled": false,        // opt-in enforcement (plan T2)
//     "session_usd": 0.50,     // undefined = unlimited, 0 = block everything
//     "agent_usd": 0.20
//   },
//   "aliases": {
//     "enabled": true          // deprecated tool-alias shims (plan T5)
//   },
//   "compaction": {
//     "enabled": false,                        // opt-in (plan T9) — see below
//     "summarizer_model": "openrouter/xiaomi/mimo-v2.6-pro",
//     "trigger_ratio": 0.75,   // valid 0.7–0.8; out-of-range/garbage -> 0.8
//     "context_window": 200000,                // default window for the ratio
//     "context_windows": {},   // {"provider/model": 128000} overrides
//     "prune_stub_chars": 200, // valid 50–2000; out-of-range/garbage -> 200
//     "cooldown_seconds": 300  // 0 = no cooldown
//   },
//   "reasoning_overrides": {
//     // Per-model reasoning overrides (plan T13), keyed by the full
//     // "providerID/modelID". A `:level` suffix in the model id beats an
//     // override; an override beats the family default. claude entries MUST
//     // carry an explicit boolean clear_thinking. Invalid entries are dropped
//     // with a warning, never fatal.
//     "anthropic/claude-sonnet-5-5": { "level": "medium", "clear_thinking": true },
//     "openrouter/xiaomi/mimo-v2.6-pro": { "level": "minimal", "clear_thinking": false }
//   },
//   "schema_validator": {
//     // Tool-schema hygiene validator (plan T15). enabled: validate every
//     // outgoing tool schema; log_only: never mutate the schema (pure
//     // observability). log_only: false opts into the single safe repair
//     // (adding root "type": "object" when properties exist).
//     "enabled": true,
//     "log_only": true
//   }
// }
//
// Inline plugin options (the second tuple element in opencode.jsonc) are still
// honored and override the file.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseFallbackConfig, type FallbackConfig } from "../fallback/config";
import { isReasoningLevel, type ReasoningLevel, type SamplingSettings } from "../models/tuning";
import { resolveFamily } from "../models/resolveFamily";
import { log } from "../log";

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
  /** Subagent model inheritance; opt-in escape hatch (default: no inheritance). */
  subagents: { inherit_parent_model: boolean };
  /** Per-family sampling overrides; unknown families fall back to defaults. */
  sampling: Record<string, SamplingSettings>;
  /** Extra directories scanned for `<name>/SKILL.md` and symlinked in. */
  skills: { extraDirs: string[] };
  /** Opt-in idle continuation when a session stops with unfinished todos. */
  idleContinuation: { enabled: boolean; max?: number };
  /** Inject family reasoning/thinking options (claude thinking, gpt effort). */
  reasoning: { enabled: boolean };
  /** JSONL telemetry sink (plan T1); enabled by default, dir overrides path. */
  telemetry: TelemetryConfig;
  /** Opt-in spend-cap enforcement (plan T2); disabled by default. */
  budget: BudgetConfig;
  /** Deprecated tool-alias shims (plan T5); enabled by default. */
  aliases: AliasesConfig;
  /** Rule-triggered context compaction engine (plan T9); disabled by default. */
  compaction: CompactionConfig;
  /**
   * Per-model reasoning overrides (plan T13), keyed by the full
   * "providerID/modelID" id (same format as fallback chains). Applied in the
   * chat.params hook; a `:level` suffix in the model id beats an override.
   */
  reasoning_overrides: Record<string, ReasoningOverrideConfig>;
  /** Tool-schema hygiene validator (plan T15); enabled + log-only by default. */
  schema_validator: SchemaValidatorConfig;
}

/**
 * Tool-schema hygiene validator (plan T15). Runs on every outgoing tool
 * definition via the tool.definition hook.
 */
export interface SchemaValidatorConfig {
  /** true (default) -> outgoing tool schemas are validated. */
  enabled: boolean;
  /**
   * true (default) -> pure observability: violations are logged + recorded,
   * the schema is NEVER mutated. false -> the single safe repair applies
   * (root "type": "object" added when properties exist); anyOf/oneOf/allOf
   * semantics are still never rewritten.
   */
  log_only: boolean;
}

// Schema-validator config (plan T15). Same defensive discipline as
// parseTelemetryConfig: never throws, garbage fields fall back to defaults.
// Enabled + log-only by default: measuring first, mutating never (the repair
// is opt-in because rewriting a schema changes what the model may send).
function parseSchemaValidatorConfig(raw: unknown): SchemaValidatorConfig {
  const out: SchemaValidatorConfig = { enabled: true, log_only: true };
  if (!isPlainObject(raw)) return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.log_only === "boolean") out.log_only = raw.log_only;
  if (typeof raw.logOnly === "boolean") out.log_only = raw.logOnly;
  return out;
}

export interface ReasoningOverrideConfig {
  /** Requested reasoning level; a REASONING_LEVELS member (validated). */
  level: ReasoningLevel;
  /**
   * Provider passthrough attached to options ONLY for claude-family models.
   * REQUIRED (explicit boolean) for claude entries — the underlying default
   * is generation-dependent, so a claude entry without it is dropped with a
   * warning at parse time.
   */
  clear_thinking: boolean;
  /** Explicit claude thinking budget; beats the level-derived budget. */
  budget_tokens?: number;
}

export interface TelemetryConfig {
  /** false -> the sink is a complete no-op (zero I/O, no dirs created). */
  enabled: boolean;
  /** Telemetry dir root override; files land as <dir>/telemetry-YYYY-MM-DD.jsonl. */
  dir?: string;
}

export interface BudgetConfig {
  /**
   * false (default) -> enforcement off. Opt-in because blocking tool calls on
   * spend is destructive; the in-memory aggregates are fed regardless.
   */
  enabled: boolean;
  /** Session spend cap in USD; undefined = unlimited, 0 = block everything. */
  session_usd?: number;
  /** Per-agent spend cap in USD; undefined = unlimited, 0 = block everything. */
  agent_usd?: number;
}

export interface AliasesConfig {
  /**
   * true (default) -> the deprecated tool-alias shims (plan T5) are registered.
   * false -> no alias tools are registered at all.
   */
  enabled: boolean;
}

// Compaction engine constants (plan T9). Exported so the trigger/summarizer
// modules and tests share one source of truth.
export const COMPACTION_TRIGGER_RATIO_MIN = 0.7;
export const COMPACTION_TRIGGER_RATIO_MAX = 0.8;
export const COMPACTION_TRIGGER_RATIO_DEFAULT = 0.8;
export const COMPACTION_CONTEXT_WINDOW_DEFAULT = 200000;
export const COMPACTION_PRUNE_STUB_CHARS_MIN = 50;
export const COMPACTION_PRUNE_STUB_CHARS_MAX = 2000;
export const COMPACTION_PRUNE_STUB_CHARS_DEFAULT = 200;
export const COMPACTION_COOLDOWN_SECONDS_DEFAULT = 300;

export interface CompactionConfig {
  /**
   * false (default) -> the engine never runs. Opt-in UNLIKE telemetry:
   * telemetry only measures, while compaction mutates session history (the
   * intentional cache-epoch break — old bytes are pruned/summarized), so the
   * user must choose it explicitly.
   */
  enabled: boolean;
  /**
   * "provider/model" of the dedicated cheap summarizer used by the native
   * summarize route. undefined -> no native attempt; the scratch fallback
   * runs on its own constant cheap model (src/compaction/summarize.ts).
   */
  summarizer_model?: string;
  /** Context fill ratio that trips compaction. Valid 0.7–0.8; default 0.8. */
  trigger_ratio: number;
  /** Default context window (tokens) for the ratio; positive int; default 200000. */
  context_window: number;
  /**
   * Per-model window overrides keyed by "provider/model" (or a bare model id,
   * matched as the suffix of a full id). Beats `context_window`.
   */
  context_windows: Record<string, number>;
  /** Tool-output stub length for the T10 prune. Valid 50–2000; default 200. */
  prune_stub_chars: number;
  /** Minimum seconds between compactions; 0 = no cooldown; default 300. */
  cooldown_seconds: number;
}

export const EMPTY_ASTROCODE_CONFIG: AstrocodeConfig = {
  fallback: parseFallbackConfig(undefined),
  agents: {},
  subagents: { inherit_parent_model: false },
  sampling: {},
  skills: { extraDirs: [] },
  idleContinuation: { enabled: false },
  reasoning: { enabled: true },
  telemetry: { enabled: true },
  budget: { enabled: false },
  aliases: { enabled: true },
  compaction: parseCompactionConfig(undefined),
  reasoning_overrides: {},
  schema_validator: parseSchemaValidatorConfig(undefined),
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

// Telemetry sink config (plan T1). Same defensive discipline as
// parseFallbackConfig: never throws, garbage fields fall back to defaults.
// Enabled by default — telemetry is the mission-critical measurement layer;
// users opt out with `telemetry: { enabled: false }`.
function parseTelemetryConfig(raw: unknown): TelemetryConfig {
  const out: TelemetryConfig = { enabled: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled === "boolean") out.enabled = input.enabled;
  const dir = asString(input.dir);
  if (dir) out.dir = dir;
  return out;
}

// Budget enforcement config (plan T2). Same defensive discipline as
// parseTelemetryConfig: never throws, garbage fields fall back to defaults.
// Disabled by default (opt-in enforcement — see BudgetConfig docstring).
// Limits are non-negative finite numbers: undefined = unlimited, 0 = block
// everything. Zero is a VALID limit and must survive parsing (no truthiness).
function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseBudgetConfig(raw: unknown): BudgetConfig {
  const out: BudgetConfig = { enabled: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled === "boolean") out.enabled = input.enabled;
  const session = asNonNegativeNumber(input.session_usd ?? input.sessionUsd);
  if (session !== undefined) out.session_usd = session;
  const agent = asNonNegativeNumber(input.agent_usd ?? input.agentUsd);
  if (agent !== undefined) out.agent_usd = agent;
  return out;
}

// Alias-shim config (plan T5). Same defensive discipline as
// parseTelemetryConfig: never throws, garbage fields fall back to defaults.
// Enabled by default — the aliases are the tool-reliability safety net;
// users opt out with `aliases: { enabled: false }`.
function parseAliasesConfig(raw: unknown): AliasesConfig {
  const out: AliasesConfig = { enabled: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled === "boolean") out.enabled = input.enabled;
  return out;
}

// Positive non-zero integer (context windows are token counts).
function asPositiveInt(value: unknown): number | undefined {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
      ? value
      : undefined
  );
}

// Compaction engine config (plan T9). Same defensive discipline as
// parseTelemetryConfig: never throws, garbage fields fall back to defaults.
// Disabled by default (opt-in — see CompactionConfig docstring: compaction
// mutates history, telemetry does not).
//
// Range validation (not clamping): an out-of-range value is a config mistake,
// so it falls back to the documented default instead of being silently bent
// into range. Boundary values (0.7/0.8, 50/2000) are valid.
function parseCompactionConfig(raw: unknown): CompactionConfig {
  const out: CompactionConfig = {
    enabled: false,
    trigger_ratio: COMPACTION_TRIGGER_RATIO_DEFAULT,
    context_window: COMPACTION_CONTEXT_WINDOW_DEFAULT,
    context_windows: {},
    prune_stub_chars: COMPACTION_PRUNE_STUB_CHARS_DEFAULT,
    cooldown_seconds: COMPACTION_COOLDOWN_SECONDS_DEFAULT,
  };
  if (!isPlainObject(raw)) return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  const summarizer = asString(raw.summarizer_model ?? raw.summarizerModel);
  if (summarizer) out.summarizer_model = summarizer;
  const ratio = asNumber(raw.trigger_ratio ?? raw.triggerRatio);
  if (
    ratio !== undefined &&
    ratio >= COMPACTION_TRIGGER_RATIO_MIN &&
    ratio <= COMPACTION_TRIGGER_RATIO_MAX
  ) {
    out.trigger_ratio = ratio;
  }
  const window = asPositiveInt(raw.context_window ?? raw.contextWindow);
  if (window !== undefined) out.context_window = window;
  const windows = isPlainObject(raw.context_windows ?? raw.contextWindows)
    ? (raw.context_windows ?? raw.contextWindows)
    : undefined;
  if (windows) {
    for (const [key, value] of Object.entries(windows)) {
      const parsed = asPositiveInt(value);
      const name = asString(key);
      if (parsed !== undefined && name) out.context_windows[name] = parsed;
    }
  }
  const prune = asNumber(raw.prune_stub_chars ?? raw.pruneStubChars);
  if (
    prune !== undefined &&
    prune >= COMPACTION_PRUNE_STUB_CHARS_MIN &&
    prune <= COMPACTION_PRUNE_STUB_CHARS_MAX
  ) {
    out.prune_stub_chars = prune;
  }
  const cooldown = asNonNegativeNumber(
    raw.cooldown_seconds ?? raw.cooldownSeconds,
  );
  if (cooldown !== undefined) out.cooldown_seconds = cooldown;
  return out;
}

// Per-model reasoning overrides (plan T13). Same defensive discipline as
// parseCompactionConfig: never throws, invalid entries are DROPPED with a
// warning (via the optional `warn` callback — the parse itself stays pure),
// valid entries survive. Keyed by the full "providerID/modelID" id.
//
// Entry validation:
//   - key must contain "/" (provider/model format) or the entry can never
//     match a runtime id -> dropped;
//   - `level` must be a REASONING_LEVELS member -> else dropped;
//   - `clear_thinking` must be a boolean when present -> else dropped;
//   - claude-family entries (resolveFamily on the model id part) MUST carry
//     an explicit boolean clear_thinking -> else dropped (generation-dependent
//     defaults make silence ambiguous);
//   - `budget_tokens`, when present, must be a positive integer -> else dropped.
export function parseReasoningOverrides(
  raw: unknown,
  warn?: (message: string) => void,
): Record<string, ReasoningOverrideConfig> {
  const out: Record<string, ReasoningOverrideConfig> = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const drop = (reason: string): void => {
      warn?.(`reasoning_overrides: dropping entry "${key}": ${reason}`);
    };
    if (!key.includes("/")) {
      drop("key must be a full providerID/modelID id");
      continue;
    }
    if (!isPlainObject(value)) {
      drop("entry must be an object");
      continue;
    }
    const level = value.level;
    if (typeof level !== "string" || !isReasoningLevel(level)) {
      drop(`unknown level ${JSON.stringify(level)}`);
      continue;
    }
    const clearThinking = value.clear_thinking ?? value.clearThinking;
    if (clearThinking !== undefined && typeof clearThinking !== "boolean") {
      drop("clear_thinking must be a boolean");
      continue;
    }
    const modelID = key.slice(key.indexOf("/") + 1);
    const family = resolveFamily({ providerID: key.slice(0, key.indexOf("/")), modelID });
    if (family === "claude" && typeof clearThinking !== "boolean") {
      drop("claude-family entries require an explicit boolean clear_thinking");
      continue;
    }
    const budget = value.budget_tokens ?? value.budgetTokens;
    if (budget !== undefined) {
      const parsed = asPositiveInt(budget);
      if (parsed === undefined) {
        drop("budget_tokens must be a positive integer");
        continue;
      }
      out[key] = {
        level,
        clear_thinking: clearThinking ?? false,
        budget_tokens: parsed,
      };
      continue;
    }
    out[key] = { level, clear_thinking: clearThinking ?? false };
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

// Walk from `projectDir` up to `stopDir` (inclusive) or the filesystem root,
// collecting the first config file found at each level. Returned paths are
// ordered farthest-first (root-most first, project dir last) so that later
// entries are the nearest layers. Never throws.
export function collectConfigLayers(
  projectDir: string,
  stopDir: string = homedir(),
): string[] {
  const dirs: string[] = [];
  try {
    let current = projectDir;
    for (let i = 0; i < 1000; i += 1) {
      dirs.push(current);
      if (current === stopDir) break;
      const parent = dirname(current);
      if (!parent || parent === current) break;
      current = parent;
    }
  } catch {
    // ignore malformed paths
  }

  const layers: string[] = [];
  const seen = new Set<string>();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    let found: string | undefined;
    try {
      found = findConfigFile([dirs[i]]);
    } catch {
      found = undefined;
    }
    if (found && !seen.has(found)) {
      seen.add(found);
      layers.push(found);
    }
  }
  return layers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Shallow-merge per-agent maps: later (nearer) layers win per field, arrays
// (e.g. fallback_models) are replaced wholesale, never concatenated.
function mergeAgentMaps(
  far: unknown,
  near: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(far) ? { ...far } : {};
  if (!isPlainObject(near)) return out;
  for (const [name, settings] of Object.entries(near)) {
    if (!isPlainObject(settings)) continue;
    const prev = isPlainObject(out[name]) ? out[name] : {};
    out[name] = { ...prev, ...settings };
  }
  return out;
}

// Merge config layers ordered farthest-first; later (nearer) layers win.
function mergeConfigLayers(
  layers: Record<string, unknown>[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (key === "agents") {
        out.agents = mergeAgentMaps(out.agents, value);
      } else if (key === "fallback") {
        const far = isPlainObject(out.fallback) ? out.fallback : {};
        out.fallback = isPlainObject(value) ? { ...far, ...value } : far;
      } else if (key === "sampling") {
        const far = isPlainObject(out.sampling) ? out.sampling : {};
        out.sampling = isPlainObject(value) ? { ...far, ...value } : far;
      } else if (key === "subagents") {
        const far = isPlainObject(out.subagents) ? out.subagents : {};
        out.subagents = isPlainObject(value) ? { ...far, ...value } : far;
      } else if (key === "telemetry") {
        const far = isPlainObject(out.telemetry) ? out.telemetry : {};
        out.telemetry = isPlainObject(value) ? { ...far, ...value } : far;
      } else if (key === "budget") {
        const far = isPlainObject(out.budget) ? out.budget : {};
        out.budget = isPlainObject(value) ? { ...far, ...value } : far;
      } else if (key === "aliases") {
        const far = isPlainObject(out.aliases) ? out.aliases : {};
        out.aliases = isPlainObject(value) ? { ...far, ...value } : far;
      } else if (key === "compaction") {
        const far = isPlainObject(out.compaction) ? out.compaction : {};
        out.compaction = isPlainObject(value) ? { ...far, ...value } : far;
      } else if (key === "reasoning_overrides" || key === "reasoningOverrides") {
        // Per-key merge like agents: nearer layers win per model id.
        out.reasoning_overrides = mergeAgentMaps(out.reasoning_overrides, value);
      } else if (key === "schema_validator") {
        const far = isPlainObject(out.schema_validator) ? out.schema_validator : {};
        out.schema_validator = isPlainObject(value) ? { ...far, ...value } : far;
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

export function loadAstrocodeConfig(
  searchDirs: string[],
  inlineOptions?: unknown,
): AstrocodeConfig {
  let fileRaw: Record<string, unknown> = {};
  const layerPaths: string[] = [];
  const seenLayers = new Set<string>();
  for (const dir of searchDirs) {
    if (!dir) continue;
    for (const layerPath of collectConfigLayers(dir)) {
      if (seenLayers.has(layerPath)) continue;
      seenLayers.add(layerPath);
      layerPaths.push(layerPath);
    }
  }

  const parsedLayers: Record<string, unknown>[] = [];
  for (const layerPath of layerPaths) {
    try {
      const parsed = JSON.parse(sanitizeJsonc(readFileSync(layerPath, "utf8")));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedLayers.push(parsed as Record<string, unknown>);
      }
    } catch {
      // malformed layer: skip it, farther layers still apply
    }
  }
  fileRaw = mergeConfigLayers(parsedLayers);

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

  // `subagents` shallow-merge like fallback/sampling: nearest wins per field.
  // Parsed strictly: only a literal `true` enables inheritance.
  const fileSubagents = isPlainObject(fileRaw.subagents) ? fileRaw.subagents : {};
  const inlineSubagents = isPlainObject(inline.subagents) ? inline.subagents : {};
  const inheritParentModel =
    { ...fileSubagents, ...inlineSubagents }.inherit_parent_model === true;

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

  // `telemetry` shallow-merges like fallback/sampling: nearest layer wins per
  // field, so a project-level `enabled` flip keeps the home-level `dir`.
  const fileTelemetry = isPlainObject(fileRaw.telemetry) ? fileRaw.telemetry : {};
  const inlineTelemetry = isPlainObject(inline.telemetry) ? inline.telemetry : {};
  const telemetry = parseTelemetryConfig({ ...fileTelemetry, ...inlineTelemetry });

  // `budget` shallow-merges like telemetry: nearest layer wins per field.
  const fileBudget = isPlainObject(fileRaw.budget) ? fileRaw.budget : {};
  const inlineBudget = isPlainObject(inline.budget) ? inline.budget : {};
  const budget = parseBudgetConfig({ ...fileBudget, ...inlineBudget });

  // `aliases` shallow-merges like budget: nearest layer wins per field.
  const fileAliases = isPlainObject(fileRaw.aliases) ? fileRaw.aliases : {};
  const inlineAliases = isPlainObject(inline.aliases) ? inline.aliases : {};
  const aliases = parseAliasesConfig({ ...fileAliases, ...inlineAliases });

  // `compaction` shallow-merges like budget: nearest layer wins per field.
  const fileCompaction = isPlainObject(fileRaw.compaction) ? fileRaw.compaction : {};
  const inlineCompaction = isPlainObject(inline.compaction) ? inline.compaction : {};
  const compaction = parseCompactionConfig({ ...fileCompaction, ...inlineCompaction });

  // `reasoning_overrides` per-key merge (like agents): a nearer layer replaces
  // a model's entry wholesale. Parsed once over the merged raw map; invalid
  // entries are dropped with a warning (plan T13).
  const reasoning_overrides = parseReasoningOverrides(
    mergeAgentMaps(
      fileRaw.reasoning_overrides ?? fileRaw.reasoningOverrides,
      inline.reasoning_overrides ?? inline.reasoningOverrides,
    ),
    (message) => log.warn(message),
  );

  // `schema_validator` shallow-merges like aliases: nearest layer wins per field.
  const fileSchemaValidator =
    isPlainObject(fileRaw.schema_validator) ? fileRaw.schema_validator : {};
  const inlineSchemaValidator =
    isPlainObject(inline.schema_validator) ? inline.schema_validator : {};
  const schema_validator = parseSchemaValidatorConfig({
    ...fileSchemaValidator,
    ...inlineSchemaValidator,
  });

  const fallback = parseFallbackConfig(mergedFallback);
  // Bridge top-level `agents.<name>.fallback_models` into the fallback engine.
  // This is the SINGLE source of truth for per-agent chains; a raw
  // `fallback.agents` input is ignored by parseFallbackConfig.
  for (const [name, settings] of Object.entries(agents)) {
    if (settings.fallbackModels) {
      fallback.agents[name] = { models: settings.fallbackModels };
    }
  }

  return {
    fallback,
    agents,
    model: asString(inline.model) ?? asString(fileRaw.model),
    subagents: { inherit_parent_model: inheritParentModel },
    sampling,
    skills: { extraDirs },
    idleContinuation:
      idleMax !== undefined
        ? { enabled: idleEnabled, max: idleMax }
        : { enabled: idleEnabled },
    reasoning: { enabled: reasoningEnabled },
    telemetry,
    budget,
    aliases,
    compaction,
    reasoning_overrides,
    schema_validator,
  };
}