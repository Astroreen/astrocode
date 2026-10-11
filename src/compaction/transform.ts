// messages.transform orchestrator (plan T10 wiring glue).
//
// The stateful half of the transform seam: reads per-session compaction
// state, delegates the byte work to the pure prune layer (src/compaction/
// prune.ts), persists the results (region hashes, covered parts, summary
// anchor) and emits guard-conflict telemetry. Called from the plugin's
// `experimental.chat.messages.transform` hook on EVERY request build.
//
// Cache-epoch flow (T10.2):
//   1. The compaction run (maybeCompact) succeeds on the scratch path and
//      arms `epoch_dirty` for the session.
//   2. The NEXT transform consumes the flag: NEW stubs are applied to every
//      eligible tool result and the frozen summary is injected before the
//      tail anchor. This is THE epoch break — the one allowed mutation.
//   3. Every later transform is maintenance-only: covered parts are re-stubbed
//      with their exact recorded bytes (deterministic, so the rebuilt view is
//      byte-identical to the previously sent one) and the summary is re-injected
//      at the same anchor. No new bytes are ever touched.
//
// Pass-through guarantee: with compaction disabled, an unknown session, or no
// compaction state, the function returns without touching a single byte.

import { log } from "../log";
import { sha256Hex } from "../prompts/freeze";
import { dumpPrompt } from "../prompts/dump";
import { recordCompaction, type TelemetryLogger } from "../telemetry/log";
import type { CompactionConfig } from "../config/astrocode";
import {
  addRegionHash,
  clearSummaryFreeze,
  consumeEpochDirty,
  getCompactionState,
  markGuardConflictReported,
  markStubbedPart,
  setSummaryAnchor,
  setSummarySha256,
} from "./state";
import {
  findMessageIndexById,
  isCompletedToolPart,
  pruneToolResults,
  SUMMARY_MARKER,
  SUMMARY_MESSAGE_ID,
  SUMMARY_PART_ID,
  summaryAnchorId,
  summaryPartText,
  type PruneMessage,
} from "./prune";

export interface CompactionTransformOptions {
  /** Only `enabled` and `prune_stub_chars` are read. */
  cfg: Pick<CompactionConfig, "enabled" | "prune_stub_chars">;
  telemetry: TelemetryLogger;
  /** Test override; otherwise derived from the first message's info.sessionID. */
  sessionID?: string;
}

/** Derive the session id from the message array (the hook input carries none). */
function deriveSessionID(messages: readonly PruneMessage[]): string | undefined {
  for (const message of messages) {
    const sessionID = message?.info?.sessionID;
    if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
  }
  return undefined;
}

/**
 * The synthetic user message carrying the frozen summary. All fields are
 * constants (or the session id), so the injected bytes are identical on every
 * request rebuild — the provider-cacheable prefix never shifts.
 */
function syntheticSummaryMessage(sessionID: string, summary: string): PruneMessage {
  return {
    info: {
      id: SUMMARY_MESSAGE_ID,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "astrocode",
      model: { providerID: "", modelID: "" },
    },
    parts: [
      {
        id: SUMMARY_PART_ID,
        sessionID,
        messageID: SUMMARY_MESSAGE_ID,
        type: "text",
        text: summaryPartText(summary),
        synthetic: true,
      },
    ],
  };
}

type InjectionResult = "injected" | "present" | "missing";

function injectSummary(
  messages: PruneMessage[],
  sessionID: string,
  summary: string,
  anchorId: string,
): InjectionResult {
  if (findMessageIndexById(messages, SUMMARY_MESSAGE_ID) >= 0) return "present";
  const anchorIndex = findMessageIndexById(messages, anchorId);
  if (anchorIndex < 0) return "missing";
  messages.splice(anchorIndex, 0, syntheticSummaryMessage(sessionID, summary));
  return "injected";
}

// Debug side-channel (same discipline as src/prompts/dump.ts): per-part
// sha256 digests so a QA harness can prove byte-stability across passes
// without dumping full transcript text.
interface TextPartView {
  type: "text";
  id?: unknown;
  text?: unknown;
}

function isTextPart(part: unknown): part is TextPartView {
  return (
    !!part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part as Record<string, unknown>).type === "text"
  );
}

