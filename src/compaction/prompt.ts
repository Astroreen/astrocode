// Compacting prompt (plan T12.1).
//
// The `experimental.session.compacting` hook replaces opencode's default
// compaction prompt with THIS constant. Hard requirements:
//
//   - BYTE-STABLE: no timestamps, counters, session ids or any other dynamic
//     content — the string is a module-level constant built only from other
//     constants, so every call hands the host the exact same bytes (tests
//     hash it; the compaction request stays provider-cache-friendly).
//   - SAME TEMPLATE SHAPE as the T11 summary validator
//     (src/compaction/format.ts): the three section headers
//     `## Goal / ## State / ## Next` and the 200-4000 chars guidance come
//     from the shared constants, so the native compaction flow is asked for
//     exactly the format our engine validates elsewhere.
//   - NO positional assumptions ("the conversation above/below"): the host
//     appends its own context/transcript around the prompt, so the wording
//     only refers to "the session".
//
// `out.context` decision (documented per plan): the hook passes the
// host-pre-filled `context` array through AS-IS — no mutation. The default
// prompt replacement is the only intervention; trimming/rewriting context is
// deferred until a probe proves it necessary (default = no mutation).

import {
  SUMMARY_HEADER_GOAL,
  SUMMARY_HEADER_NEXT,
  SUMMARY_HEADER_STATE,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_CHARS,
} from "./format";

/**
 * The constant compaction prompt handed to opencode's native compaction flow
 * via `experimental.session.compacting`. Byte-identical between calls.
 */
export const COMPACTING_PROMPT =
  "Summarize this coding session so the agent can continue the work with " +
  "earlier details compacted. Output EXACTLY three markdown sections, " +
  `${SUMMARY_MIN_CHARS}-${SUMMARY_MAX_CHARS} characters total, no other ` +
  "text:\n" +
  `${SUMMARY_HEADER_GOAL}\n` +
  `${SUMMARY_HEADER_STATE}\n` +
  `${SUMMARY_HEADER_NEXT}\n` +
  "- Goal: the user's objective and success criteria, verbatim where possible.\n" +
  "- State: what is done, what is in progress, key decisions and constraints.\n" +
  "- Next: the concrete next steps.\n" +
  "Keep exact file paths and identifiers; do not invent facts.";
