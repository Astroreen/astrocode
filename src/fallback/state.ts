// In-memory per-session fallback attempt tracking. Deliberately simple (the
// 80/20 of oh-my-openagent's multi-Map state machine, see docs/porting-plan.md
// "Fallback module design"): one entry per session, cleared on success/dispose.
// Process-local — a plugin restart forgets attempts, which is acceptable.

interface SessionAttemptState {
  attempts: number;
  lastAttemptAt: number;
  model: string;
}

const states = new Map<string, SessionAttemptState>();

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
  return elapsedSeconds < cooldownSeconds;
}

export function recordAttempt(
  sessionID: string,
  model: string,
  now: number = Date.now(),
): number {
  const state = states.get(sessionID);
  const attempts = state ? state.attempts + 1 : 1;
  states.set(sessionID, { attempts, lastAttemptAt: now, model });
  return attempts;
}

export function getAttemptCount(sessionID: string): number {
  return states.get(sessionID)?.attempts ?? 0;
}

export function getLastFallbackModel(sessionID: string): string | undefined {
  return states.get(sessionID)?.model;
}

export function resetAttempts(sessionID: string): void {
  states.delete(sessionID);
}

export function clearAll(): void {
  states.clear();
}