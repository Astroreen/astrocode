// Per-session compaction state (plan T9.2).
//
// One entry per session: when the last compaction completed, which regions
// were already pruned/frozen (T10 hash-guard seam), the frozen summary text
// (T10/T11 injection seam) and whether an attempt is currently running.
//
// Process-local like the fallback/budget state: a plugin restart forgets it,
// which is acceptable (worst case: one extra compaction after a restart).
//
// Bounded like src/telemetry/budget.ts: the map is wholesale-cleared once it
// reaches the hard cap, so a long-lived host process cannot grow it forever.
// The per-session region_hashes list is bounded too (oldest dropped).

import type { CompactionUsage } from "./trigger";

export interface CompactionSessionState {
  /** ms timestamp of the last compaction attempt completion; undefined = never. */
  last_compaction_ts?: number;
  /** sha256 hashes of already-pruned/frozen regions (T10 hash-guard seam). */
  region_hashes: string[];
  /** Frozen summary text (T10 injection seam); undefined = none yet. */
  summary_frozen?: string;
  /** sha256 of the exact injected summary bytes (T10.3 freeze proof). */
  summary_sha256?: string;
  /** Inject the summary before the message with this id (T10.3 stable anchor). */
  summary_anchor_id?: string;
  /**
   * Cache-epoch break armed (T10.2): set by the compaction run when a scratch
   * summary was produced, consumed (read + cleared) by the NEXT
   * messages.transform, which is then allowed to stub NEW regions and inject
   * the summary. Outside an epoch break the transform only maintains
   * already-recorded stubs — never mutates new bytes.
   */
  epoch_dirty: boolean;
  /** A compaction attempt is currently running for this session. */
  in_flight: boolean;
  /**
   * Force-compact request (plan T12.2): set by the chat.message seam when the
   * /astrocode:compact marker is detected; consumed (read + cleared) by the
   * next engine evaluation, which then ignores BOTH the ratio and the
   * cooldown (force semantics). The frozen-summary skip still applies — a
   * forced re-compact of an already-compacted region stays a no-op.
   */
  force_compact: boolean;
  /**
   * Post-compaction continuation pending: set by the engine when a compaction
   * succeeds, consumed (read + cleared) by the session.idle seam, which then
   * injects a synthetic continuation prompt so the agent resumes the task
   * instead of stopping after its context was compacted. Only acted on when
   * `compaction.continue_after` is enabled.
   */
  pending_continuation: boolean;
  /** Covered parts: partID -> sha256 of the stub bytes sent for it (T10.2). */
  stubbed_parts: Map<string, string>;
  /** Guard conflicts already reported to telemetry (dedup, one per part). */
  guard_conflicts_reported: Set<string>;
}

export const COMPACTION_STATE_LIMIT = 4096;
export const REGION_HASH_LIMIT = 1024;

const states = new Map<string, CompactionSessionState>();

// Wholesale clear at the cap (budget.ts pattern): simple, bounded, and the
// lost cooldowns only ever cause one extra compaction per affected session.
function evictStates(): void {
  if (states.size >= COMPACTION_STATE_LIMIT) states.clear();
}

/** Read-only view; undefined when the session has no compaction state yet. */
export function getCompactionState(
  sessionID: string,
): CompactionSessionState | undefined {
  return states.get(sessionID);
}

/** Create-or-get. Bounded via the wholesale clear above. */
export function ensureCompactionState(sessionID: string): CompactionSessionState {
  let state = states.get(sessionID);
  if (!state) {
    evictStates();
    state = {
      region_hashes: [],
      in_flight: false,
      force_compact: false,
      pending_continuation: false,
      epoch_dirty: false,
      stubbed_parts: new Map(),
      guard_conflicts_reported: new Set(),
    };
    states.set(sessionID, state);
  }
  return state;
}

/**
 * Record a finished compaction attempt. The timestamp is set on EVERY attempt
 * completion — success or failure — so a failing summarizer cannot storm
 * retries (doctrine: no unbounded retry loops); it just cools down like a
 * successful one.
 */
export function markCompactionComplete(sessionID: string, ts: number): void {
  const state = ensureCompactionState(sessionID);
  state.last_compaction_ts = ts;
  state.in_flight = false;
}

