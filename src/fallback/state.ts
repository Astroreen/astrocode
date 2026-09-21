// In-memory per-session fallback attempt tracking. Deliberately simple (the
// 80/20 of oh-my-openagent's multi-Map state machine, see docs/porting-plan.md
// "Fallback module design"): one entry per session, cleared on success/dispose.
// Process-local — a plugin restart forgets attempts, which is acceptable.

interface SessionAttemptState {
  attempts: number;
  lastAttemptAt: number;
  model: string;
  sameModelRetried: boolean;
  consecutiveFailures: number;
}

const states = new Map<string, SessionAttemptState>();

// Dedup keys for `session.status` retry events. opencode emits a retry status on
// every backoff tick, and the same failure may also surface as `session.error` /
// `message.updated`; without this the same attempt would dispatch a fallback more
// than once. Key mirrors oh-my-openagent: model + attempt + normalized message.
const retryKeys = new Map<string, Set<string>>();
const MAX_RETRY_KEYS_PER_SESSION = 64;

// Exponential backoff: base cooldown doubles per consecutive failure, capped at
// 2^5 (32x). Kept in sync with the idle-continuation backoff.
export function effectiveCooldownSeconds(baseCooldownSeconds: number, failures: number): number {
  return baseCooldownSeconds * 2 ** Math.min(failures, 5);
}

// True when the session has exhausted max_attempts or the cooldown between
// attempts has not yet elapsed.
export function shouldThrottle(
  sessionID: string,
  maxAttempts: number,
  cooldownSeconds: number,
  now: number = Date.now(),
): boolean {
  const state = states.get(sessionID);
  if (!state) return false;
  if (state.attempts >= maxAttempts) return true;
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
    sameModelRetried: state?.sameModelRetried ?? false,
    consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
  });
  return attempts;
}

export function getAttemptCount(sessionID: string): number {
  return states.get(sessionID)?.attempts ?? 0;
}

export function getLastFallbackModel(sessionID: string): string | undefined {
  return states.get(sessionID)?.model;
}

export function hasSameModelRetried(sessionID: string): boolean {
  return states.get(sessionID)?.sameModelRetried ?? false;
}

export function markSameModelRetried(sessionID: string): void {
  const state = states.get(sessionID);
  if (state) {
    state.sameModelRetried = true;
    return;
  }
  states.set(sessionID, {
    attempts: 0,
    lastAttemptAt: Date.now(),
    model: "",
    sameModelRetried: true,
    consecutiveFailures: 0,
  });
}

export function resetSameModelRetried(sessionID: string): void {
  const state = states.get(sessionID);
  if (state) state.sameModelRetried = false;
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
  return true;
}

export function clearRetryKeys(sessionID: string): void {
  retryKeys.delete(sessionID);
}

export function clearAll(): void {
  states.clear();
  retryKeys.clear();
}
