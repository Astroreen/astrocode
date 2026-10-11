// Plan T11 tests: the summary format validation matrix (pure layer), the
// bounded retry counting (exactly one retry, hard 2-model-call guarantee),
// the deterministic fallback stub and the fallback end-to-end through
// maybeCompact (frozen + epoch armed so T10 prune/injection proceeds).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FALLBACK_SUMMARY_STUB,
  MAX_SUMMARY_RETRIES,
  RETRY_FORMAT_ADDENDUM,
  SUMMARY_PROMPT_TEMPLATE,
  summarize,
  type MessageEntry,
  type ProviderEntry,
  type SummarizerClient,
} from "../src/compaction/summarize";
import {
  STACK_TRACE_BLOCK_MAX_CHARS,
  SUMMARY_HEADER_GOAL,
  SUMMARY_HEADER_NEXT,
  SUMMARY_HEADER_STATE,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_CHARS,
  SUMMARY_SECTION_HEADERS,
  validateSummary,
} from "../src/compaction/format";
import { maybeCompact } from "../src/compaction/run";
import {
  compactionStateSnapshot,
  resetCompactionState,
} from "../src/compaction/state";
import {
  createTelemetryLogger,
  type TelemetryRecord,
} from "../src/telemetry/log";

afterEach(() => {
  resetCompactionState();
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astrocode-compaction-format-"));
}

function readRecords(dir: string): TelemetryRecord[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const lines: TelemetryRecord[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.length > 0) lines.push(JSON.parse(line) as TelemetryRecord);
    }
  }
  return lines;
}

// A reply that passes every validateSummary rule (>= 200 chars, all three
// section headers at line start, no oversized error blocks).
const VALID_SUMMARY =
  "## Goal\n" +
  "Ship the T11 bounded-retry flow: validate the summary format, retry once " +
  "with the corrective addendum, then fall back to the deterministic stub.\n" +
  "## State\n" +
  "The compaction engine triggered on a full context window; the summarizer " +
  "produced this three-section summary and the pruned tool outputs below " +
  "keep the fine detail.\n" +
  "## Next\n" +
  "Continue the session from the user request.";

/** A text with the three headers padded to exactly `chars` characters. */
function summaryOfLength(chars: number): string {
  const skeleton =
    "## Goal\nG.\n## State\nS.\n## Next\nN."; // 33 chars, headers present
  const filler = "x".repeat(Math.max(0, chars - skeleton.length));
  return skeleton + filler;
}

// ---------------------------------------------------------------------------
// Mock client: counts every model-touching call and captures the prompt text
// it received (to assert the corrective addendum placement).
// ---------------------------------------------------------------------------

interface FormatMockState {
  summarizeCalls: number;
  promptCalls: number;
  createCalls: number;
  messagesCalls: number;
  /** The prompt text RECEIVED per prompt call (attempt order). */
  promptTexts: string[];
  deletedScratchIds: string[];
}