export function setInFlight(sessionID: string, value: boolean): void {
  const state = ensureCompactionState(sessionID);
  state.in_flight = value;
}

/** Arm (or disarm) the force-compact request (plan T12.2). */
export function setForceCompact(sessionID: string, value: boolean): void {
  const state = ensureCompactionState(sessionID);
  state.force_compact = value;
}

/**
 * Consume the force-compact request: returns the previous value and clears
 * the flag (read-and-clear, like consumeEpochDirty). A request is honored
 * exactly once; a lost race (in-flight engine) simply requires the user to
 * invoke the command again.
 */
export function consumeForceCompact(sessionID: string): boolean {
  const state = states.get(sessionID);
  if (!state || !state.force_compact) return false;
  state.force_compact = false;
  return true;
}

/** Arm the post-compaction continuation (set on a successful compaction). */
export function setPendingContinuation(sessionID: string): void {
  const state = ensureCompactionState(sessionID);
  state.pending_continuation = true;
}

/**
 * Consume the post-compaction continuation flag (read-and-clear, like
 * consumeForceCompact): the idle seam continues the agent exactly once per
 * successful compaction.
 */
export function consumePendingContinuation(sessionID: string): boolean {
  const state = states.get(sessionID);
  if (!state || !state.pending_continuation) return false;
  state.pending_continuation = false;
  return true;
}

/** Register a pruned/frozen region hash; oldest dropped at the cap. */
export function addRegionHash(sessionID: string, hash: string): void {
  if (!hash) return;
  const state = ensureCompactionState(sessionID);
  state.region_hashes.push(hash);
  if (state.region_hashes.length > REGION_HASH_LIMIT) {
    state.region_hashes.splice(0, state.region_hashes.length - REGION_HASH_LIMIT);
  }
}

export function hasRegionHash(sessionID: string, hash: string): boolean {
  return states.get(sessionID)?.region_hashes.includes(hash) ?? false;
}

/** Store the frozen summary text (T10 injection seam). */
export function setSummaryFrozen(sessionID: string, text: string): void {
  if (!text) return;
  const state = ensureCompactionState(sessionID);
  state.summary_frozen = text;
}

/** Store the sha256 of the exact injected summary bytes (T10.3). */
export function setSummarySha256(sessionID: string, hash: string): void {
  if (!hash) return;
  const state = ensureCompactionState(sessionID);
  state.summary_sha256 = hash;
}

/** Store the injection anchor message id (T10.3). */
export function setSummaryAnchor(sessionID: string, anchorId: string): void {
  if (!anchorId) return;
  const state = ensureCompactionState(sessionID);
  state.summary_anchor_id = anchorId;
}

/**
 * Drop the frozen summary (text + hash + anchor). Used when the anchored
 * message is no longer in the history (the host restructured it, e.g. a
 * native compaction) — the summary can no longer be placed, so keeping the
 * freeze would block all future compactions for the session.
 */
export function clearSummaryFreeze(sessionID: string): void {
  const state = states.get(sessionID);
  if (!state) return;
  state.summary_frozen = undefined;
  state.summary_sha256 = undefined;
  state.summary_anchor_id = undefined;
}

/** Arm (or disarm) the cache-epoch break consumed by the transform (T10.2). */
export function setEpochDirty(sessionID: string, value: boolean): void {
  const state = ensureCompactionState(sessionID);
  state.epoch_dirty = value;
}

/** Consume the epoch break: returns the previous value and clears the flag. */
export function consumeEpochDirty(sessionID: string): boolean {
  const state = states.get(sessionID);
  if (!state || !state.epoch_dirty) return false;
  state.epoch_dirty = false;
  return true;
}

/** Register a covered part (partID -> stub hash); oldest dropped at the cap. */
export function markStubbedPart(
  sessionID: string,
  partID: string,
  stubHash: string,
): void {
  if (!partID || !stubHash) return;
  const state = ensureCompactionState(sessionID);
  state.stubbed_parts.delete(partID);
  state.stubbed_parts.set(partID, stubHash);
  if (state.stubbed_parts.size > REGION_HASH_LIMIT) {
    const oldest = state.stubbed_parts.keys().next();
    if (!oldest.done) state.stubbed_parts.delete(oldest.value);
  }
}

