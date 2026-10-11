// Per-session model cooldown registry (plan T14).
//
// When a fallback rotation leaves a model behind (it just failed), that model
// enters a cooldown window — the per-model `cooldown_seconds_by_model` override
// or the global `cooldown_seconds`. While the window is active the fallback
// chain selection skips the model; once it elapses the model becomes selectable
// again. This keeps a flapping model from being re-picked on the very next
// rotation while leaving the rest of the chain order untouched.
//
// Scope is per-session on purpose (same discipline as state.ts /
// session-model.ts): a model failing in one session must not silently vanish
// from another session's chain. Process-local — a plugin restart forgets the
// windows, which is acceptable (the next failure re-arms them).

import { evictOldestByStamp } from "./state";

interface SessionCooldowns {
  /** Lowercased model id -> cooldown-until (ms epoch). */
  models: Map<string, number>;
  /** Last write stamp, for the bounded-map eviction. */
  stamp: number;
}

const states = new Map<string, SessionCooldowns>();

const MAX_SESSIONS = 1024;
const MAX_MODELS_PER_SESSION = 64;

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Arm (or re-arm) the cooldown window for one model in one session. Returns
 * the window's end as a ms epoch (== `now` when `cooldownSeconds` is 0, i.e.
 * no cooldown). Never throws.
 */
export function markModelCooldown(
  sessionID: string,
  model: string,
  cooldownSeconds: number,
  now: number = Date.now(),
): number {
  const key = normalizeModel(model);
  if (!key) return now;
  const seconds = cooldownSeconds > 0 ? cooldownSeconds : 0;
  const until = now + seconds * 1000;

  let entry = states.get(sessionID);
  if (!entry) {
    entry = { models: new Map(), stamp: now };
    states.set(sessionID, entry);
  }
  // Drop expired windows first so a long-lived session cannot accumulate
  // stale entries, then enforce the hard per-session cap.
  if (entry.models.size >= MAX_MODELS_PER_SESSION) {
    for (const [name, untilMs] of entry.models) {
      if (untilMs <= now) entry.models.delete(name);
    }
    while (entry.models.size >= MAX_MODELS_PER_SESSION) {
      const oldest = entry.models.keys().next();
      if (oldest.done) break;
      entry.models.delete(oldest.value);
    }
  }
  entry.models.set(key, until);
  entry.stamp = now;
  evictOldestByStamp(states, MAX_SESSIONS, (value) => value.stamp);
  return until;
}

/** True while the model's cooldown window is still active. */
export function isModelCoolingDown(
  sessionID: string,
  model: string,
  now: number = Date.now(),
): boolean {
  const entry = states.get(sessionID);
  if (!entry) return false;
  const until = entry.models.get(normalizeModel(model));
  if (until === undefined) return false;
  if (until <= now) {
    // Expired: lazy-delete so the map does not grow without bound.
    entry.models.delete(normalizeModel(model));
    return false;
  }
  return true;
}

/** Remaining cooldown seconds for a model (0 when none is active). */
export function modelCooldownRemainingSeconds(
  sessionID: string,
  model: string,
  now: number = Date.now(),
): number {
  const entry = states.get(sessionID);
  if (!entry) return 0;
  const until = entry.models.get(normalizeModel(model));
  if (until === undefined || until <= now) return 0;
  return (until - now) / 1000;
}

export function clearModelCooldowns(sessionID: string): void {
  states.delete(sessionID);
}

export function clearAllModelCooldowns(): void {
  states.clear();
}
