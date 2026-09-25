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