/** Recorded stub hash for a covered part; undefined = not covered. */
export function stubbedPartHash(
  sessionID: string,
  partID: string,
): string | undefined {
  return states.get(sessionID)?.stubbed_parts.get(partID);
}

/**
 * Report a guard conflict for a part. Returns true the FIRST time (the caller
 * emits one telemetry record), false on repeats (dedup — a conflicted part
 * stays covered and untouched, so the conflict would otherwise re-fire on
 * every request rebuild). Bounded like the other per-session sets.
 */
export function markGuardConflictReported(
  sessionID: string,
  partID: string,
): boolean {
  if (!partID) return false;
  const state = ensureCompactionState(sessionID);
  if (state.guard_conflicts_reported.has(partID)) return false;
  state.guard_conflicts_reported.add(partID);
  if (state.guard_conflicts_reported.size > REGION_HASH_LIMIT) {
    const oldest = state.guard_conflicts_reported.values().next();
    if (!oldest.done) state.guard_conflicts_reported.delete(oldest.value);
  }
  return true;
}

/** Test/observability snapshot of one session's state. */
export function compactionStateSnapshot(sessionID: string): {
  last_compaction_ts?: number;
  region_hashes: string[];
  summary_frozen?: string;
  summary_sha256?: string;
  summary_anchor_id?: string;
  epoch_dirty: boolean;
  in_flight: boolean;
  force_compact: boolean;
  stubbed_parts: Record<string, string>;
  guard_conflicts_reported: string[];
} {
  const state = states.get(sessionID);
  return {
    last_compaction_ts: state?.last_compaction_ts,
    region_hashes: state ? [...state.region_hashes] : [],
    summary_frozen: state?.summary_frozen,
    summary_sha256: state?.summary_sha256,
    summary_anchor_id: state?.summary_anchor_id,
    epoch_dirty: state?.epoch_dirty ?? false,
    in_flight: state?.in_flight ?? false,
    force_compact: state?.force_compact ?? false,
    stubbed_parts: state ? Object.fromEntries(state.stubbed_parts) : {},
    guard_conflicts_reported: state ? [...state.guard_conflicts_reported] : [],
  };
}

/** Full reset. Tests and dispose. */
export function resetCompactionState(): void {
  states.clear();
  lastUsages.clear();
  scratchSessions.clear();
}

// ---------------------------------------------------------------------------
// Scratch-session registry (QA-found recursion guard)
// ---------------------------------------------------------------------------

// The scratch summarizer sessions are full opencode sessions: their own
// system prompt + tool schema bill ~12k tokens, so with a small configured
// context window the scratch session's own turn boundary trips the trigger
// and the engine compacts the compactor (recursion). Sessions created by
// summarize() are registered here and every trigger seam skips them.
// Bounded like the states map above.
const SCRATCH_SESSION_LIMIT = COMPACTION_STATE_LIMIT;
const scratchSessions = new Set<string>();

/** Register a scratch summarizer session so the trigger seams skip it. */
export function markScratchSession(sessionID: string): void {
  if (!sessionID) return;
  if (scratchSessions.size >= SCRATCH_SESSION_LIMIT) scratchSessions.clear();
  scratchSessions.add(sessionID);
}

/** True when the session was created by the scratch summarizer. */
export function isScratchSession(sessionID: string): boolean {
  return scratchSessions.has(sessionID);
}

// ---------------------------------------------------------------------------
// Last-usage memory (session.idle trigger seam)
// ---------------------------------------------------------------------------

// The turn-boundary seam sees usage directly (from the T1 capture), but the
// `session.idle` seam does not — it reads the last snapshot remembered here.
// Bounded like the states map above.
const lastUsages = new Map<string, CompactionUsage>();

/** Remember the billable-context snapshot of the last finished assistant message. */
export function rememberUsage(sessionID: string, usage: CompactionUsage): void {
  if (!sessionID) return;
  if (lastUsages.size >= COMPACTION_STATE_LIMIT) lastUsages.clear();
  lastUsages.set(sessionID, usage);
}

/** Last remembered usage snapshot for a session; undefined = none. */
export function lastUsage(sessionID: string): CompactionUsage | undefined {
  return lastUsages.get(sessionID);
}
