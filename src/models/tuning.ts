// Per-family model tuning: reasoning/thinking options and sampling overrides.
//
// Ported in spirit from oh-my-openagent:
//   - `buildClaudeThinkingConfig(model)` enabled extended thinking with a 32000
//     token budget for pre-Opus-4.7 Claude models.
//   - `buildGptSisyphusAgentConfig` set `reasoningEffort: "medium"`.
//   - `chat-params.ts` reconciled temperature/topP per model capabilities; we
//     keep a small configurable per-family map instead of a capability engine.
//
// Everything here is pure and total; callers merge the result into the agent
// config (config hook) or the chat.params output.

import type { ModelFamily } from "./resolveFamily";

export const CLAUDE_THINKING_BUDGET_TOKENS = 32000;

// Ordered reasoning ladder, weakest to strongest. Used to clamp a requested
// level down to the strongest level a given model actually supports.
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

// Clamp a requested level down to the first level present in `allowed`.
// Returns undefined when the request is not a known level or nothing matches.
export function clampReasoningLevel(
  value: string,
  allowed: readonly string[],
): ReasoningLevel | undefined {
  if (!isReasoningLevel(value)) return undefined;
  const start = REASONING_LEVELS.indexOf(value);
  for (let i = start; i >= 0; i--) {
    const candidate = REASONING_LEVELS[i];
    if (allowed.includes(candidate)) return candidate;
  }
  return undefined;
}

// Split a trailing reasoning suffix off a model id. The suffix is the token
// after the LAST ":" and must be a reasoning level or "auto". A bare ":max"
// without a provider prefix is kept attached unless allowMaxSuffix is set.
export function splitReasoningSuffix(
  model: string,
  options?: { allowMaxSuffix?: boolean },
): { base: string; level?: string } {
  const idx = model.lastIndexOf(":");
  if (idx === -1) return { base: model };
  const base = model.slice(0, idx);
  const token = model.slice(idx + 1);
  if (token !== "auto" && !isReasoningLevel(token)) {
    return { base: model };
  }
  if (token === "max" && !options?.allowMaxSuffix && !base.includes("/")) {
    return { base: model };
  }
  return { base, level: token };
}

// Per-model reasoning override (plan T13). Parsed from astrocode.jsonc
// `reasoning_overrides` (see src/config/astrocode.ts); keyed by the full
// "providerID/modelID" id — the same format as fallback chains.
//
// Precedence rule (documented in README): a reasoning level-suffix in the
// model id (`:high` etc., parsed by splitReasoningSuffix) always beats the
// override — an explicit per-request suffix is the user's most specific
// choice. Override beats the family default.
export interface ReasoningOverride {
  /** Requested reasoning level; must be a REASONING_LEVELS member. */
  level: ReasoningLevel;
  /**
   * Provider passthrough option, attached to `options` ONLY for claude-family
   * models (see reasoningOptionsForOverride). Must be explicit for claude
   * entries: the underlying default is generation-dependent, so silence is
   * treated as a config mistake and the entry is dropped at parse time.
   */
  clear_thinking: boolean;
  /** Explicit claude thinking budget; beats the level-derived budget. */
  budget_tokens?: number;
}

// Claude thinking budget per override level (override path only; the family
// default and the suffix path keep the historical 32000 constant). `off`
// disables thinking entirely; budget_tokens in the override beats this ladder.
export const CLAUDE_LEVEL_BUDGET_TOKENS: Record<ReasoningLevel, number | undefined> = {
  off: undefined,
  minimal: 2048,
  low: 8192,
  medium: 16384,
  high: CLAUDE_THINKING_BUDGET_TOKENS,
  xhigh: CLAUDE_THINKING_BUDGET_TOKENS,
  max: CLAUDE_THINKING_BUDGET_TOKENS,
};

// Provider options for one override entry. claude -> thinking (+ the
// clear_thinking passthrough); gpt -> reasoningEffort; every other family
// takes no reasoning params (grok/glm are id-controlled; minimax takes none),
// so the result is empty and chat.params leaves their options untouched.
export function reasoningOptionsForOverride(
  family: ModelFamily,
  override: ReasoningOverride,
): Record<string, unknown> {
  if (family === "claude") {
    if (override.level === "off") {
      return {
        thinking: { type: "disabled" },
        clear_thinking: override.clear_thinking,
      };
    }
    const budget =
      override.budget_tokens ??
      CLAUDE_LEVEL_BUDGET_TOKENS[override.level] ??
      CLAUDE_THINKING_BUDGET_TOKENS;
    return {
      thinking: { type: "enabled", budgetTokens: budget },
      clear_thinking: override.clear_thinking,
    };
  }
  if (family === "gpt") {
    return { reasoningEffort: gptReasoningEffort(override.level) };
  }
  return {};
}

