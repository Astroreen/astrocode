/**
 * Version-level model detection. Pure, total, deterministic: never throws and
 * returns either a known `ModelVersion` literal or `undefined`. No network, no
 * model-registry reads, no side effects.
 *
 * Input is normalized (lowercased, all "." replaced with "-") before matching
 * so callers can pass raw model IDs like "claude-opus-4.8" or "kimi-k2.7".
 * Detection is first-match-wins in the order claude -> kimi -> grok -> minimax.
 */

export type ModelVersion =
  | "claude-opus-4-7"
  | "claude-opus-4-8"
  | "claude-opus-5"
  | "claude-fable"
  | "claude-mythos"
  | "kimi-k2-6"
  | "kimi-k2-7"
  | "kimi-k2-8"
  | "kimi-k3"
  | "kimi-swe-2"
  | "grok-4-5"
  | "grok-4-6"
  | "minimax";

export function resolveModelVersion(modelID: string): ModelVersion | undefined {
  if (typeof modelID !== "string") return undefined;

  const normalized = modelID.toLowerCase().replaceAll(".", "-");

  // 1. claude
  if (normalized.includes("claude-opus-4-7")) return "claude-opus-4-7";
  if (normalized.includes("claude-opus-4-8")) return "claude-opus-4-8";
  if (normalized.includes("claude-opus-5")) return "claude-opus-5";
  if (/claude-(?:fable|mythos)-(?:\d+|preview)/.test(normalized)) {
    if (normalized.includes("claude-fable")) return "claude-fable";
    return "claude-mythos";
  }

  // 2. kimi
  if (/kimi-k2[.\-]?6/.test(normalized)) return "kimi-k2-6";
  if (/kimi-k2[.\-]?7/.test(normalized)) return "kimi-k2-7";
  if (/kimi-k2[.\-]?8/.test(normalized)) return "kimi-k2-8";
  if (/kimi-k3/.test(normalized)) return "kimi-k3";
  if (/^swe-2(?:[-.]|$)/.test(normalized)) return "kimi-swe-2";

  // 3. grok
  if (/grok-4-5(?![0-9])/.test(normalized)) return "grok-4-5";
  if (/grok-4-6(?![0-9])/.test(normalized)) return "grok-4-6";

  // 4. minimax
  if (normalized.includes("minimax")) return "minimax";

  return undefined;
}