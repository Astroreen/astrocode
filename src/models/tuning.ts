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

// Options merged into an agent's config. `thinking` is an Anthropic passthrough
// option; `reasoningEffort` is an OpenAI passthrough option. Unknown/other
// families get nothing.
export function reasoningConfigForFamily(
  family: ModelFamily,
): Record<string, unknown> {
  if (family === "claude") {
    return { thinking: { type: "enabled", budgetTokens: CLAUDE_THINKING_BUDGET_TOKENS } };
  }
  if (family === "gpt") {
    return { reasoningEffort: "medium" };
  }
  return {};
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
