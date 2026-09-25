// Sisyphus dynamic-prompt dispatch (Option C hybrid, see docs/porting-plan.md).
//
// `experimental.chat.system.transform`'s hook signature is `(input: {
// sessionID?: string; model: Model }, output: { system: string[] })` — it has
// NO `agent` field, so we cannot ask "is this Sisyphus?" directly. Instead we
// scan `output.system` for a stable, unique marker string from
// agents/sisyphus.md's own Role block, which is confirmed (docs/spike-findings.md)
// to already be present in `output.system` by the time this hook fires.
//
// If detected, we build a family-specific dynamic delta (Key Triggers / Tool
// Selection Table / Delegation Table / family calibration / etc, all sourced
// live from src/agents/metadata.ts) and the caller appends it to
// `output.system` — never replaces. This keeps agents/sisyphus.md as the
// static baseline persona and layers runtime-accurate, family-aware content
// on top (AD-1 append-only spirit).

import type { ModelFamily } from "../../models/resolveFamily";
import { resolveModelVersion } from "../../models/resolveVersion";
import { VERSION_BUILDERS } from "./families/versions";
import { buildClaudeSisyphusPrompt } from "./families/claude";
import { buildGptSisyphusPrompt } from "./families/gpt";
import { buildGlmSisyphusPrompt } from "./families/glm";
import { buildKimiSisyphusPrompt } from "./families/kimi";
import { buildFallbackSisyphusPrompt } from "./families/fallback";
import { buildGeminiSisyphusPrompt } from "./families/gemini";
import { buildGrokSisyphusPrompt } from "./families/grok";
import { buildMinimaxSisyphusPrompt } from "./families/minimax";

// Verbatim substring from agents/sisyphus.md's <Role> block (line 8). Kept in
// sync manually — if sisyphus.md's opening line ever changes, update this too.
export const SISYPHUS_MARKER = "You are Sisyphus - the Master Orchestrator.";

export function isSisyphusSession(system: string[]): boolean {
  return system.some((entry) => entry.includes(SISYPHUS_MARKER));
}

export function buildDynamicSisyphusPrompt(
  family: ModelFamily,
  modelID?: string,
): string {
  if (modelID) {
    const version = resolveModelVersion(modelID);
    const versionBuilder = version ? VERSION_BUILDERS[version] : undefined;
    if (versionBuilder) return versionBuilder();
  }

  switch (family) {
    case "claude":
      return buildClaudeSisyphusPrompt();
    case "gpt":
      return buildGptSisyphusPrompt();
    case "glm":
      return buildGlmSisyphusPrompt();
    case "kimi":
      return buildKimiSisyphusPrompt();
    case "gemini":
      return buildGeminiSisyphusPrompt();
    case "grok":
      return buildGrokSisyphusPrompt();
    case "minimax":
      return buildMinimaxSisyphusPrompt();
    case "openrouter-generic":
    case "fallback":
    default:
      return buildFallbackSisyphusPrompt();
  }
}
