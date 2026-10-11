// Deterministic stub pruning + summary-injection planning (plan T10.1/T10.3).
//
// PURE layer: no I/O, no module state, no clock. The stateful orchestrator
// that feeds session state in and persists results out lives in
// src/compaction/transform.ts; everything here is a pure function over the
// message array so prune(prune(x)) === prune(x) is unit-testable.
//
// Cache-epoch doctrine (Planner Decisions #4): between compactions the bytes
// of already-sent history are immutable. The transform view is rebuilt from
// storage on every request, so immutability in practice means determinism:
// re-applying a recorded stub yields byte-identical output, and NEW stubs are
// only allowed inside an epoch break (the epoch_dirty flag, set by the
// compaction run and consumed by the transform).
//
// Eligibility (plan wording: "старше 2 сообщений и вне последних 10 parts"):
// a tool-result part qualifies only when its message is older than the last
// PRUNE_TAIL_MESSAGES messages AND its global part index lies outside the
// last PRUNE_TAIL_PARTS parts of the whole array. Both gates are positional
// and monotone: once eligible, a part only gets older.

import { sha256Hex } from "../prompts/freeze";

/** Exact tail marker appended to every pruned tool output. */
export const PRUNE_MARKER = "[pruned by astrocode]";

/** Exact marker wrapping the injected synthetic summary part. */
export const SUMMARY_MARKER = "<!-- astrocode:summary -->";

/** Synthetic message/part ids for the injected summary (constant, so the
 * injected bytes are identical on every request rebuild). */
export const SUMMARY_MESSAGE_ID = "astrocode-summary";
export const SUMMARY_PART_ID = "astrocode-summary-part";

/** Tail gates: the last 2 messages and the last 10 parts are never pruned. */
export const PRUNE_TAIL_MESSAGES = 2;
export const PRUNE_TAIL_PARTS = 10;

// ---------------------------------------------------------------------------
// Structural views (SDK Message/Part satisfy these; tests build minimal ones)
// ---------------------------------------------------------------------------

export interface PruneMessageInfo {
  id?: unknown;
  role?: unknown;
  sessionID?: unknown;
  /** Present on real SDK messages; the synthetic summary message fills it. */
  time?: unknown;
  agent?: unknown;
  model?: unknown;
}

export interface PruneMessage {
  info?: PruneMessageInfo;
  parts?: unknown[];
}