// What the chat.params hook should apply for one request.
export interface ReasoningDecision {
  /** Provider options to merge into the chat.params output.options. */
  options: Record<string, unknown>;
  /** Where the decision came from (telemetry/debug context). */
  source: "suffix" | "override" | "family";
  /** True when an override entry exists for this exact model id. */
  matched: boolean;
}

// Options merged into an agent's config. `thinking` is an Anthropic passthrough
// option; `reasoningEffort` is an OpenAI passthrough option. Unknown/other
// families get nothing.
export function reasoningConfigForFamily(
  family: ModelFamily,
  level?: ReasoningLevel,
): Record<string, unknown> {
  if (family === "claude") {
    return { thinking: { type: "enabled", budgetTokens: CLAUDE_THINKING_BUDGET_TOKENS } };
  }
  if (family === "gpt") {
    return { reasoningEffort: gptReasoningEffort(level) };
  }
  // Grok reasoning is controlled by the model id, not params; MiniMax M-series
  // takes no reasoning params either.
  if (family === "grok") {
    return {};
  }
  if (family === "minimax") {
    return {};
  }
  return {};
}

function gptReasoningEffort(level?: ReasoningLevel): string {
  switch (level) {
    case "off":
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return "medium";
  }
}

export interface SamplingSettings {
  temperature?: number;
  topP?: number;
}

// Default per-family sampling, preserving astrocode's original behavior:
// the cheap sampling families get temperature 0.3 / topP 0.9.
export const DEFAULT_SAMPLING: Partial<Record<ModelFamily, SamplingSettings>> = {
  kimi: { temperature: 0.3, topP: 0.9 },
  glm: { temperature: 0.3, topP: 0.9 },
  "openrouter-generic": { temperature: 0.3, topP: 0.9 },
};

// User config wins over the defaults, per family.
export function resolveSampling(
  family: ModelFamily,
  overrides?: Partial<Record<string, SamplingSettings>>,
): SamplingSettings | undefined {
  return overrides?.[family] ?? DEFAULT_SAMPLING[family];
}

// Precedence resolver for the chat.params hook (plan T13). Pure decision
// logic; the caller owns warn dedup via the factory below.
//
// 1. A reasoning level-suffix in the model id (`:high`, `:auto`, ...) wins —
//    checked on BOTH the runtime id and the agent's configured model string
//    (suffixes live in astrocode.jsonc agent `model` values; opencode may
//    strip the variant from the runtime id).
// 2. Otherwise an override entry keyed by the exact full model id applies.
// 3. Otherwise the family default (reasoningConfigForFamily, no level).
//
// `matched` reports whether an override entry existed, so the caller can warn
// exactly once per uncovered model id when overrides are in use at all.
export function resolveChatReasoning(params: {
  family: ModelFamily;
  /** Full "providerID/modelID" of the request's model. */
  modelId: string;
  /** The agent's configured model string from astrocode.jsonc, if known. */
  agentModel?: string;
  overrides: Record<string, ReasoningOverride>;
}): ReasoningDecision {
  const suffix =
    (params.agentModel
      ? splitReasoningSuffix(params.agentModel, { allowMaxSuffix: true }).level
      : undefined) ??
    splitReasoningSuffix(params.modelId, { allowMaxSuffix: true }).level;
  if (suffix && isReasoningLevel(suffix)) {
    return {
      options: reasoningConfigForFamily(params.family, suffix),
      source: "suffix",
      matched: params.overrides[params.modelId] !== undefined,
    };
  }

  const override = params.overrides[params.modelId];
  if (override) {
    return {
      options: reasoningOptionsForOverride(params.family, override),
      source: "override",
      matched: true,
    };
  }

  return {
    options: reasoningConfigForFamily(params.family),
    source: "family",
    matched: false,
  };
}

// Bounded warn channel for uncovered models: fires at most once per model id
// per resolver instance (plugin lifetime), and only while at least one
// override is configured — an unused feature must stay silent.
export function createReasoningDecider(
  overrides: Record<string, ReasoningOverride>,
  warn: (message: string) => void,
): (params: {
  family: ModelFamily;
  modelId: string;
  agentModel?: string;
}) => ReasoningDecision {
  const warned = new Set<string>();
  const hasOverrides = Object.keys(overrides).length > 0;
  return (params) => {
    const decision = resolveChatReasoning({ ...params, overrides });
    if (
      hasOverrides &&
      !decision.matched &&
      decision.source === "family" &&
      params.modelId &&
      !warned.has(params.modelId)
    ) {
      warned.add(params.modelId);
      warn(
        `reasoning: no override for ${params.modelId}; using family default`,
      );
    }
    return decision;
  };
}