function formatMockClient(
  opts: {
    providers?: ProviderEntry[];
    summarizeResult?: () => { data?: boolean; error?: unknown };
    summarizeThrows?: boolean;
    /** Replies per prompt attempt; the last one repeats when exhausted. */
    promptReplies?: string[];
    /** When set, prompt calls return no text parts (empty/silent). */
    promptSilent?: boolean;
    promptThrows?: boolean;
  } = {},
): SummarizerClient & { state: FormatMockState } {
  const state: FormatMockState = {
    summarizeCalls: 0,
    promptCalls: 0,
    createCalls: 0,
    messagesCalls: 0,
    promptTexts: [],
    deletedScratchIds: [],
  };
  let scratchCounter = 0;
  return {
    state,
    session: {
      summarize: async () => {
        state.summarizeCalls += 1;
        if (opts.summarizeThrows) throw new Error("route down");
        return opts.summarizeResult ? opts.summarizeResult() : { data: true };
      },
      create: async () => {
        state.createCalls += 1;
        scratchCounter += 1;
        return { data: { id: `scratch-${scratchCounter}` } };
      },
      prompt: async (options) => {
        state.promptCalls += 1;
        const received = options.body.parts[0]?.text;
        state.promptTexts.push(typeof received === "string" ? received : "");
        if (opts.promptThrows) throw new Error("prompt failed");
        if (opts.promptSilent) return { data: { info: {}, parts: [] } };
        const replies = opts.promptReplies ?? [VALID_SUMMARY];
        const index = Math.min(state.promptCalls - 1, replies.length - 1);
        return {
          data: { info: {}, parts: [{ type: "text", text: replies[index] }] },
        };
      },
      messages: async () => {
        state.messagesCalls += 1;
        const entries: MessageEntry[] = [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "do the thing" }],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "done" }],
          },
        ];
        return { data: entries };
      },
      delete: async (options) => {
        state.deletedScratchIds.push(options.path.id);
        return { data: true };
      },
    },
    provider: {
      list: async () => ({ data: { all: opts.providers ?? [] } }),
    },
  };
}

function baseArgs(sessionID: string) {
  return {
    sessionID,
    ctx: { session_id: sessionID },
    source: "turn_boundary",
  };
}

// ---------------------------------------------------------------------------
// T11.1 — validateSummary matrix
// ---------------------------------------------------------------------------

