// Force-compact marker handling (plan T12.2).
//
// The `/astrocode:compact` slash command template embeds an HTML-comment
// marker. Two seams consume it:
//
//   1. `chat.message` (src/index.ts): detects the marker in the incoming user
//      parts and either triggers the compaction engine IMMEDIATELY (force
//      semantics: ratio and cooldown are ignored) or — when
//      `compaction.enabled === false` — refuses with a toast and does nothing
//      else. Pure decision: forceCompactRequest().
//   2. `experimental.chat.messages.transform` (src/index.ts): strips the
//      marker from every text part of the request-built view and replaces it
//      with the neutral text, so the marker NEVER reaches the model. This
//      runs on EVERY request build and independent of compaction enablement
//      (no marker leak even in the refusal path). Persistent storage is not
//      touched: the view is rebuilt from storage each time, so the
//      replacement bytes are identical on every rebuild (cache-epoch rule
//      intact — no mutation of already-sent bytes outside an epoch break,
//      because the stripped view is the only bytes ever sent).
//
// PURE layer: no I/O, no clock, no module state.

import type { PruneMessage } from "./prune";

/** Exact marker embedded in the /astrocode:compact command template. */
export const FORCE_COMPACT_MARKER = "<!-- astrocode:force-compact -->";

/** Neutral model-visible replacement for the marker. */
export const FORCE_COMPACT_NEUTRAL_TEXT = "Compaction requested.";

/** What the chat.message seam should do with an incoming user message. */
export type ForceCompactAction =
  /** Marker present and compaction enabled -> arm + run the engine now. */
  | "trigger"
  /** Marker present but compaction disabled -> toast refusal, nothing else. */
  | "refuse"
  /** No marker -> not our command; do nothing. */
  | "none";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when any text part of the parts array contains the marker. */
export function hasForceMarker(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (!isPlainObject(part) || part.type !== "text") continue;
    const text = part.text;
    if (typeof text === "string" && text.includes(FORCE_COMPACT_MARKER)) {
      return true;
    }
  }
  return false;
}

/**
 * Pure decision for the chat.message seam: scan the incoming user parts for
 * the force marker and map (marker, enabled) -> action. Never throws.
 */
export function forceCompactRequest(
  parts: unknown,
  enabled: boolean,
): ForceCompactAction {
  if (!hasForceMarker(parts)) return "none";
  return enabled ? "trigger" : "refuse";
}

/** Replace every marker occurrence with the neutral text. */
export function stripForceMarkerText(text: string): string {
  return text.split(FORCE_COMPACT_MARKER).join(FORCE_COMPACT_NEUTRAL_TEXT);
}

/**
 * Strip the marker from every text part of the request-built message array
 * IN PLACE (the hook contract is mutate-in-place). Returns the number of
 * parts changed so the caller can log it. Idempotent: a second pass over the
 * same array finds no markers and changes nothing. Never throws.
 */
export function stripForceMarkers(messages: readonly PruneMessage[]): number {
  if (!Array.isArray(messages)) return 0;
  let changed = 0;
  for (const message of messages) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const part of parts) {
      if (!isPlainObject(part) || part.type !== "text") continue;
      if (typeof part.text !== "string") continue;
      if (!part.text.includes(FORCE_COMPACT_MARKER)) continue;
      part.text = stripForceMarkerText(part.text);
      changed += 1;
    }
  }
  return changed;
}
