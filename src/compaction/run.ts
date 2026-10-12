// Compaction runner (plan T9 wiring glue).
//
// Bridges the pure trigger (shouldCompact) and the summarizer (summarize):
// evaluate the gates, set in_flight SYNCHRONOUSLY before the first await (so
// the turn-boundary and session.idle seams racing on the same turn cannot
// both run), dispatch the summarizer, store the frozen summary (scratch path
// only — native summaries are host-managed), stamp the cooldown, release the
// lock. Never throws: a failed attempt is stamped into the cooldown (anti-
// storm, doctrine: no unbounded retry loops) and logged.
//
// Purity note (cache-epoch rule): this runner does NOT touch session history.
// It produces telemetry + state only; injection/pruning is T10's job.

import { log } from "../log";
import { parseModelString } from "../models/model-id";
import {
  recordCompaction,
  type CompactionEvent,
  type EventContext,
  type TelemetryLogger,
} from "../telemetry/log";
import {
  consumeForceCompact,
  clearPendingContinuation,
  getCompactionState,
  isScratchSession,
  lastUsage,
  markCompactionComplete,
  rememberUsage,
  setEpochDirty,
  setInFlight,
  setPendingContinuation,
  setSummaryFrozen,
} from "./state";
import { isChildSession } from "../fallback/subagent";
import {
  summarize,
  type SummarizeOutcome,
  type SummarizerClient,
} from "./summarize";
import {
  shouldCompact,
  type CompactionTriggerConfig,
  type CompactionUsage,
} from "./trigger";

/** Why the engine evaluated: turn boundary, session idle or the manual
 * /astrocode:compact command (plan T12.2). */
export type CompactionSource = "turn_boundary" | "session_idle" | "manual";

export interface MaybeCompactResult {
  ran: boolean;
  reason: string;
  outcome?: SummarizeOutcome;
}

/** Telemetry context for a compaction record (session + model attribution). */
function contextFor(
  sessionID: string,
  usage: CompactionUsage | undefined,
): EventContext {
  const ctx: EventContext = { session_id: sessionID };
  const model = usage?.model
    ? parseModelString(usage.model)
    : undefined;
  if (model) {
    ctx.model = { provider_id: model.providerID, model_id: model.modelID };
  }
  return ctx;
}

/**
 * Evaluate the compaction gates for a session and, when they pass, run the
 * summarizer once. `usage` may be undefined (idle seam with no captured
 * usage yet, or a forced manual run) — the trigger reports "no-usage" and
 * nothing runs, unless a force-compact request is pending (plan T12.2: the
 * request is consumed here and bypasses the no-usage/cooldown/ratio gates).
 */