describe("validateSummary rules", () => {
  test("constants: bounds, headers, stack-trace limit", () => {
    expect(SUMMARY_MIN_CHARS).toBe(200);
    expect(SUMMARY_MAX_CHARS).toBe(4000);
    expect(STACK_TRACE_BLOCK_MAX_CHARS).toBe(500);
    expect(SUMMARY_HEADER_GOAL).toBe("## Goal");
    expect(SUMMARY_HEADER_STATE).toBe("## State");
    expect(SUMMARY_HEADER_NEXT).toBe("## Next");
    expect(SUMMARY_SECTION_HEADERS).toEqual(["## Goal", "## State", "## Next"]);
  });

  test("valid three-section summary passes", () => {
    expect(validateSummary(VALID_SUMMARY)).toEqual({ valid: true });
  });

  test("length bounds: exactly 200 and 4000 valid; 199 and 4001 invalid", () => {
    expect(validateSummary(summaryOfLength(200))).toEqual({ valid: true });
    expect(validateSummary(summaryOfLength(4000))).toEqual({ valid: true });
    expect(validateSummary(summaryOfLength(199))).toEqual({
      valid: false,
      reason: "too-short",
    });
    expect(validateSummary(summaryOfLength(4001))).toEqual({
      valid: false,
      reason: "too-long",
    });
  });

  test("empty/whitespace -> empty", () => {
    expect(validateSummary("")).toEqual({ valid: false, reason: "empty" });
    expect(validateSummary("   \n\t ")).toEqual({ valid: false, reason: "empty" });
  });

  test("each missing section is named in the reason", () => {
    const noGoal = VALID_SUMMARY.replace("## Goal\n", "Preamble\n");
    expect(validateSummary(noGoal)).toEqual({
      valid: false,
      reason: "missing-section:## Goal",
    });
    const noState = VALID_SUMMARY.replace("## State\n", "Status\n");
    expect(validateSummary(noState)).toEqual({
      valid: false,
      reason: "missing-section:## State",
    });
    const noNext = VALID_SUMMARY.replace("## Next\n", "Afterwards\n");
    expect(validateSummary(noNext)).toEqual({
      valid: false,
      reason: "missing-section:## Next",
    });
  });

  test("header must be at line start with a word boundary", () => {
    // Mid-line mention does not count as a section header.
    const midLine =
      "## Goal\n" +
      "work plan mentions ## State and ## Next inline without headers, plus " +
      "enough filler prose to push the total length beyond the two hundred " +
      "character minimum required by the validator rules.\n".repeat(2);
    expect(validateSummary(midLine).reason).toBe("missing-section:## State");
    // "## Goals" does not satisfy "## Goal" (word boundary).
    const plural =
      "## Goals\n" +
      "## State\n" +
      "## Next\n" +
      "filler prose to push the total length beyond the two hundred character ".repeat(4);
    expect(validateSummary(plural).reason).toBe("missing-section:## Goal");
    // Indented header (up to markdown's 3 spaces) still counts.
    const indented =
      "## Goal\n  ## State\n\t## Next\n" +
      "filler prose to push the total length beyond the two hundred character ".repeat(4);
    expect(validateSummary(indented)).toEqual({ valid: true });
  });

  test("oversized fenced error dump -> error-block", () => {
    const dump = "Error: something failed\n" + "x".repeat(600);
    const text =
      "## Goal\n" +
      "handle the failure\n" +
      "## State\n" +
      "```\n" + dump + "\n```\n" +
      "## Next\n" +
      "retry later with a fresh request and a clean state";
    expect(validateSummary(text)).toEqual({ valid: false, reason: "error-block" });
  });

  test("oversized fenced stack trace (at-lines, no Error:) -> error-block", () => {
    const frames = Array.from(
      { length: 30 },
      (_, i) => `    at fn${i} (/app/src/module${i}.ts:1:2)`,
    ).join("\n");
    expect(frames.length).toBeGreaterThan(STACK_TRACE_BLOCK_MAX_CHARS);
    const text =
      "## Goal\n" +
      "handle the failure\n" +
      "## State\n" +
      "```\n" + frames + "\n```\n" +
      "## Next\n" +
      "retry later with a fresh request and a clean state";
    expect(validateSummary(text)).toEqual({ valid: false, reason: "error-block" });
  });

  test("short fenced error snippet is allowed; big plain code block is allowed", () => {
    const shortDump = "```\nError: small\n```\n";
    const shortText =
      "## Goal\n" +
      "handle the failure and report it without dumping the whole crash log " +
      "into the summary block, keeping the context small for the next turn\n" +
      "## State\n" + shortDump +
      "## Next\n" +
      "retry later with a fresh request and a clean state, then verify";
    expect(validateSummary(shortText)).toEqual({ valid: true });

    const bigCode = "```\n" + "value".repeat(120) + "\n```";
    expect(bigCode.length).toBeGreaterThan(STACK_TRACE_BLOCK_MAX_CHARS);
    const bigCodeText =
      "## Goal\n" +
      "handle the failure\n" +
      "## State\n" + bigCode + "\n" +
      "## Next\n" +
      "retry later with a fresh request and a clean state";
    expect(validateSummary(bigCodeText)).toEqual({ valid: true });
  });

  test("unclosed fence with oversized error content -> error-block", () => {
    const text =
      "## Goal\n" +
      "handle the failure\n" +
      "## State\n" +
      "```\nError: boom\n" + "x".repeat(600) + "\n" +
      "## Next\n" +
      "retry later with a fresh request and a clean state";
    expect(validateSummary(text)).toEqual({ valid: false, reason: "error-block" });
  });
});

// ---------------------------------------------------------------------------
// T11.2 — bounded retry counting (scratch path: prompt calls = model calls)
// ---------------------------------------------------------------------------

