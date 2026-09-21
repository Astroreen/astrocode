import type { ModelVersion } from "../../../../models/resolveVersion";
import { buildClaudeOpus47SisyphusPrompt } from "./claude-opus-4-7";
import { buildClaudeOpus48SisyphusPrompt } from "./claude-opus-4-8";
import { buildClaudeOpus5SisyphusPrompt } from "./claude-opus-5";
import { buildClaudeFableSisyphusPrompt } from "./claude-fable";
import { buildClaudeMythosSisyphusPrompt } from "./claude-mythos";
import { buildKimiK26SisyphusPrompt } from "./kimi-k2-6";
import { buildKimiK27SisyphusPrompt } from "./kimi-k2-7";
import { buildKimiK28SisyphusPrompt } from "./kimi-k2-8";
import { buildKimiK3SisyphusPrompt } from "./kimi-k3";
import { buildKimiSwe2SisyphusPrompt } from "./kimi-swe-2";
import { buildGrok45SisyphusPrompt } from "./grok-4-5";
import { buildGrok46SisyphusPrompt } from "./grok-4-6";
import { buildMinimaxSisyphusPrompt } from "./minimax";

export const VERSION_BUILDERS: Partial<Record<ModelVersion, () => string>> = {
  "claude-opus-4-7": buildClaudeOpus47SisyphusPrompt,
  "claude-opus-4-8": buildClaudeOpus48SisyphusPrompt,
  "claude-opus-5": buildClaudeOpus5SisyphusPrompt,
  "claude-fable": buildClaudeFableSisyphusPrompt,
  "claude-mythos": buildClaudeMythosSisyphusPrompt,
  "kimi-k2-6": buildKimiK26SisyphusPrompt,
  "kimi-k2-7": buildKimiK27SisyphusPrompt,
  "kimi-k2-8": buildKimiK28SisyphusPrompt,
  "kimi-k3": buildKimiK3SisyphusPrompt,
  "kimi-swe-2": buildKimiSwe2SisyphusPrompt,
  "grok-4-5": buildGrok45SisyphusPrompt,
  "grok-4-6": buildGrok46SisyphusPrompt,
  minimax: buildMinimaxSisyphusPrompt,
};