// Plan T9 tests: compaction config parsing, per-session state, the pure
// trigger, the summarizer paths (mock client) and the runner glue.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COMPACTION_CONTEXT_WINDOW_DEFAULT,
  COMPACTION_COOLDOWN_SECONDS_DEFAULT,
  COMPACTION_PRUNE_STUB_CHARS_DEFAULT,
  COMPACTION_TRIGGER_RATIO_DEFAULT,
  loadAstrocodeConfig,
} from "../src/config/astrocode";
import {
  addRegionHash,
  compactionStateSnapshot,
  consumePendingContinuation,
  ensureCompactionState,
  getCompactionState,
  hasRegionHash,
  lastUsage,
  markCompactionComplete,
  markScratchSession,
  rememberUsage,
  resetCompactionState,
  setInFlight,
  setSummaryFrozen,
  COMPACTION_STATE_LIMIT,
  REGION_HASH_LIMIT,
} from "../src/compaction/state";
import {
  contextWindowForModel,
  shouldCompact,
  type CompactionUsage,
} from "../src/compaction/trigger";
import {
  CompactionSummarizeError,
  SCRATCH_SUMMARIZER_MODEL,
  SUMMARIZER_PATH,
  SUMMARY_PROMPT_TEMPLATE,
  summarize,
  transcriptDigest,
  type MessageEntry,
  type ProviderEntry,
  type SummarizerClient,
} from "../src/compaction/summarize";
import { maybeCompact } from "../src/compaction/run";
import { clearChildSessions, registerChildSession } from "../src/fallback/subagent";
import { createTelemetryLogger, type TelemetryRecord } from "../src/telemetry/log";