describe("bounded retry: scratch path", () => {
  test("doctrine constants", () => {
    expect(MAX_SUMMARY_RETRIES).toBe(1);
    expect(RETRY_FORMAT_ADDENDUM).toBe(
      "The previous response violated the required format. Output exactly the " +
        "three markdown sections ## Goal / ## State / ## Next, 200-4000 chars.",
    );
    expect(FALLBACK_SUMMARY_STUB).toBe(
      "## Goal\n(compacted without summary)\n## State\nsee pruned tool outputs\n## Next\ncontinue from user request",
    );
    // The stub keeps the doctrine shape (three sections) even though it is
    // deliberately below the length minimum (post-validation terminal text).
    for (const header of SUMMARY_SECTION_HEADERS) {
      expect(FALLBACK_SUMMARY_STUB).toContain(header);
    }
  });

  test("valid on attempt 1 -> exactly 1 model call, real text", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = formatMockClient({ promptReplies: [VALID_SUMMARY] });
      const outcome = await summarize(client, logger, baseArgs("fmt-valid"));
      logger.close();

      expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
      expect(client.state.promptCalls).toBe(1);
      expect(client.state.promptTexts[0]).toContain(SUMMARY_PROMPT_TEMPLATE);
      expect(client.state.promptTexts[0]).not.toContain(RETRY_FORMAT_ADDENDUM);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["scratch", "ok"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid -> invalid = exactly 2 calls, then fallback stub (no loop)", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const junk = "junk reply without any section headers, far too short";
      const client = formatMockClient({ promptReplies: [junk, junk] });
      const outcome = await summarize(client, logger, baseArgs("fmt-fallback"));
      logger.close();

      // Deterministic fallback stub, exact constant bytes.
      expect(outcome).toEqual({ text: FALLBACK_SUMMARY_STUB, path: "scratch" });
      // Hard guarantee: exactly 2 model calls, never a third.
      expect(client.state.promptCalls).toBe(2);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["scratch", "error"],
        ["scratch", "error"],
        ["scratch", "fallback"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid -> valid = exactly 2 calls, retry prompt carries the addendum", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const junk = "junk reply without any section headers, far too short";
      const client = formatMockClient({
        promptReplies: [junk, VALID_SUMMARY],
      });
      const outcome = await summarize(client, logger, baseArgs("fmt-retry"));
      logger.close();

      expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
      expect(client.state.promptCalls).toBe(2);
      expect(client.state.promptTexts[0]).not.toContain(RETRY_FORMAT_ADDENDUM);
      expect(client.state.promptTexts[1]).toContain(RETRY_FORMAT_ADDENDUM);
      // The retry keeps the transcript digest and appends the correction
      // AFTER it (the last thing the model reads).
      expect(client.state.promptTexts[1]).toContain(SUMMARY_PROMPT_TEMPLATE);
      expect(client.state.promptTexts[1].indexOf(RETRY_FORMAT_ADDENDUM)).toBeGreaterThan(
        client.state.promptTexts[1].indexOf("Transcript:"),
      );
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["scratch", "error"],
        ["scratch", "ok"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty/silent both times = exactly 2 calls, then fallback stub", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = formatMockClient({ promptSilent: true });
      const outcome = await summarize(client, logger, baseArgs("fmt-silent"));
      logger.close();

      expect(outcome).toEqual({ text: FALLBACK_SUMMARY_STUB, path: "scratch" });
      expect(client.state.promptCalls).toBe(2);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["scratch", "error"],
        ["scratch", "error"],
        ["scratch", "fallback"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("oversized error-dump reply also counts as invalid (validated, not just length)", async () => {
    const logger = createTelemetryLogger({ enabled: false });
    const dump = "```\nError: boom\n" + "x".repeat(600) + "\n```";
    const client = formatMockClient({ promptReplies: [dump, dump] });
    const outcome = await summarize(client, logger, baseArgs("fmt-dump"));
    expect(outcome).toEqual({ text: FALLBACK_SUMMARY_STUB, path: "scratch" });
    expect(client.state.promptCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T11.2 — hard per-compaction model-call budget (<= 2, INCLUDING the native
// route call): a native attempt consumes one call, so the scratch flow gets
// the remainder.
// ---------------------------------------------------------------------------

describe("hard call budget incl. native path", () => {
  const PROBED = [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }];

  test("native success = 1 model call, no scratch calls", async () => {
    const client = formatMockClient({ providers: PROBED });
    const outcome = await summarize(client, createTelemetryLogger({ enabled: false }), {
      ...baseArgs("fmt-native-ok"),
      summarizer_model: "openrouter/xiaomi/mimo-v2.6-pro",
    });
    expect(outcome).toEqual({ text: "", path: "native" });
    expect(client.state.summarizeCalls).toBe(1);
    expect(client.state.promptCalls).toBe(0);
  });

  test("native fail + invalid scratch = exactly 2 total calls, fallback stub", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const junk = "junk reply without any section headers, far too short";
      const client = formatMockClient({
        providers: PROBED,
        summarizeResult: () => ({ data: false }),
        promptReplies: [junk, junk],
      });
      const outcome = await summarize(client, logger, {
        ...baseArgs("fmt-native-fallback"),
        summarizer_model: "openrouter/xiaomi/mimo-v2.6-pro",
      });
      logger.close();

      expect(outcome).toEqual({ text: FALLBACK_SUMMARY_STUB, path: "scratch" });
      // Hard guarantee: 1 native + 1 scratch = 2, never 3.
      expect(client.state.summarizeCalls).toBe(1);
      expect(client.state.promptCalls).toBe(1);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["native", "error"],
        ["scratch", "error"],
        ["scratch", "fallback"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native fail + valid scratch = exactly 2 total calls, real text", async () => {
    const client = formatMockClient({
      providers: PROBED,
      summarizeResult: () => ({ data: false }),
      promptReplies: [VALID_SUMMARY],
    });
    const outcome = await summarize(client, createTelemetryLogger({ enabled: false }), {
      ...baseArgs("fmt-native-recover"),
      summarizer_model: "openrouter/xiaomi/mimo-v2.6-pro",
    });
    expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
    expect(client.state.summarizeCalls + client.state.promptCalls).toBe(2);
  });

  test("probe fail (no native call) -> scratch keeps the full 2-attempt budget", async () => {
    const junk = "junk reply without any section headers, far too short";
    const client = formatMockClient({
      providers: [{ id: "openrouter", models: {} }],
      promptReplies: [junk, junk],
    });
    const outcome = await summarize(client, createTelemetryLogger({ enabled: false }), {
      ...baseArgs("fmt-probe-fail"),
      summarizer_model: "openrouter/xiaomi/mimo-v2.6-pro",
    });
    expect(outcome).toEqual({ text: FALLBACK_SUMMARY_STUB, path: "scratch" });
    expect(client.state.summarizeCalls).toBe(0);
    expect(client.state.promptCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T11.2 — fallback end-to-end through maybeCompact: the stub is frozen and
// the epoch break armed, so T10's prune/injection proceeds.
// ---------------------------------------------------------------------------

describe("fallback through maybeCompact", () => {
  test("double failure -> stub frozen, epoch armed, fallback recorded", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const junk = "junk reply without any section headers, far too short";
      const client = formatMockClient({ promptReplies: [junk, junk] });
      const result = await maybeCompact(
        client,
        logger,
        {
          enabled: true,
          trigger_ratio: 0.8,
          context_window: 1000,
          context_windows: {},
          cooldown_seconds: 0,
        },
        "fmt-e2e",
        {
          model: "openrouter/xiaomi/mimo-v2.6-pro",
          input: 900,
          cache_read: 0,
          cache_write: 0,
        },
        "turn_boundary",
      );
      logger.close();

      expect(result.ran).toBe(true);
      expect(result.outcome?.text).toBe(FALLBACK_SUMMARY_STUB);
      const snapshot = compactionStateSnapshot("fmt-e2e");
      expect(snapshot.summary_frozen).toBe(FALLBACK_SUMMARY_STUB);
      expect(snapshot.epoch_dirty).toBe(true);
      expect(snapshot.in_flight).toBe(false);
      const records = readRecords(dir).filter((r) => r.kind === "compaction");
      expect(records.map((r) => r.event?.outcome)).toEqual([
        "error",
        "error",
        "fallback",
      ]);
      expect(records[2]?.event?.summarizer_model).toBe(
        "openrouter/xiaomi/mimo-v2.6-pro",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});