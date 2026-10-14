// Continuation re-arm glue (fallback-rotation pin re-arm).
//
// Interprets fallback decision outcomes against the compaction-continuation
// state: a rotation (retry:true) re-arms the pin while it awaits a clean
// answer; chain exhaustion stops it; every other outcome is a no-op. The
// fallback module itself stays generic — outcomes are interpreted HERE.
//
// Process-local like the state it touches: a plugin restart forgets it.

import { log } from "../log";
import { isChildSession } from "../fallback/subagent";
import {
  clearContinuationState,
  continuationUnacked,
  getCompactionState,
  rearmPendingContinuation,
} from "./state";

export interface ContinuationFallbackOutcome {
  retry: boolean;
  reason: string;
  model?: string;
}

/**
 * A fallback decision retires or re-arms the compaction-continuation pin.
 * Rotation (retry:true) re-arms it while unacked; chain exhaustion stops it;
 * every other outcome is a no-op. Child sessions never re-arm (10a3180).
 */
export function applyFallbackOutcomeToContinuation(
  sessionID: string,
  decision: ContinuationFallbackOutcome,
): void {
  if (isChildSession(sessionID)) return;
  if (decision.retry) {
    // Covers both rotation reasons: "retry" and "resubmit-failed" (the
    // resubmit never reached the model, so the pin must reach it).
    if (rearmPendingContinuation(sessionID)) {
      log.info(
        `continuation-rearm: re-armed (fallback-rotation${decision.model ? ` -> ${decision.model}` : ""})`,
      );
    } else {
      log.debug("continuation-rearm: rotation without unacked pin; no re-arm");
    }
    return;
  }
  if (decision.reason === "chain-exhausted" || decision.reason === "no-fallback-models") {
    if (
      continuationUnacked(sessionID) ||
      getCompactionState(sessionID)?.pending_continuation
    ) {
      clearContinuationState(sessionID);
      log.info(`continuation-rearm: stop (${decision.reason})`);
    }
  }
}

/** Any part with synthetic !== true counts as genuine user content. */
export function hasNonSyntheticUserContent(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (part) =>
      !!part &&
      typeof part === "object" &&
      (part as { synthetic?: unknown }).synthetic !== true,
  );
}
