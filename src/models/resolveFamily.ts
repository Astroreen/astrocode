/**
 * Model-family router (AD-3). Pure, total, deterministic: never throws, always
 * returns exactly one of the literal families via token-grammar matching on
 * the model ID. No network, no model-registry reads.
 *
 * CALLER NOTE (for src/index.ts): the `modelID` field here is just a local
 * pure-function argument name. The real opencode runtime hook
 * (`experimental.chat.system.transform`) exposes the model as `input.model:
 * Model`, whose SDK type has an `id` field and NO `modelID` field. Callers MUST
 * pass the real model's `id` as this argument, e.g.
 * `resolveFamily({ providerID: model.providerID, modelID: model.id })`.
 * See docs/spike-findings.md "Root cause: modelID field bug".
 *
 * TAXONOMY (9 families): claude / gpt / gemini / kimi / glm / grok / minimax /
 * openrouter-generic / fallback. The model ID is lowercased and tokenized on
 * non-alphanumerics (`o3-mini` -> `["o3","mini"]`); needles match whole tokens
 * (hyphenated ids match as whole token sequences, `dall-e-3` -> `["dall","e"]`),
 * so short needles never fire inside words (`yi` does not match `family`).
 * Rules run first-executed-wins in a fixed order — vendor needles beat `gpt`,
 * so `deepseek/gpt-oss-120b` is openrouter-generic, not gpt.
 *
 * `providerID` is accepted and preserved in the signature but NOT used for
 * routing — no provider gate (a native OpenAI/Google-hosted model still gets
 * its family's treatment). The openrouter slug form `vendor/model-id` works
 * because `vendor` becomes a token: `anthropic/claude-3.5` -> rule "claude".
 * The family taxonomy drives BOTH the sampling tweak (isCheapSamplingFamily)
 * AND the Sisyphus dynamic-prompt engine's per-family delta content.
 */

export type ModelFamily =
  | "claude"
  | "gpt"
  | "gemini"
  | "kimi"
  | "glm"
  | "grok"
  | "minimax"
  | "openrouter-generic"
  | "fallback";

export function resolveFamily(model: {
  providerID: string;
  modelID: string;
}): ModelFamily {
  const tokens = (model?.modelID ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = ` ${tokens.join(" ")} `;
  const has = (token: string): boolean => tokens.includes(token);
  const hasSeq = (sequence: string): boolean =>
    joined.includes(` ${sequence} `);

  if (
    has("claude") ||
    has("opus") ||
    has("sonnet") ||
    has("haiku") ||
    has("fable") ||
    has("mythos")
  ) {
    return "claude";
  }
  if (
    has("kimi") ||
    has("moonshot") ||
    has("k2") ||
    has("k3") ||
    (has("swe") && has("2"))
  ) {
    return "kimi";
  }
  if (has("glm") || has("zhipu") || has("bigmodel")) return "glm";
  if (has("grok")) return "grok";
  if (has("minimax")) return "minimax";
  if (has("gemini") || has("gemma")) return "gemini";
  if (has("deepseek") || has("qwen") || has("yi")) return "openrouter-generic";
  if (
    has("gpt") ||
    has("chatgpt") ||
    has("dalle") ||
    has("openai") ||
    has("codex") ||
    hasSeq("dall e") ||
    joined.includes(" text embedding") ||
    hasSeq("text davinci") ||
    tokens.some((token) => /^o[1-9]$/.test(token))
  ) {
    return "gpt";
  }
  if (has("openrouter")) return "openrouter-generic";

  return "fallback";
}

/**
 * Families that get the steadier chat.params sampling override
 * (temperature/topP) - the same set the old "cheap-openrouter" bucket
 * covered (kimi/glm/deepseek/qwen/minimax/yi/zhipu), now split across
 * kimi/glm/openrouter-generic. claude/gpt/gemini/grok/minimax/fallback keep
 * whatever defaults the core/provider already set.
 */
export function isCheapSamplingFamily(family: ModelFamily): boolean {
  return (
    family === "kimi" || family === "glm" || family === "openrouter-generic"
  );
}
