// Summary format validation (plan T11.1).
//
// PURE layer: no I/O, no clock, no module state — a plain function over the
// summary text so the rules are unit-testable in isolation and reusable by
// both the T11 retry flow (src/compaction/summarize.ts) and the T12 compacting
// prompt (the section-header constants below are the single shared source for
// the `## Goal / ## State / ## Next` template shape).
//
// Rules (checked in order, first failure wins — the reason names the rule):
//   1. empty/whitespace            -> "empty"
//   2. length < SUMMARY_MIN_CHARS  -> "too-short"
//   3. length > SUMMARY_MAX_CHARS  -> "too-long"
//   4. any of the three section headers missing -> "missing-section:<header>"
//   5. a fenced markdown block that looks like an error dump / stack trace
//      and exceeds STACK_TRACE_BLOCK_MAX_CHARS -> "error-block"
//
// Header rule: a header counts only at LINE START (markdown semantics) with a
// word boundary after it — "## Goal" matches, "## Goals" and a mid-sentence
// "## Goal" mention do not. This keeps prose references from faking a section.
//
// Error-block heuristic (deliberately simple, documented here): split the text
// on the ``` fence marker; odd segments are fenced block bodies (an unclosed
// final fence makes the tail a block too). A block is an error dump when its
// body contains the literal "Error:" (covers TypeError:, ReferenceError:, ...)
// or any stack-frame line (`^\s*at\s+\S`, the V8 frame shape). Only blocks
// LARGER than STACK_TRACE_BLOCK_MAX_CHARS are rejected — a short fenced error
// snippet inside an otherwise valid summary is fine; the rule exists to stop a
// summarizer from dumping a whole crash log as the "summary".

/** Minimum accepted summary length in characters (plan T11.1). */
export const SUMMARY_MIN_CHARS = 200;
/** Maximum accepted summary length in characters (plan T11.1). */
export const SUMMARY_MAX_CHARS = 4000;

/** The three required section headers — the stable summary template shape.
 * Shared by the T11 validator, the T9/T11 summarizer prompt and the T12
 * compacting prompt; keep them in this one place. */
export const SUMMARY_HEADER_GOAL = "## Goal";
export const SUMMARY_HEADER_STATE = "## State";
export const SUMMARY_HEADER_NEXT = "## Next";
export const SUMMARY_SECTION_HEADERS = [
  SUMMARY_HEADER_GOAL,
  SUMMARY_HEADER_STATE,
  SUMMARY_HEADER_NEXT,
] as const;

/** A fenced block larger than this, if it looks like an error dump, is
 * rejected (plan T11.1: "stack traces > 500 chars"). */
export const STACK_TRACE_BLOCK_MAX_CHARS = 500;

export interface SummaryValidation {
  valid: boolean;
  /** Stable rule token when invalid ("empty" | "too-short" | "too-long" |
   * "missing-section:<header>" | "error-block"); undefined when valid. */
  reason?: string;
}

const FENCE = "```";
const STACK_FRAME_LINE = /^\s*at\s+\S/;
const WORD_CHAR = /[A-Za-z0-9_]/;

function isPlainString(value: unknown): value is string {
  return typeof value === "string";
}

/** Line-start, word-bounded header match (see module doc). */
function hasSectionHeader(text: string, header: string): boolean {
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(header)) continue;
    // Word boundary: the char right after the header must not continue a
    // word ("" for an exact-line match is not a word char -> matches).
    const next = trimmed.charAt(header.length);
    if (!WORD_CHAR.test(next)) return true;
  }
  return false;
}

/** True when the fenced block body looks like an error dump / stack trace. */
function looksLikeErrorDump(block: string): boolean {
  if (block.includes("Error:")) return true;
  for (const line of block.split("\n")) {
    if (STACK_FRAME_LINE.test(line)) return true;
  }
  return false;
}

/** Fenced-block scan (see module doc for the segmentation rule). */
function hasOversizedErrorBlock(text: string): boolean {
  const segments = text.split(FENCE);
  // Odd indices are fence-enclosed bodies; the last odd segment also covers
  // an unclosed trailing fence.
  for (let i = 1; i < segments.length; i += 2) {
    const block = segments[i];
    if (!isPlainString(block)) continue;
    if (block.length <= STACK_TRACE_BLOCK_MAX_CHARS) continue;
    if (looksLikeErrorDump(block)) return true;
  }
  return false;
}

/**
 * Validate a summarizer reply against the stable summary format.
 * Pure: no I/O, no state, deterministic.
 */
export function validateSummary(text: string): SummaryValidation {
  if (!isPlainString(text) || text.trim().length === 0) {
    return { valid: false, reason: "empty" };
  }
  if (text.length < SUMMARY_MIN_CHARS) {
    return { valid: false, reason: "too-short" };
  }
  if (text.length > SUMMARY_MAX_CHARS) {
    return { valid: false, reason: "too-long" };
  }
  for (const header of SUMMARY_SECTION_HEADERS) {
    if (!hasSectionHeader(text, header)) {
      return { valid: false, reason: `missing-section:${header}` };
    }
  }
  if (hasOversizedErrorBlock(text)) {
    return { valid: false, reason: "error-block" };
  }
  return { valid: true };
}