function partDigest(part: unknown): Record<string, unknown> {
  if (isCompletedToolPart(part)) {
    return {
      kind: "tool",
      id: part.id,
      sha256: sha256Hex(part.state.output),
      chars: part.state.output.length,
    };
  }
  if (isTextPart(part)) {
    const text = typeof part.text === "string" ? part.text : undefined;
    return {
      kind: "text",
      id: part.id,
      sha256: text !== undefined ? sha256Hex(text) : undefined,
      chars: text?.length,
      summary: text !== undefined && text.startsWith(SUMMARY_MARKER),
    };
  }
  return { kind: "other" };
}

function messagesDigest(messages: readonly PruneMessage[]): unknown {
  return messages.map((message) => ({
    id: typeof message?.info?.id === "string" ? message.info.id : undefined,
    role: typeof message?.info?.role === "string" ? message.info.role : undefined,
    parts: (Array.isArray(message?.parts) ? message.parts : []).map(partDigest),
  }));
}

/**
 * Apply the compaction transform to the request-built message array.
 * Never throws; every failure mode degrades to pass-through.
 */
export function applyCompactionTransform(
  messages: PruneMessage[],
  opts: CompactionTransformOptions,
): void {
  try {
    if (!opts.cfg.enabled) return;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const sessionID = opts.sessionID ?? deriveSessionID(messages);
    if (!sessionID) return;
    const state = getCompactionState(sessionID);
    // No compaction state -> nothing was ever frozen for this session ->
    // strict pass-through (zero byte mutation).
    if (!state) return;

    const epochBreak = consumeEpochDirty(sessionID);
    const guards = {
      hashes: new Set(state.region_hashes),
      parts: state.stubbed_parts,
    };
    const report = pruneToolResults(
      messages,
      opts.cfg.prune_stub_chars,
      epochBreak,
      guards,
    );

    for (const stub of report.fresh) {
      addRegionHash(sessionID, stub.stub_sha256);
      markStubbedPart(sessionID, stub.part_id, stub.stub_sha256);
    }

    for (const partId of report.conflicts) {
      // One telemetry record per conflicted part (deduped in state — the
      // part stays covered and untouched, so the conflict would otherwise
      // re-fire on every request rebuild).
      if (!markGuardConflictReported(sessionID, partId)) continue;
      // Field-resolution decision (T10.2): `outcome` stays inside the
      // documented enum ("ok" | "error" | "skipped" | "fallback") and the
      // free-form `source` field carries the conflict kind. recordCompaction
      // validates `source` as a plain non-empty string
      // (src/telemetry/log.ts isCompactionEvent), so no schema change was
      // needed; unknown-key rejection is untouched.
      recordCompaction(opts.telemetry, { session_id: sessionID }, {
        outcome: "error",
        source: "guard_conflict",
      });
      log.warn(
        `compaction: guard conflict on part ${partId}; region left untouched`,
      );
    }

    // Epoch break: freeze the injection anchor (first message of the tail
    // window at break time) and the exact injected-bytes hash.
    if (epochBreak && state.summary_frozen) {
      const anchor = summaryAnchorId(messages);
      if (anchor) {
        setSummaryAnchor(sessionID, anchor);
        setSummarySha256(
          sessionID,
          sha256Hex(summaryPartText(state.summary_frozen)),
        );
      }
    }

    // Summary maintenance: re-inject the frozen summary before its anchor on
    // every request (the view is rebuilt from storage each time). If the
    // anchor message is gone the history was restructured under us (e.g. a
    // native compaction) — drop the freeze so future compactions unblock.
    if (state.summary_frozen && state.summary_anchor_id) {
      const result = injectSummary(
        messages,
        sessionID,
        state.summary_frozen,
        state.summary_anchor_id,
      );
      if (result === "missing") {
        clearSummaryFreeze(sessionID);
        log.info(
          "compaction: summary anchor no longer in history; freeze dropped",
        );
      }
    }

    dumpPrompt({
      hook: "experimental.chat.messages.transform",
      sessionID,
      epoch_break: epochBreak,
      applied: report.applied.length,
      fresh: report.fresh.length,
      conflicts: report.conflicts.length,
      messages: messagesDigest(messages),
    });
  } catch (err) {
    log.error("compaction transform threw; no-op", err);
  }
}
