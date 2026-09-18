/**
 * Model-family router (AD-3). Pure, total, deterministic: never throws, always
 * returns exactly one of the three literal families via case-insensitive
 * substring matching. No network, no model-registry reads.
 *
 * CALLER NOTE (for src/index.ts / Task 5): the `modelID` field here is just a
 * local pure-function argument name. The real opencode runtime hook
 * (`experimental.chat.system.transform`) exposes the model as `input.model:
 * Model`, whose SDK type has an `id` field and NO `modelID` field. Callers MUST
 * pass the real model's `id` as this argument, e.g.
 * `resolveFamily({ providerID: model.providerID, modelID: model.id })`.
 * See docs/spike-findings.md "Root cause: modelID field bug".
 */

export type ModelFamily = "claude" | "cheap-openrouter" | "fallback";

const CHEAP_OPENROUTER_MODELS = [
  "deepseek",
  "glm",
  "kimi",
  "qwen",
  "minimax",
  "yi",
  "zhipu",
] as const;

export function resolveFamily(model: {
  providerID: string;
  modelID: string;
}): ModelFamily {
  if ((model?.modelID ?? "").toLowerCase().includes("claude")) return "claude";

  if (
    (model?.providerID ?? "").toLowerCase().includes("openrouter") &&
    CHEAP_OPENROUTER_MODELS.some((needle) =>
      (model?.modelID ?? "").toLowerCase().includes(needle),
    )
  ) {
    return "cheap-openrouter";
  }

  return "fallback";
}
