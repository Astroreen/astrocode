// VERBATIM from oh-my-openagent bundle — do NOT paraphrase (preserves OMO's tuned wording).
// Source: ~/.cache/opencode/node_modules/oh-my-openagent/dist/index.js
//   TOOL_LOOP_GUARD      <- KIMI_TOOL_LOOP_GUARD     @ line 155666
//   APPLY_PATCH_GUIDANCE <- GPT_APPLY_PATCH_GUIDANCE @ line 154850

export type ModelFamily = "claude" | "cheap-openrouter" | "fallback";

export const TOOL_LOOP_GUARD = `<tool_loop_guard>
Never call the same tool with the same arguments more than twice in a row.
If a third identical call seems necessary, stop calling tools and report the blocker, missing evidence, or changed input that would justify another attempt.
Repeated identical tool calls are a loop signal, not persistence.
</tool_loop_guard>`;

export const APPLY_PATCH_GUIDANCE =
  "Use `apply_patch` for file edits. Keep patches small and match the surrounding lines exactly so verification passes.";

export function getGuards(family: ModelFamily): string[] {
  switch (family) {
    case "claude":
      return [];
    case "cheap-openrouter":
      return [TOOL_LOOP_GUARD, APPLY_PATCH_GUIDANCE];
    case "fallback":
    default:
      return [TOOL_LOOP_GUARD, APPLY_PATCH_GUIDANCE];
  }
}
