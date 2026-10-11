// System-prompt freeze (plan T8).
//
// `experimental.chat.system.transform` must be byte-stable per session: the
// first assembled system prompt for a (session, model, pre-filled base) key is
// remembered, and every later transform matching that key returns exactly
// those bytes. If a later assembly ever diverges from the frozen one, the
// divergence is recorded as a "system_diff" telemetry record (sha256 of both
// variants) and the frozen version is still what the model sees — a drifting
// prompt would otherwise invalidate the provider's prompt cache on every turn.
//
// The freeze map is an LRU capped at 200 entries: Map preserves insertion
// order, re-accessing an entry moves it to the most-recent end, and the
// oldest entry is evicted when the cap is exceeded. No dependencies.

import { createHash } from "node:crypto";

/** Maximum number of sessions whose frozen prompt is retained. */
export const FREEZE_MAP_CAP = 200;

/** sha256 hex digest of a text blob (used for system-prompt comparison). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical byte form of a system array: items joined with a separator that
 * cannot appear inside a prompt item, so item boundaries are unambiguous. */
export function systemPromptKey(system: readonly string[]): string {
  return system.join("\n\u0000\n");
}

/** Freeze-map key for one system-prompt variant.
 *
 * Live audit (T8, 2026-10-10) showed a sessionID-only key is harmful: opencode
 * fires auxiliary requests (e.g. session-title generation) for the SAME
 * sessionID with a different model and a different pre-filled base ("You are a
 * title generator..."), and the first of those froze the whole session — the
 * real chat request then received the title-generator bytes. The provider
 * prompt cache is per-model anyway, so the freeze must be scoped to
 * (session, model, pre-filled base): the base hash distinguishes request kinds
 * sharing one model, the model distinguishes guard families sharing one
 * session. */
export function systemFreezeKey(
  sessionID: string,
  providerID: string,
  modelID: string,
  baseSha256: string,
): string {
  return [sessionID, providerID, modelID, baseSha256].join("\u0000");
}

export class SystemPromptFreeze {
  private readonly frozen = new Map<string, string[]>();
  private readonly cap: number;

  constructor(cap: number = FREEZE_MAP_CAP) {
    this.cap = cap;
  }

  /** Number of sessions currently frozen. */
  get size(): number {
    return this.frozen.size;
  }

  /** True when a frozen prompt exists for the session. */
  has(sessionID: string): boolean {
    return this.frozen.has(sessionID);
  }

  /** Frozen items for the session, or undefined. Touches LRU recency. */
  get(sessionID: string): string[] | undefined {
    const value = this.frozen.get(sessionID);
    if (value === undefined) return undefined;
    // Move to the most-recent end (Map iteration order = insertion order).
    this.frozen.delete(sessionID);
    this.frozen.set(sessionID, value);
    return value;
  }

  /** Freeze a slice copy of the assembled system array for the session.
   * Evicts the least-recently-used entry when over the cap. */
  set(sessionID: string, system: readonly string[]): void {
    if (this.frozen.has(sessionID)) this.frozen.delete(sessionID);
    this.frozen.set(sessionID, [...system]);
    while (this.frozen.size > this.cap) {
      const oldest = this.frozen.keys().next();
      if (oldest.done) break;
      this.frozen.delete(oldest.value);
    }
  }

  /** Drop every frozen entry (used by dispose and tests). */
  clear(): void {
    this.frozen.clear();
  }
}
