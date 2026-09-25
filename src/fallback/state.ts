// In-memory per-session fallback attempt tracking. Deliberately simple (the
// 80/20 of oh-my-openagent's multi-Map state machine, see docs/porting-plan.md
// "Fallback module design"): one entry per session, cleared on success/dispose.
// Process-local — a plugin restart forgets attempts, which is acceptable.

interface SessionAttemptState {
  attempts: number;
  lastAttemptAt: number;
  model: string;
  sameModelAttempts: number;
  consecutiveFailures: number;
}

const states = new Map<string, SessionAttemptState>();

// Dedup keys for `session.status` retry events. opencode emits a retry status on
// every backoff tick, and the same failure may also surface as `session.error` /
// `message.updated`; without this the same attempt would dispatch a fallback more
// than once. Key mirrors oh-my-openagent: model + attempt + normalized message.
const retryKeys = new Map<string, Set<string>>();
const MAX_RETRY_KEYS_PER_SESSION = 64;

// Hard bound on the per-session maps so a long-running process cannot leak
// entries across thousands of sessions.
const MAX_STATES = 1024;

function readStamp(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stamp = (value as { stamp?: unknown }).stamp;
  return typeof stamp === "number" ? stamp : undefined;
}

// Drop the oldest 25% of entries once `map` exceeds `max`. "Oldest" is by
// `stamp` (or a custom `stampOf`) when values carry one, otherwise Map
// insertion order (stable sort keeps it). Never throws.
export function evictOldestByStamp<T>(
  map: Map<string, T>,
  max: number = MAX_STATES,
  stampOf: (value: T) => number | undefined = (value) => readStamp(value),
): void {
  if (map.size <= max) return;
  const dropCount = Math.ceil(map.size * 0.25);
  const entries = [...map.entries()];
  entries.sort((a, b) => {
    const sa = stampOf(a[1]);
    const sb = stampOf(b[1]);
    if (sa === undefined || sb === undefined) return 0;
    return sa - sb;
  });
  for (let i = 0; i < dropCount; i += 1) {
    map.delete(entries[i][0]);
  }
}

function evictStates(): void {
  evictOldestByStamp(states, MAX_STATES, (state) => state.lastAttemptAt);
}

// Exponential backoff: base cooldown doubles per consecutive failure, capped at
// 2^5 (32x). Kept in sync with the idle-continuation backoff.
export function effectiveCooldownSeconds(baseCooldownSeconds: number, failures: number): number {
  return baseCooldownSeconds * 2 ** Math.min(failures, 5);
}

// True when the session has exhausted max_attempts. Cooldown is NEVER consulted
// here: rotations must survive a second consecutive failure (the dead-account
// hop) instead of being self-throttled right when they are needed most.
export function shouldThrottleRotation(sessionID: string, maxAttempts: number): boolean {
  const state = states.get(sessionID);
  if (!state) return false;
  return state.attempts >= maxAttempts;
}

// True when the cooldown between same-model attempts has not yet elapsed
// (exponential per consecutive failure).
export function shouldThrottleSameModel(
  sessionID: string,
  cooldownSeconds: number,
  now: number = Date.now(),
): boolean {
  const state = states.get(sessionID);
  if (!state) return false;
  const elapsedSeconds = (now - state.lastAttemptAt) / 1000;
  return elapsedSeconds < effectiveCooldownSeconds(cooldownSeconds, state.consecutiveFailures);
}

export function recordAttempt(
  sessionID: string,
  model: string,
  now: number = Date.now(),
): number {
  const state = states.get(sessionID);
  const attempts = state ? state.attempts + 1 : 1;
  states.set(sessionID, {
    attempts,
    lastAttemptAt: now,
    model,
    // A rotation switches models: the new model gets a fresh same-model retry
    // budget.
    sameModelAttempts: 0,
    consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
  });
  evictStates();
  return attempts;
}

export function getAttemptCount(sessionID: string): number {
  return states.get(sessionID)?.attempts ?? 0;
}

export function getLastFallbackModel(sessionID: string): string | undefined {
  return states.get(sessionID)?.model;
}

export function getSameModelAttempts(sessionID: string): number {
  return states.get(sessionID)?.sameModelAttempts ?? 0;
}

// Returns the new same-model attempt count. Creates the state entry when the
// session has none yet (a first failure can precede any rotation).
export function incrementSameModelAttempts(sessionID: string): number {
  const state = states.get(sessionID);
  if (state) {
    state.sameModelAttempts += 1;
    return state.sameModelAttempts;
  }
  states.set(sessionID, {
    attempts: 0,
    lastAttemptAt: Date.now(),
    model: "",
    sameModelAttempts: 1,
    consecutiveFailures: 0,
  });
  evictStates();
  return 1;
}

export function resetSameModelAttempts(sessionID: string): void {
  const state = states.get(sessionID);
  if (state) state.sameModelAttempts = 0;
}

export function resetFailures(sessionID: string): void {
  const state = states.get(sessionID);
  if (state) state.consecutiveFailures = 0;
}

export function resetAttempts(sessionID: string): void {
  states.delete(sessionID);
  retryKeys.delete(sessionID);
}

// Returns true the first time a given retry key is seen for a session, false for
// duplicates. Bounded so a long retry storm cannot grow the set without limit.
export function markRetryKey(sessionID: string, key: string): boolean {
  let seen = retryKeys.get(sessionID);
  if (!seen) {
    seen = new Set();
    retryKeys.set(sessionID, seen);
  }
  if (seen.has(key)) return false;
  if (seen.size >= MAX_RETRY_KEYS_PER_SESSION) seen.clear();
  seen.add(key);
  evictOldestByStamp(retryKeys);
  return true;
}

export function clearRetryKeys(sessionID: string): void {
  retryKeys.delete(sessionID);
}

export function clearAll(): void {
  states.clear();
  retryKeys.clear();
}
