/**
 * Model-family router (AD-3). Pure, total, deterministic: never throws, always
 * returns exactly one of the literal families via case-insensitive substring
 * matching on the model ID. No network, no model-registry reads.
 *
 * CALLER NOTE (for src/index.ts): the `modelID` field here is just a local
 * pure-function argument name. The real opencode runtime hook
 * (`experimental.chat.system.transform`) exposes the model as `input.model:
 * Model`, whose SDK type has an `id` field and NO `modelID` field. Callers MUST
 * pass the real model's `id` as this argument, e.g.
 * `resolveFamily({ providerID: model.providerID, modelID: model.id })`.
 * See docs/spike-findings.md "Root cause: modelID field bug".
 *
 * TAXONOMY (expanded from the original 3-bucket claude/cheap-openrouter/
 * fallback split): matches oh-my-openagent's actual per-family prompt-engine
 * scope (claude / gpt / gemini / kimi / glm each got their own dynamic-prompt
 * delta file). `openrouter-generic` groups the remaining
 * deepseek/qwen/minimax/yi/zhipu models that oh-my-openagent did NOT give a
 * dedicated delta file to (they fell through to its `default.ts`/fallback
 * builder). Detection is by model ID only, NOT gated on providerID==
 * "openrouter" - a native OpenAI/Google-hosted model still gets its family's
 * treatment, since the family taxonomy now drives BOTH the sampling tweak
 * (see isCheapSamplingFamily) AND the Sisyphus dynamic-prompt engine's
 * per-family delta content, not just a cost bucket.
 */

export type ModelFamily =
  | "claude"
  | "gpt"
  | "gemini"
  | "kimi"
  | "glm"
  | "openrouter-generic"
  | "fallback";

const OPENROUTER_GENERIC_MODELS = [
  "deepseek",
  "qwen",
  "minimax",
  "yi",
  "zhipu",
] as const;

export function resolveFamily(model: {
  providerID: string;
  modelID: string;
}): ModelFamily {
  const modelID = (model?.modelID ?? "").toLowerCase();

  if (modelID.includes("claude")) return "claude";
  if (modelID.includes("gpt")) return "gpt";
  if (modelID.includes("gemini")) return "gemini";
  if (modelID.includes("kimi")) return "kimi";
  if (modelID.includes("glm")) return "glm";
  if (OPENROUTER_GENERIC_MODELS.some((needle) => modelID.includes(needle))) {
    return "openrouter-generic";
  }

  return "fallback";
}

/**
 * Families that get the steadier chat.params sampling override
 * (temperature/topP) - the same set the old "cheap-openrouter" bucket
 * covered (kimi/glm/deepseek/qwen/minimax/yi/zhipu), now split across
 * kimi/glm/openrouter-generic. claude/gpt/gemini/fallback keep whatever
 * defaults the core/provider already set.
 */
export function isCheapSamplingFamily(family: ModelFamily): boolean {
  return (
    family === "kimi" || family === "glm" || family === "openrouter-generic"
  );
}