export async function maybeCompact(
  client: SummarizerClient,
  logger: TelemetryLogger,
  cfg: CompactionTriggerConfig & { summarizer_model?: string },
  sessionID: string,
  usage: CompactionUsage | undefined,
  source: CompactionSource,
  now: number = Date.now(),
): Promise<MaybeCompactResult> {
  // Scratch summarizer sessions must never be compacted (plan T9/T12): the
  // summarizer's own session would otherwise trip the trigger, which creates
  // another scratch session, which trips again — an unbounded compaction
  // chain that burns tokens. Guarded here (before the force request is
  // consumed) so every seam — turn boundary, session.idle and manual — is
  // covered by one check.
  if (isScratchSession(sessionID)) {
    return { ran: false, reason: "scratch-session" };
  }

  // Read-and-clear: a pending force request is honored by exactly one
  // evaluation. A lost race (in-flight engine) simply requires the user to
  // invoke /astrocode:compact again.
  const forced = consumeForceCompact(sessionID);
  const decision = shouldCompact(
    getCompactionState(sessionID),
    cfg,
    usage,
    now,
    forced,
  );
  if (!decision.compact) return { ran: false, reason: decision.reason };

  // One-time injection per region (plan T10.3): the region is already
  // compacted and its summary is frozen — do NOT regenerate it and do NOT
  // re-prune. Record the skip and stamp the cooldown (anti-storm) so the
  // frozen state does not produce a skip record on every single turn.
  if (getCompactionState(sessionID)?.summary_frozen) {
    recordCompaction(logger, contextFor(sessionID, usage), {
      outcome: "skipped",
      source,
    });
    markCompactionComplete(sessionID, now);
    return { ran: false, reason: "already-compacted" };
  }

  const ctx = contextFor(sessionID, usage);

  // Arm the post-compaction continuation BEFORE the summarizer await. A slow
  // summarizer (a scratch session on a slow model can run well past the idle
  // seam's bounded in-flight wait) would otherwise finish AFTER session.idle
  // already fired — the flag gets armed too late, no further idle arrives, and
  // the agent stops mid-task. Arming synchronously closes that race.
  //
  // Child (subagent) sessions never arm it: opencode's `task` tool owns the
  // child's lifecycle and has already returned the child's result by the time
  // the child goes idle, so any continuation we inject runs orphaned and
  // leaves the parent believing the subagent stopped after partial work. The
  // child's result IS the task boundary; the parent orchestrator decides what
  // happens next.
  const armContinuation = !isChildSession(sessionID);
  if (armContinuation) setPendingContinuation(sessionID);

  // Synchronous in_flight set before the first await — the double-seam guard.
  setInFlight(sessionID, true);
  try {
    const outcome = await summarize(client, logger, {
      sessionID,
      ...(cfg.summarizer_model ? { summarizer_model: cfg.summarizer_model } : {}),
      ctx,
      source,
      ...(decision.ratio !== undefined ? { ratio: decision.ratio } : {}),
      ...(usage
        ? {
            tokens_before:
              usage.input + usage.cache_read + usage.cache_write,
          }
        : {}),
    });
    // Scratch summaries are ours to inject later (T10); native ones are
    // host-managed — only the scratch text is frozen into state, and only a
    // scratch summary arms the cache-epoch break (T10.2): a native success
    // hands history ownership to opencode's own compaction flow, so our
    // transform stays pass-through for it.
    if (outcome.path === "scratch" && outcome.text) {
      setSummaryFrozen(sessionID, outcome.text);
      setEpochDirty(sessionID, true);
    }
    markCompactionComplete(sessionID, Date.now());
    log.info(
      `compaction: ${outcome.path} summarizer ran ` +
        `(ratio ${decision.ratio?.toFixed(2) ?? "?"}, ${source})`,
    );
    return { ran: true, reason: decision.reason, outcome };
  } catch (err) {
    // Both paths failed: stamp the cooldown anyway (anti-storm) and release
    // the flight lock so a later turn can retry after it elapses. Also disarm
    // the continuation armed above — a failed compaction must not nudge the
    // model.
    if (armContinuation) clearPendingContinuation(sessionID);
    markCompactionComplete(sessionID, Date.now());
    log.error("compaction: summarizer failed; session continues un-compacted", err);
    return { ran: false, reason: "summarizer-failed" };
  }
}

/** Turn-boundary seam: remember the usage snapshot, then evaluate. */
export function maybeCompactAtTurnBoundary(
  client: SummarizerClient,
  logger: TelemetryLogger,
  cfg: CompactionTriggerConfig & { summarizer_model?: string },
  sessionID: string,
  usage: CompactionUsage,
): Promise<MaybeCompactResult> {
  rememberUsage(sessionID, usage);
  return maybeCompact(client, logger, cfg, sessionID, usage, "turn_boundary");
}

/** session.idle seam: evaluate against the last remembered usage. */
export function maybeCompactAtIdle(
  client: SummarizerClient,
  logger: TelemetryLogger,
  cfg: CompactionTriggerConfig & { summarizer_model?: string },
  sessionID: string,
): Promise<MaybeCompactResult> {
  return maybeCompact(
    client,
    logger,
    cfg,
    sessionID,
    lastUsage(sessionID),
    "session_idle",
  );
}

// ---------------------------------------------------------------------------
// Native compaction event capture (plan T12.3)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Defensive extraction of a native `session.compacted` event (plan T12.3):
 * opencode's own compaction flow may fire without our engine ever running —
 * this is the additional telemetry signal for it. Returns undefined for
 * malformed shapes so callers skip without throwing. The record carries the
 * documented field set only (`source: "native_event"`); unknown keys would
 * be rejected by recordCompaction.
 */
export function nativeCompactionCapture(properties: unknown): {
  ctx: EventContext;
  event: CompactionEvent;
} | undefined {
  if (!isPlainObject(properties)) return undefined;
  const session_id = asNonEmptyString(properties.sessionID);
  if (!session_id) return undefined;
  return {
    ctx: { session_id },
    event: { source: "native_event" },
  };
}