/** Minimal completed-tool-part view the prune is allowed to mutate. */
export interface CompletedToolPart {
  type: "tool";
  id: string;
  state: { status: "completed"; output: string };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Type-guard narrowing to the mutable tool-result shape; anything else
 * (user text, assistant text, pending/running/error tool states, garbage)
 * returns false and is never touched. */
export function isCompletedToolPart(part: unknown): part is CompletedToolPart {
  if (!isPlainObject(part) || part.type !== "tool") return false;
  if (typeof part.id !== "string" || part.id.length === 0) return false;
  if (!isPlainObject(part.state) || part.state.status !== "completed") return false;
  return typeof part.state.output === "string";
}

// ---------------------------------------------------------------------------
// Stub bytes
// ---------------------------------------------------------------------------

/** Exact stub bytes: `text.slice(0, prune_stub_chars) + "\n[pruned by astrocode]"`. */
export function pruneStub(text: string, pruneStubChars: number): string {
  const chars =
    Number.isFinite(pruneStubChars) && pruneStubChars > 0
      ? Math.floor(pruneStubChars)
      : 0;
  return `${text.slice(0, chars)}\n${PRUNE_MARKER}`;
}

/** Already-stubbed detection (idempotency): the marker terminates the text. */
export function isPruneStub(text: string): boolean {
  return text.endsWith(PRUNE_MARKER);
}

// ---------------------------------------------------------------------------
// Prune report
// ---------------------------------------------------------------------------

export interface StubApplication {
  part_id: string;
  stub_sha256: string;
}

export interface PruneReport {
  /** Every byte-level mutation applied this pass (fresh + maintenance). */
  applied: StubApplication[];
  /** First-time stubs — only ever non-empty inside an epoch break. */
  fresh: StubApplication[];
  /** Guard conflicts: covered parts whose bytes no longer match the recorded
   * stub hash. Left untouched; the orchestrator reports them once. */
  conflicts: string[];
}

/**
 * Apply the deterministic prune to the message array IN PLACE (the hook
 * contract is mutate-in-place) and report what happened.
 *
 * Per part, in order:
 *   1. non-tool-result / non-completed -> skip;
 *   2. already stubbed (marker)        -> skip (idempotency);
 *   3. covered by the hash guard and the would-be stub bytes still hash to
 *      the recorded value              -> re-apply (maintenance; byte-identical
 *      to what was already sent, so the provider-cacheable prefix is stable);
 *   4. covered but bytes differ        -> GUARD CONFLICT: hands off;
 *   5. uncovered                       -> new stub, only when `allowNewStubs`
 *      (epoch break) AND both eligibility gates pass.
 *
 * Maintenance (case 3) deliberately ignores the eligibility windows: a
 * covered part was eligible when stubbed and only ages further, and its stub
 * must persist in every later view or the model would lose it.
 */
export function pruneToolResults(
  messages: readonly PruneMessage[],
  pruneStubChars: number,
  allowNewStubs: boolean,
  guards: {
    hashes: ReadonlySet<string>;
    parts: ReadonlyMap<string, string>;
  },
): PruneReport {
  const report: PruneReport = { applied: [], fresh: [], conflicts: [] };
  if (!Array.isArray(messages) || messages.length === 0) return report;

  const messageCut = messages.length - PRUNE_TAIL_MESSAGES;
  let totalParts = 0;
  for (const message of messages) {
    if (Array.isArray(message?.parts)) totalParts += message.parts.length;
  }
  const partCut = totalParts - PRUNE_TAIL_PARTS;

  let globalIndex = 0;
  for (let m = 0; m < messages.length; m += 1) {
    const message = messages[m];
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const part of parts) {
      const index = globalIndex;
      globalIndex += 1;
      if (!isCompletedToolPart(part)) continue;
      const output = part.state.output;
      if (isPruneStub(output)) continue;
      const partId = part.id;
      const stub = pruneStub(output, pruneStubChars);
      const stubHash = sha256Hex(stub);
      const covered =
        guards.parts.has(partId) || guards.hashes.has(stubHash);
      if (covered) {
        if (guards.hashes.has(stubHash)) {
          part.state.output = stub;
          report.applied.push({ part_id: partId, stub_sha256: stubHash });
        } else {
          report.conflicts.push(partId);
        }
        continue;
      }
      if (!allowNewStubs) continue;
      if (m >= messageCut) continue;
      if (index >= partCut) continue;
      part.state.output = stub;
      report.applied.push({ part_id: partId, stub_sha256: stubHash });
      report.fresh.push({ part_id: partId, stub_sha256: stubHash });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Summary injection planning (T10.3)
// ---------------------------------------------------------------------------

/** Exact bytes of the injected synthetic summary part text. */
export function summaryPartText(summary: string): string {
  return `${SUMMARY_MARKER}\n${summary}`;
}

/**
 * Anchor id for the summary injection: the first message of the tail window
 * (index `length - PRUNE_TAIL_MESSAGES`, clamped to 0). Injecting before it
 * places the summary after the pruned region and before the recent tail; the
 * id (not the index) is the stable anchor, because messages only append.
 */
export function summaryAnchorId(
  messages: readonly PruneMessage[],
): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const index = Math.max(0, messages.length - PRUNE_TAIL_MESSAGES);
  const id = messages[index]?.info?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** First index of a message whose info.id matches; -1 when absent. */
export function findMessageIndexById(
  messages: readonly PruneMessage[],
  id: string,
): number {
  if (!Array.isArray(messages)) return -1;
  for (let i = 0; i < messages.length; i += 1) {
    const messageId = messages[i]?.info?.id;
    if (typeof messageId === "string" && messageId === id) return i;
  }
  return -1;
}
