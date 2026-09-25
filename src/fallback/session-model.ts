// Sticky fallback model per session.
//
// When a *terminal* limit is hit (subscription/quota/session limit — the model
// stays unusable for a while, not just momentarily overloaded), opencode's own
// retry loop would keep hammering the exhausted model on every following turn.
// oh-my-openagent solves this by remembering the fallback model and rewriting
// the outgoing message's model in `chat.message`
// (hooks/runtime-fallback/chat-message-handler.ts).
//
// We keep that idea but add a bounded pin window: while the fallback is fresh the
// client's still-stale primary-model request is overridden; once the window
// elapses, or the user picks any other model, the primary is restored. Transient
// (non-terminal) failures are never pinned — they stay one-shot resubmissions.
//
// Process-local: a plugin restart forgets the pin, which is acceptable (the
// session then simply re-detects the limit on its next turn).

import { evictOldestByStamp } from "./state";

export interface SessionModelState {
  /** Model the session was on when the terminal limit was hit. */
  originalModel: string;
  /** Model we switched the session to. */
  currentModel: string;
  /** When the pin was last refreshed (ms epoch). */
  pinnedAt: number;
}

// Never let the pin window collapse to zero: a config with `cooldown_seconds: 0`
// would otherwise disable persistence entirely.
const MIN_PIN_SECONDS = 60;

const states = new Map<string, SessionModelState>();

export function setSessionFallbackModel(
  sessionID: string,
  originalModel: string,
  fallbackModel: string,
  now: number = Date.now(),
): void {
  states.set(sessionID, {
    originalModel,
    currentModel: fallbackModel,
    pinnedAt: now,
  });
  evictOldestByStamp(states, undefined, (state) => state.pinnedAt);
}

export function getSessionModelState(
  sessionID: string,
): SessionModelState | undefined {
  return states.get(sessionID);
}

/** Refresh the pin window (called whenever we confirm the fallback is in use). */
export function touchSessionFallbackModel(
  sessionID: string,
  now: number = Date.now(),
): void {
  const state = states.get(sessionID);
  if (state) state.pinnedAt = now;
}

/**
 * True while the fallback pin is fresh enough to override a stale primary-model
 * request from a client that has not learned about the switch yet.
 */
export function isFallbackPinActive(
  sessionID: string,
  cooldownSeconds: number,
  now: number = Date.now(),
): boolean {
  const state = states.get(sessionID);
  if (!state) return false;
  const windowSeconds = Math.max(cooldownSeconds, MIN_PIN_SECONDS);
  return (now - state.pinnedAt) / 1000 < windowSeconds;
}

export function clearSessionModelState(sessionID: string): void {
  states.delete(sessionID);
}

export function clearAllSessionModels(): void {
  states.clear();
}
