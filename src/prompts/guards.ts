// VERBATIM from oh-my-openagent bundle — do NOT paraphrase (preserves OMO's tuned wording).
// Source: ~/.cache/opencode/node_modules/oh-my-openagent/dist/index.js
//   TOOL_LOOP_GUARD      <- KIMI_TOOL_LOOP_GUARD     @ line 155666
//   APPLY_PATCH_GUIDANCE <- GPT_APPLY_PATCH_GUIDANCE @ line 154850

// ModelFamily lives in ./models/resolveFamily (single source of truth) —
// this module used to declare its own divergent 3-value copy of the type;
// that copy is gone now that resolveFamily.ts owns the full 7-value taxonomy.
import type { ModelFamily } from "../models/resolveFamily";
export type { ModelFamily };

export const TOOL_LOOP_GUARD = `<tool_loop_guard>
Never call the same tool with the same arguments more than twice in a row.
If a third identical call seems necessary, stop calling tools and report the blocker, missing evidence, or changed input that would justify another attempt.
Repeated identical tool calls are a loop signal, not persistence.
</tool_loop_guard>`;

export const APPLY_PATCH_GUIDANCE =
  "Use `apply_patch` for file edits. Keep patches small and match the surrounding lines exactly so verification passes.";

export const EDIT_TOOL_GUIDANCE =
  "Use the `edit` tool for file edits. Keep patches small and match the surrounding lines exactly so verification passes.";

/**
 * Gate mirrors the real opencode tool-visibility rule
 * (`packages/opencode/src/tool/registry.ts:295-301` — source of truth):
 * `apply_patch` is shown iff the modelID includes "gpt-" but not "oss" and not
 * "gpt-4"; `edit`/`write` are shown otherwise. Guidance must never mention a
 * tool the model does not have. The gate is intentionally substring-based on
 * `gpt-` (same as opencode's) — `family` is not used for this decision beyond
 * the claude special case (claude gets no edit guidance at all).
 */
export function getGuards(family: ModelFamily, modelID: string): string[] {
  const useApplyPatch = modelID.toLowerCase().includes("gpt-")
    && !modelID.toLowerCase().includes("oss")
    && !modelID.toLowerCase().includes("gpt-4");
  if (useApplyPatch) return [TOOL_LOOP_GUARD, APPLY_PATCH_GUIDANCE];
  if (family === "claude") return [];
  return [TOOL_LOOP_GUARD, EDIT_TOOL_GUIDANCE];
}