afterEach(() => {
  resetCompactionState();
  clearChildSessions();
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astrocode-compaction-"));
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

const FULL_MODEL = "openrouter/xiaomi/mimo-v2.6-pro";

// A reply that passes the T11 validateSummary gate (>= 200 chars, all three
// section headers, no error blocks) — used wherever a test needs the scratch
// summarizer to SUCCEED on attempt 1.
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

function usage(partial: Partial<CompactionUsage> = {}): CompactionUsage {
  return {
    model: FULL_MODEL,
    input: 0,
    cache_read: 0,
    cache_write: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Mock client (structural — no casts; SummarizerClient is the seam)
// ---------------------------------------------------------------------------

interface MockState {
  summarizeCalls: number;
  createCalls: number;
  promptCalls: number;
  messagesCalls: number;
  providerListCalls: number;
  deletedScratchIds: string[];
}

function mockClient(
  opts: {
    providers?: ProviderEntry[];
    providerListThrows?: boolean;
    summarizeResult?: () => { data?: boolean; error?: unknown };
    summarizeThrows?: boolean;
    messagesData?: MessageEntry[];
    promptText?: string;
    promptThrows?: boolean;
    createReturnsNoId?: boolean;
  } = {},
): SummarizerClient & { state: MockState } {
  const state: MockState = {
    summarizeCalls: 0,
    createCalls: 0,
    promptCalls: 0,
    messagesCalls: 0,
    providerListCalls: 0,
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
        if (opts.createReturnsNoId) return { data: {} };
        scratchCounter += 1;
        return { data: { id: `scratch-${scratchCounter}` } };
      },
      prompt: async () => {
        state.promptCalls += 1;
        if (opts.promptThrows) throw new Error("prompt failed");
        return {
          data: {
            info: {},
            parts: [{ type: "text", text: opts.promptText ?? VALID_SUMMARY }],
          },
        };
      },
      messages: async () => {
        state.messagesCalls += 1;
        return {
          data:
            opts.messagesData ??
            [
              {
                info: { role: "user" },
                parts: [{ type: "text", text: "do the thing" }],
              },
              {
                info: { role: "assistant" },
                parts: [{ type: "text", text: "done" }],
              },
            ],
        };
      },
      delete: async (options) => {
        state.deletedScratchIds.push(options.path.id);
        return { data: true };
      },
    },
    provider: {
      list: async () => {
        state.providerListCalls += 1;
        if (opts.providerListThrows) throw new Error("provider list down");
        return { data: { all: opts.providers ?? [] } };
      },
    },
  };
}

function baseArgs(sessionID: string, extra: Record<string, unknown> = {}) {
  return {
    sessionID,
    ctx: { session_id: sessionID },
    source: "turn_boundary",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// T9.1 — config
// ---------------------------------------------------------------------------

describe("compaction config parsing", () => {
  test("defaults: opt-in, documented numbers", () => {
    const config = loadAstrocodeConfig([]);
    expect(config.compaction).toEqual({
      enabled: false,
      trigger_ratio: COMPACTION_TRIGGER_RATIO_DEFAULT,
      context_window: COMPACTION_CONTEXT_WINDOW_DEFAULT,
      context_windows: {},
      prune_stub_chars: COMPACTION_PRUNE_STUB_CHARS_DEFAULT,
      cooldown_seconds: COMPACTION_COOLDOWN_SECONDS_DEFAULT,
      continue_after: true,
    });
    expect(COMPACTION_TRIGGER_RATIO_DEFAULT).toBe(0.8);
    expect(COMPACTION_CONTEXT_WINDOW_DEFAULT).toBe(200000);
    expect(COMPACTION_PRUNE_STUB_CHARS_DEFAULT).toBe(200);
    expect(COMPACTION_COOLDOWN_SECONDS_DEFAULT).toBe(300);
  });

  test("full valid block parses; 0 cooldown is valid (no cooldown)", () => {
    const config = loadAstrocodeConfig([], {
      compaction: {
        enabled: true,
        summarizer_model: FULL_MODEL,
        trigger_ratio: 0.75,
        context_window: 1000,
        context_windows: { [FULL_MODEL]: 128000 },
        prune_stub_chars: 100,
        cooldown_seconds: 0,
      },
    });
    expect(config.compaction.enabled).toBe(true);
    expect(config.compaction.summarizer_model).toBe(FULL_MODEL);
    expect(config.compaction.trigger_ratio).toBe(0.75);
    expect(config.compaction.context_window).toBe(1000);
    expect(config.compaction.context_windows).toEqual({ [FULL_MODEL]: 128000 });
    expect(config.compaction.prune_stub_chars).toBe(100);
    expect(config.compaction.cooldown_seconds).toBe(0);
  });

  test("trigger_ratio boundaries 0.7/0.8 valid; outside -> default 0.8", () => {
    for (const valid of [0.7, 0.8]) {
      const config = loadAstrocodeConfig([], { compaction: { trigger_ratio: valid } });
      expect(config.compaction.trigger_ratio).toBe(valid);
    }
    for (const invalid of [0.69, 0.81, 0.5, 1, -1]) {
      const config = loadAstrocodeConfig([], { compaction: { trigger_ratio: invalid } });
      expect(config.compaction.trigger_ratio).toBe(0.8);
    }
  });

  test("prune_stub_chars boundaries 50/2000 valid; outside -> default 200", () => {
    for (const valid of [50, 2000]) {
      const config = loadAstrocodeConfig([], { compaction: { prune_stub_chars: valid } });
      expect(config.compaction.prune_stub_chars).toBe(valid);
    }
    for (const invalid of [49, 2001, 0, -5]) {
      const config = loadAstrocodeConfig([], { compaction: { prune_stub_chars: invalid } });
      expect(config.compaction.prune_stub_chars).toBe(200);
    }
  });

  test("context_window must be a positive integer; garbage -> 200000", () => {
    for (const invalid of [0, -5, 1.5, "big", Number.NaN]) {
      const config = loadAstrocodeConfig([], { compaction: { context_window: invalid } });
      expect(config.compaction.context_window).toBe(200000);
    }
    const config = loadAstrocodeConfig([], { compaction: { context_window: 1 } });
    expect(config.compaction.context_window).toBe(1);
  });

  test("cooldown_seconds non-negative; garbage -> default 300", () => {
    const zero = loadAstrocodeConfig([], { compaction: { cooldown_seconds: 0 } });
    expect(zero.compaction.cooldown_seconds).toBe(0);
    for (const invalid of [-1, "soon", Number.NaN]) {
      const config = loadAstrocodeConfig([], { compaction: { cooldown_seconds: invalid } });
      expect(config.compaction.cooldown_seconds).toBe(300);
    }
  });

  test("context_windows map: garbage entries dropped, valid kept", () => {
    const config = loadAstrocodeConfig([], {
      compaction: {
        context_windows: {
          [FULL_MODEL]: 128000,
          "mimo-v2.6-pro": 64000,
          bad: "lots",
          negative: -3,
          fractional: 1.5,
          "": 1000,
        },
      },
    });
    expect(config.compaction.context_windows).toEqual({
      [FULL_MODEL]: 128000,
      "mimo-v2.6-pro": 64000,
    });
  });

  test("non-object compaction input -> full defaults, no throw", () => {
    for (const garbage of ["yes", 42, [], true, null]) {
      const config = loadAstrocodeConfig([], { compaction: garbage });
      expect(config.compaction.enabled).toBe(false);
      expect(config.compaction.trigger_ratio).toBe(0.8);
    }
  });

  test("garbage fields individually fall back without throwing", () => {
    const config = loadAstrocodeConfig([], {
      compaction: {
        enabled: "yes",
        summarizer_model: 42,
        trigger_ratio: "high",
        context_window: {},
        context_windows: "map",
        prune_stub_chars: true,
        cooldown_seconds: [],
        unknown_key: "ignored",
      },
    });
    expect(config.compaction).toEqual({
      enabled: false,
      trigger_ratio: 0.8,
      context_window: 200000,
      context_windows: {},
      prune_stub_chars: 200,
      cooldown_seconds: 300,
      continue_after: true,
    });
  });

  test("walk-up layers: nearest layer wins per field", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-compaction-layers-"));
    const home = join(root, "home");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    try {
      writeFileSync(
        join(home, "astrocode.json"),
        JSON.stringify({
          compaction: { enabled: true, trigger_ratio: 0.7, summarizer_model: "home/model" },
        }),
      );
      writeFileSync(
        join(project, "astrocode.json"),
        JSON.stringify({ compaction: { trigger_ratio: 0.75 } }),
      );
      const config = loadAstrocodeConfig([project]);
      expect(config.compaction.enabled).toBe(true);
      expect(config.compaction.trigger_ratio).toBe(0.75);
      expect(config.compaction.summarizer_model).toBe("home/model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T9.2 — state
// ---------------------------------------------------------------------------

describe("compaction state", () => {
  test("ensure/get/snapshot lifecycle", () => {
    expect(getCompactionState("s1")).toBeUndefined();
    expect(compactionStateSnapshot("s1")).toEqual({
      last_compaction_ts: undefined,
      region_hashes: [],
      summary_frozen: undefined,
      summary_sha256: undefined,
      summary_anchor_id: undefined,
      epoch_dirty: false,
      in_flight: false,
      force_compact: false,
      stubbed_parts: {},
      guard_conflicts_reported: [],
    });
    const state = ensureCompactionState("s1");
    state.in_flight = true;
    expect(getCompactionState("s1")?.in_flight).toBe(true);
  });

  test("markCompactionComplete stamps ts and releases in_flight", () => {
    setInFlight("s2", true);
    markCompactionComplete("s2", 1234);
    const snapshot = compactionStateSnapshot("s2");
    expect(snapshot.last_compaction_ts).toBe(1234);
    expect(snapshot.in_flight).toBe(false);
  });

  test("region hashes: add/has, bounded with oldest dropped", () => {
    for (let i = 0; i < REGION_HASH_LIMIT + 100; i += 1) {
      addRegionHash("s3", `hash-${i}`);
    }
    expect(hasRegionHash("s3", `hash-${REGION_HASH_LIMIT + 99}`)).toBe(true);
    expect(hasRegionHash("s3", "hash-0")).toBe(false);
    expect(hasRegionHash("s3", "hash-99")).toBe(false);
    expect(hasRegionHash("s3", "hash-100")).toBe(true);
    expect(compactionStateSnapshot("s3").region_hashes).toHaveLength(REGION_HASH_LIMIT);
    expect(hasRegionHash("missing", "hash-0")).toBe(false);
  });

  test("summary_frozen set/get; empty text ignored", () => {
    setSummaryFrozen("s4", "frozen text");
    expect(compactionStateSnapshot("s4").summary_frozen).toBe("frozen text");
    setSummaryFrozen("s4", "");
    expect(compactionStateSnapshot("s4").summary_frozen).toBe("frozen text");
  });

  test("state map is bounded (wholesale clear at the cap)", () => {
    for (let i = 0; i < COMPACTION_STATE_LIMIT; i += 1) {
      ensureCompactionState(`session-${i}`);
    }
    expect(getCompactionState("session-0")).toBeDefined();
    // One more entry trips the cap: everything clears, the new one survives.
    ensureCompactionState("session-extra");
    expect(getCompactionState("session-0")).toBeUndefined();
    expect(getCompactionState("session-extra")).toBeDefined();
  });

  test("rememberUsage/lastUsage roundtrip; reset clears", () => {
    rememberUsage("s5", usage({ input: 10 }));
    expect(lastUsage("s5")?.input).toBe(10);
    expect(lastUsage("missing")).toBeUndefined();
    rememberUsage("", usage());
    resetCompactionState();
    expect(lastUsage("s5")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T9.2 — trigger
// ---------------------------------------------------------------------------

describe("shouldCompact", () => {
  const cfg = {
    enabled: true,
    trigger_ratio: 0.8,
    context_window: 1000,
    context_windows: {},
    cooldown_seconds: 300,
  };

  test("disabled -> never compacts, even with a full window", () => {
    const decision = shouldCompact(undefined, { ...cfg, enabled: false }, usage({ input: 5000 }), 0);
    expect(decision).toEqual({ compact: false, reason: "disabled" });
  });

  test("no/invalid usage -> no-usage", () => {
    expect(shouldCompact(undefined, cfg, undefined, 0).reason).toBe("no-usage");
    expect(
      shouldCompact(undefined, cfg, usage({ input: Number.NaN }), 0).reason,
    ).toBe("no-usage");
  });

  test("in_flight blocks", () => {
    const decision = shouldCompact(
      { in_flight: true },
      cfg,
      usage({ input: 5000 }),
      0,
    );
    expect(decision).toEqual({ compact: false, reason: "in-flight" });
  });

  test("cooldown blocks until elapsed; 0 cooldown never blocks", () => {
    const state = { last_compaction_ts: 1000, in_flight: false };
    expect(shouldCompact(state, cfg, usage({ input: 5000 }), 1000 + 299_999).reason).toBe("cooldown");
    const decision = shouldCompact(state, cfg, usage({ input: 5000 }), 1000 + 300_000);
    expect(decision.compact).toBe(true);
    const zeroCooldown = { ...cfg, cooldown_seconds: 0 };
    expect(
      shouldCompact(state, zeroCooldown, usage({ input: 5000 }), 1001).compact,
    ).toBe(true);
  });

  test("below threshold -> below-threshold with ratio", () => {
    const decision = shouldCompact(undefined, cfg, usage({ input: 700 }), 0);
    expect(decision.compact).toBe(false);
    expect(decision.reason).toBe("below-threshold");
    expect(decision.ratio).toBeCloseTo(0.7, 10);
  });

  test("at/above threshold -> triggered; ratio counts input+cache_read+cache_write", () => {
    const decision = shouldCompact(
      undefined,
      cfg,
      usage({ input: 100, cache_read: 500, cache_write: 200 }),
      0,
    );
    expect(decision.compact).toBe(true);
    expect(decision.reason).toBe("triggered");
    expect(decision.ratio).toBeCloseTo(0.8, 10);
    expect(decision.window).toBe(1000);
  });

  test("per-model window override (full id and bare id keys)", () => {
    const withMap = {
      ...cfg,
      context_windows: { [FULL_MODEL]: 2000, "mimo-v2.6-pro": 4000 },
    };
    // Full-id key wins over the bare key and the global window.
    expect(
      shouldCompact(undefined, withMap, usage({ input: 1600 }), 0).compact,
    ).toBe(true); // 1600/2000 = 0.8
    expect(
      shouldCompact(undefined, withMap, usage({ input: 1500 }), 0).reason,
    ).toBe("below-threshold");
    // Bare-id key applies when the map lacks the full id.
    const bareOnly = { ...cfg, context_windows: { "mimo-v2.6-pro": 4000 } };
    expect(
      shouldCompact(undefined, bareOnly, usage({ input: 3200 }), 0).compact,
    ).toBe(true);
    // Another model falls back to the global window (700/1000 = 0.7 < 0.8).
    expect(
      shouldCompact(undefined, withMap, usage({ model: "openrouter/other", input: 700 }), 0)
        .reason,
    ).toBe("below-threshold");
    expect(
      shouldCompact(undefined, withMap, usage({ model: "openrouter/other", input: 800 }), 0)
        .compact,
    ).toBe(true);
  });

  test("contextWindowForModel precedence and defensive fallback", () => {
    const cfg2 = {
      context_window: 1000,
      context_windows: { [FULL_MODEL]: 2000, "mimo-v2.6-pro": 4000 },
    };
    expect(contextWindowForModel(cfg2, FULL_MODEL)).toBe(2000);
    expect(contextWindowForModel(cfg2, "openrouter/mimo-v2.6-pro")).toBe(4000);
    expect(contextWindowForModel(cfg2, "openrouter/other")).toBe(1000);
    expect(contextWindowForModel(cfg2, undefined)).toBe(1000);
    // Garbage global window -> documented default, never <= 0.
    expect(contextWindowForModel({ context_window: -5, context_windows: {} }, "x")).toBe(
      COMPACTION_CONTEXT_WINDOW_DEFAULT,
    );
  });
});

// ---------------------------------------------------------------------------
// T9.3 — summarize (mock client)
// ---------------------------------------------------------------------------

describe("summarize primary (native) path", () => {
  test("configured + probed model -> native route, ok record, no scratch", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = mockClient({
        providers: [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }],
      });
      const outcome = await summarize(client, logger, baseArgs("ses-native", {
        summarizer_model: FULL_MODEL,
        ratio: 0.9,
        tokens_before: 900,
      }));
      logger.close();

      expect(outcome).toEqual({ text: "", path: "native" });
      expect(client.state.summarizeCalls).toBe(1);
      expect(client.state.createCalls).toBe(0);
      expect(client.state.promptCalls).toBe(0);

      const records = readRecords(dir);
      expect(records).toHaveLength(1);
      const record = records[0] as TelemetryRecord;
      expect(record.kind).toBe("compaction");
      expect(record.session_id).toBe("ses-native");
      expect(record.event?.path).toBe("native");
      expect(record.event?.outcome).toBe("ok");
      expect(record.event?.source).toBe("turn_boundary");
      expect(record.event?.ratio).toBeCloseTo(0.9, 10);
      expect(record.event?.tokens_before).toBe(900);
      expect(record.event?.summarizer_model).toBe(FULL_MODEL);
      expect(typeof record.event?.duration_ms).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("route returns false -> native error record, scratch fallback runs", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = mockClient({
        providers: [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }],
        summarizeResult: () => ({ data: false }),
        promptText: VALID_SUMMARY,
      });
      const outcome = await summarize(client, logger, baseArgs("ses-false", {
        summarizer_model: FULL_MODEL,
      }));
      logger.close();

      expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
      expect(client.state.summarizeCalls).toBe(1);
      expect(client.state.promptCalls).toBe(1);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["native", "error"],
        ["scratch", "ok"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("route throws -> native error record, scratch fallback runs", async () => {
    const logger = createTelemetryLogger({ enabled: false });
    const client = mockClient({
      providers: [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }],
      summarizeThrows: true,
      promptText: VALID_SUMMARY,
    });
    const outcome = await summarize(client, logger, baseArgs("ses-throw", {
      summarizer_model: FULL_MODEL,
    }));
    expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
    expect(client.state.promptCalls).toBe(1);
  });
});

describe("summarize probe + fallback", () => {
  test("unknown summarizer model -> native skipped, scratch runs", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = mockClient({
        providers: [{ id: "openrouter", models: {} }],
        promptText: VALID_SUMMARY,
      });
      const outcome = await summarize(client, logger, baseArgs("ses-probe", {
        summarizer_model: FULL_MODEL,
      }));
      logger.close();

      expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
      expect(client.state.summarizeCalls).toBe(0);
      expect(client.state.providerListCalls).toBe(1);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["native", "skipped"],
        ["scratch", "ok"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider list throws -> probe fails, scratch runs", async () => {
    const logger = createTelemetryLogger({ enabled: false });
    const client = mockClient({ providerListThrows: true, promptText: VALID_SUMMARY });
    const outcome = await summarize(client, logger, baseArgs("ses-pl", {
      summarizer_model: FULL_MODEL,
    }));
    expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
  });

  test("no summarizer_model -> scratch directly, no probe", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = mockClient({ promptText: VALID_SUMMARY });
      const outcome = await summarize(client, logger, baseArgs("ses-nomodel"));
      logger.close();
      expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
      expect(client.state.providerListCalls).toBe(0);
      expect(client.state.summarizeCalls).toBe(0);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["scratch", "ok"],
      ]);
      expect(records[0]?.event?.summarizer_model).toBe(SCRATCH_SUMMARIZER_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed summarizer_model -> native skipped, scratch runs", async () => {
    const logger = createTelemetryLogger({ enabled: false });
    const client = mockClient({ promptText: VALID_SUMMARY });
    const outcome = await summarize(client, logger, baseArgs("ses-bad", {
      summarizer_model: "no-slash",
    }));
    expect(outcome).toEqual({ text: VALID_SUMMARY, path: "scratch" });
    expect(client.state.summarizeCalls).toBe(0);
  });
});

describe("summarize failure discipline", () => {
  test("both paths fail -> typed error AFTER records; scratch cleaned up", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = mockClient({
        providers: [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }],
        summarizeThrows: true,
        promptThrows: true,
      });
      let threw: unknown;
      try {
        await summarize(client, logger, baseArgs("ses-both-fail", {
          summarizer_model: FULL_MODEL,
        }));
      } catch (err) {
        threw = err;
      }
      logger.close();

      expect(threw).toBeInstanceOf(CompactionSummarizeError);
      expect(client.state.summarizeCalls).toBe(1);
      expect(client.state.promptCalls).toBe(1);
      expect(client.state.deletedScratchIds).toHaveLength(1);
      const records = readRecords(dir);
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["native", "error"],
        ["scratch", "error"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no transcript -> scratch error record, typed error", async () => {
    const logger = createTelemetryLogger({ enabled: false });
    const client = mockClient({ messagesData: [] });
    let threw: unknown;
    try {
      await summarize(client, logger, baseArgs("ses-empty"));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(CompactionSummarizeError);
    expect(client.state.createCalls).toBe(0);
  });

  test("scratch session deleted even when prompt throws", async () => {
    const logger = createTelemetryLogger({ enabled: false });
    const client = mockClient({ promptThrows: true });
    try {
      await summarize(client, logger, baseArgs("ses-cleanup"));
    } catch {
      // expected
    }
    expect(client.state.deletedScratchIds).toHaveLength(1);
  });

  test("create returns no id -> scratch error, no prompt", async () => {
    const logger = createTelemetryLogger({ enabled: false });
    const client = mockClient({ createReturnsNoId: true });
    let threw: unknown;
    try {
      await summarize(client, logger, baseArgs("ses-noid"));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(CompactionSummarizeError);
    expect(client.state.promptCalls).toBe(0);
  });
});

describe("scratch transcript digest", () => {
  test("last N messages, text parts only, clipped", () => {
    const long = "x".repeat(1000);
    const digest = transcriptDigest([
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: long }] },
      { info: { role: "assistant" }, parts: [{ type: "tool", state: {} }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "" }] },
      "garbage",
    ]);
    const lines = digest.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("user: hello");
    expect(lines[1]?.startsWith("assistant: xxx")).toBe(true);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(digest.length).toBeLessThan(600);
  });

  test("empty/garbage input -> empty string", () => {
    expect(transcriptDigest(undefined)).toBe("");
    expect(transcriptDigest([])).toBe("");
    expect(transcriptDigest("nope")).toBe("");
  });

  test("prompt template is a stable constant with the three sections", () => {
    expect(SUMMARY_PROMPT_TEMPLATE).toContain("## Goal");
    expect(SUMMARY_PROMPT_TEMPLATE).toContain("## State");
    expect(SUMMARY_PROMPT_TEMPLATE).toContain("## Next");
    expect(SUMMARIZER_PATH).toBe("native");
  });
});

// ---------------------------------------------------------------------------
// Runner glue (maybeCompact)
// ---------------------------------------------------------------------------

describe("maybeCompact", () => {
  const cfg = {
    enabled: true,
    trigger_ratio: 0.8,
    context_window: 1000,
    context_windows: {},
    cooldown_seconds: 300,
    summarizer_model: FULL_MODEL,
  };

  test("disabled -> no-op, zero client calls", async () => {
    const client = mockClient();
    const result = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      { ...cfg, enabled: false },
      "ses-off",
      usage({ input: 5000 }),
      "turn_boundary",
    );
    expect(result).toEqual({ ran: false, reason: "disabled" });
    expect(client.state.summarizeCalls).toBe(0);
  });

  test("scratch summarizer session is never compacted (runaway-chain guard)", async () => {
    const client = mockClient({ promptText: VALID_SUMMARY });
    markScratchSession("ses-scratch-guard");
    const result = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      cfg,
      "ses-scratch-guard",
      usage({ input: 5000 }),
      "turn_boundary",
    );
    expect(result).toEqual({ ran: false, reason: "scratch-session" });
    expect(client.state.summarizeCalls).toBe(0);
  });

  test("a successful compaction arms the post-compaction continuation flag", async () => {
    const client = mockClient({ promptText: VALID_SUMMARY });
    const result = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      cfg,
      "ses-cont",
      usage({ input: 900 }),
      "turn_boundary",
    );
    expect(result.ran).toBe(true);
    expect(consumePendingContinuation("ses-cont")).toBe(true);
    // read-and-clear: consumed exactly once
    expect(consumePendingContinuation("ses-cont")).toBe(false);
  });

  test("a child (subagent) session never arms the continuation flag", async () => {
    const client = mockClient({ promptText: VALID_SUMMARY });
    registerChildSession("ses-child", "explore");
    const result = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      cfg,
      "ses-child",
      usage({ input: 900 }),
      "turn_boundary",
    );
    // The compaction still runs for the child (its history is compacted)...
    expect(result.ran).toBe(true);
    // ...but the post-compaction continuation is NOT armed: opencode's `task`
    // tool owns the child's lifecycle and has already returned by the time the
    // child idles, so a continuation would run orphaned.
    expect(consumePendingContinuation("ses-child")).toBe(false);
  });

  test("a gated (no-op) evaluation does not arm the continuation flag", async () => {
    const client = mockClient();
    const result = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      { ...cfg, enabled: false },
      "ses-cont-off",
      usage({ input: 900 }),
      "turn_boundary",
    );
    expect(result.ran).toBe(false);
    expect(consumePendingContinuation("ses-cont-off")).toBe(false);
  });

  test("triggered -> runs, freezes scratch summary, stamps cooldown, releases lock", async () => {
    const client = mockClient({
      // Probe fails (no providers) -> scratch path runs.
      promptText: VALID_SUMMARY,
    });
    const result = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      cfg,
      "ses-run",
      usage({ input: 900 }),
      "session_idle",
    );
    expect(result.ran).toBe(true);
    expect(result.outcome?.path).toBe("scratch");
    const snapshot = compactionStateSnapshot("ses-run");
    expect(snapshot.in_flight).toBe(false);
    expect(snapshot.summary_frozen).toBe(VALID_SUMMARY);
    expect(snapshot.last_compaction_ts).toBeDefined();
    // Cooldown now blocks the immediately following evaluation.
    const second = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      cfg,
      "ses-run",
      usage({ input: 900 }),
      "session_idle",
    );
    expect(second).toEqual({ ran: false, reason: "cooldown" });
  });

  test("native success does not freeze a summary (host-managed)", async () => {
    const client = mockClient({
      providers: [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }],
    });
    const result = await maybeCompact(
      client,
      createTelemetryLogger({ enabled: false }),
      cfg,
      "ses-native-run",
      usage({ input: 900 }),
      "turn_boundary",
    );
    expect(result.ran).toBe(true);
    expect(result.outcome?.path).toBe("native");
    expect(compactionStateSnapshot("ses-native-run").summary_frozen).toBeUndefined();
  });

  test("failure stamps cooldown and releases the lock", async () => {
    const client = mockClient({
      providers: [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }],
      summarizeThrows: true,
      promptThrows: true,
    });
    const logger = createTelemetryLogger({ enabled: false });
    const first = await maybeCompact(client, logger, cfg, "ses-fail", usage({ input: 900 }), "turn_boundary");
    expect(first.ran).toBe(false);
    expect(first.reason).toBe("summarizer-failed");
    expect(compactionStateSnapshot("ses-fail").in_flight).toBe(false);
    // The continuation armed synchronously before the summarizer must be
    // disarmed again on failure (no spurious nudge).
    expect(consumePendingContinuation("ses-fail")).toBe(false);
    const second = await maybeCompact(client, logger, cfg, "ses-fail", usage({ input: 900 }), "turn_boundary");
    expect(second.reason).toBe("cooldown");
  });

  test("double-seam race: second synchronous evaluation sees in-flight", async () => {
    const client = mockClient({
      // Probe fails -> scratch path; exactly one prompt call total.
      promptText: VALID_SUMMARY,
    });
    const logger = createTelemetryLogger({ enabled: false });
    const first = maybeCompact(client, logger, cfg, "ses-race", usage({ input: 900 }), "turn_boundary");
    const second = maybeCompact(client, logger, cfg, "ses-race", usage({ input: 900 }), "session_idle");
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ran).toBe(true);
    expect(r2).toEqual({ ran: false, reason: "in-flight" });
    expect(client.state.promptCalls).toBe(1);
  });

  test("telemetry record carries model attribution from usage", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = mockClient({
        providers: [{ id: "openrouter", models: { "xiaomi/mimo-v2.6-pro": {} } }],
      });
      await maybeCompact(
        client,
        logger,
        cfg,
        "ses-attr",
        usage({ input: 900 }),
        "turn_boundary",
      );
      logger.close();
      const records = readRecords(dir);
      expect(records).toHaveLength(1);
      const record = records[0] as TelemetryRecord;
      expect(record.model).toEqual({
        provider_id: "openrouter",
        model_id: "xiaomi/mimo-v2.6-pro",
      });
      expect(record.event?.path).toBe("native");
      expect(record.event?.outcome).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
