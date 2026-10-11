import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CACHE_ALARM_MIN_TOKENS,
  CACHE_ALARM_RATIO,
  TOOL_ERROR_MAX_CHARS,
  cacheRatio,
  captureAssistantUsage,
  captureToolError,
  createTelemetryLogger,
  recordAliasHit,
  recordCompaction,
  recordFallback,
  recordSystemDiff,
  recordToolError,
  toolErrorCaptureFromPart,
  type AliasHitEvent,
  type CompactionEvent,
  type EventContext,
  type FallbackEvent,
  type SystemDiffEvent,
  type TelemetryRecord,
  type TelemetryTokens,
  type ToolErrorEvent,
} from "../src/telemetry/log";
import { configureLogger } from "../src/log";

// Telemetry must resolve its dir from the options we pass, not from the
// ambient environment.
const ORIGINAL_TELEMETRY_DIR = process.env.ASTROCODE_TELEMETRY_DIR;

afterEach(() => {
  configureLogger(undefined);
  if (ORIGINAL_TELEMETRY_DIR === undefined) {
    delete process.env.ASTROCODE_TELEMETRY_DIR;
  } else {
    process.env.ASTROCODE_TELEMETRY_DIR = ORIGINAL_TELEMETRY_DIR;
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astrocode-telemetry-"));
}

function readLines(file: string): TelemetryRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TelemetryRecord);
}

function tokensOf(input: number, cache_read: number, cache_write: number): TelemetryTokens {
  return { input, output: 10, reasoning: 0, cache_read, cache_write };
}

describe("cacheRatio", () => {
  test("computes cache_read / (cache_read + cache_write + input)", () => {
    expect(cacheRatio(tokensOf(5, 90, 5))).toBe(0.9);
    expect(cacheRatio(tokensOf(100, 0, 0))).toBe(0);
    expect(cacheRatio(tokensOf(0, 50, 50))).toBe(0.5);
  });

  test("zero denominator counts as a perfect 1.0", () => {
    expect(cacheRatio(tokensOf(0, 0, 0))).toBe(1.0);
  });
});

describe("TelemetryLogger", () => {
  test("record -> file roundtrip preserves fields and drops unknown ones", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      logger.record("usage", {
        session_id: "ses_1",
        message_id: "msg_1",
        agent: "sisyphus",
        model: { provider_id: "openrouter", model_id: "x/y" },
        tokens: tokensOf(100, 900, 50),
        cost_usd: 0.0123,
        cache_ratio: 0.857,
        event: { reason: "test", count: 3, ok: true, nil: null },
        bogus_unknown_field: "must not be written",
      });
      logger.close();

      // The file name uses the real clock; find whatever day file appeared.
      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const lines = readLines(join(dir, files[0] as string));
      expect(lines).toHaveLength(1);
      const record = lines[0] as TelemetryRecord;
      expect(record.kind).toBe("usage");
      expect(record.session_id).toBe("ses_1");
      expect(record.message_id).toBe("msg_1");
      expect(record.agent).toBe("sisyphus");
      expect(record.model).toEqual({ provider_id: "openrouter", model_id: "x/y" });
      expect(record.tokens).toEqual(tokensOf(100, 900, 50));
      expect(record.cost_usd).toBe(0.0123);
      expect(record.cache_ratio).toBe(0.857);
      expect(record.event).toEqual({ reason: "test", count: 3, ok: true, nil: null });
      expect(record.ts).toEqual(expect.any(String));
      expect(record).not.toHaveProperty("bogus_unknown_field");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("date rotation writes two files when the injected day changes", async () => {
    const dir = tempDir();
    try {
      let clock = new Date("2026-10-10T23:59:00");
      const logger = createTelemetryLogger({ dir, now: () => clock });
      logger.record("usage", { session_id: "day1" });
      clock = new Date("2026-10-11T00:01:00");
      logger.record("usage", { session_id: "day2" });
      logger.close();

      // The day-1 batch drains through the async write path; give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const day1 = readLines(join(dir, "telemetry-2026-10-10.jsonl"));
      const day2 = readLines(join(dir, "telemetry-2026-10-11.jsonl"));
      expect(day1).toHaveLength(1);
      expect(day1[0]?.session_id).toBe("day1");
      expect(day2).toHaveLength(1);
      expect(day2[0]?.session_id).toBe("day2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enabled: false is a complete no-op — zero I/O", () => {
    const dir = tempDir();
    const target = join(dir, "never-created");
    try {
      const logger = createTelemetryLogger({ enabled: false, dir: target });
      logger.record("usage", { session_id: "ses" });
      logger.record("cache_alarm", { session_id: "ses" });
      logger.close();
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid payload -> log.error, file keeps only valid JSON lines", () => {
    delete process.env.ASTROCODE_TELEMETRY_DIR;
    const err = spyOn(console, "error").mockImplementation(() => {});
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      logger.record("usage", { message_id: "no session_id" });
      logger.record("usage", { session_id: "ses", tokens: { input: "bad" } });
      logger.record("usage", { session_id: "ses_ok", cost_usd: 0.5 });
      logger.close();

      expect(err).toHaveBeenCalled();
      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const lines = readLines(join(dir, files[0] as string));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.session_id).toBe("ses_ok");
    } finally {
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureAssistantUsage", () => {
  function assistantInfo(overrides: {
    id: string;
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  }): Record<string, unknown> {
    return {
      id: overrides.id,
      sessionID: "ses_live",
      role: "assistant",
      providerID: "openrouter",
      modelID: "xiaomi/mimo-v2.6-pro",
      cost: 0.01,
      tokens: overrides.tokens,
      time: { created: 1, completed: 2 },
    };
  }

  test("finished assistant message writes exactly one usage record", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      captureAssistantUsage(
        logger,
        assistantInfo({
          id: "msg_ok_1",
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 900, write: 30 } },
        }),
      );
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const lines = readLines(join(dir, files[0] as string));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.kind).toBe("usage");
      expect(lines[0]?.model).toEqual({
        provider_id: "openrouter",
        model_id: "xiaomi/mimo-v2.6-pro",
      });
      expect(lines[0]?.tokens).toEqual({
        input: 100,
        output: 20,
        reasoning: 0,
        cache_read: 900,
        cache_write: 30,
      });
      expect(lines[0]?.cache_ratio).toBeCloseTo(900 / 1030, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("in-progress message (no completed, no error) records nothing", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      captureAssistantUsage(logger, {
        id: "msg_streaming",
        sessionID: "ses_live",
        role: "assistant",
        tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1 },
      });
      logger.close();
      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cache_alarm fires below the ratio threshold on large prompts", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      // ratio = 1000 / 21000 < 0.95, total = 21000 > 10000 -> alarm.
      captureAssistantUsage(
        logger,
        assistantInfo({
          id: "msg_alarm_1",
          tokens: { input: 20000, output: 5, reasoning: 0, cache: { read: 1000, write: 0 } },
        }),
      );
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      const lines = readLines(join(dir, files[0] as string));
      expect(lines.map((line) => line.kind)).toEqual(["usage", "cache_alarm"]);
      const alarm = lines[1] as TelemetryRecord;
      expect(alarm.session_id).toBe("ses_live");
      expect(alarm.cache_ratio).toBeCloseTo(1000 / 21000, 10);
      expect(alarm.event?.total_tokens).toBe(21000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no cache_alarm when ratio is healthy or the prompt is small", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      // Healthy ratio 19500/20000 = 0.975 >= 0.95 despite large total.
      captureAssistantUsage(
        logger,
        assistantInfo({
          id: "msg_healthy_1",
          tokens: { input: 500, output: 5, reasoning: 0, cache: { read: 19500, write: 0 } },
        }),
      );
      // Bad ratio but total 100 <= CACHE_ALARM_MIN_TOKENS.
      captureAssistantUsage(
        logger,
        assistantInfo({
          id: "msg_small_1",
          tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      const lines = readLines(join(dir, files[0] as string));
      expect(lines.map((line) => line.kind)).toEqual(["usage", "usage"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("thresholds match the plan constants", () => {
    expect(CACHE_ALARM_RATIO).toBe(0.95);
    expect(CACHE_ALARM_MIN_TOKENS).toBe(10000);
  });
});

// Typed event sinks (plan T3). Helpers take typed events, but the values
// usually arrive from untyped hook data — so the invalid-payload cases below
// simulate that upstream with a single honest cast (no `as any`).
function malformed<T>(value: unknown): T {
  return value as T;
}

describe("typed event sinks", () => {
  const ctx: EventContext = {
    session_id: "ses_ev",
    message_id: "msg_ev",
    agent: "sisyphus",
    model: { provider_id: "openrouter", model_id: "x/y" },
  };

  test("each helper writes a valid record with its fixed event schema", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      recordFallback(logger, ctx, {
        chain_index: 0,
        from_model: "openrouter/a/b",
        to_model: "openrouter/c/d",
        error_name: "RateLimitError",
        error_class: "transient",
        cooldown_until: null,
        reason: "rate limit",
      });
      recordCompaction(logger, ctx, {
        path: "scratch",
        outcome: "ok",
        source: "auto",
        tokens_before: 100,
        tokens_after: 40,
        ratio: 0.4,
        duration_ms: 12.5,
        summarizer_model: "openrouter/s/m",
      });
      recordToolError(logger, ctx, { tool_name: "bash", error: "boom" });
      recordAliasHit(logger, ctx, {
        alias: "Task_Create",
        canonical: "todowrite",
        kind: "redirect",
      });
      recordSystemDiff(logger, ctx, {
        frozen_sha256: "frozen",
        incoming_sha256: "incoming",
        session_id: "ses_ev",
      });
      // All-optional compaction event is still a valid record.
      recordCompaction(logger, ctx, {});
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const lines = readLines(join(dir, files[0] as string));
      expect(lines.map((line) => line.kind)).toEqual([
        "fallback",
        "compaction",
        "tool_error",
        "alias_hit",
        "system_diff",
        "compaction",
      ]);

      const fallback = lines[0] as TelemetryRecord;
      expect(fallback.session_id).toBe("ses_ev");
      expect(fallback.message_id).toBe("msg_ev");
      expect(fallback.agent).toBe("sisyphus");
      expect(fallback.model).toEqual({ provider_id: "openrouter", model_id: "x/y" });
      expect(fallback.event).toEqual({
        chain_index: 0,
        from_model: "openrouter/a/b",
        to_model: "openrouter/c/d",
        error_name: "RateLimitError",
        error_class: "transient",
        cooldown_until: null,
        reason: "rate limit",
      });

      const compaction = lines[1] as TelemetryRecord;
      expect(compaction.event).toEqual({
        path: "scratch",
        outcome: "ok",
        source: "auto",
        tokens_before: 100,
        tokens_after: 40,
        ratio: 0.4,
        duration_ms: 12.5,
        summarizer_model: "openrouter/s/m",
      });

      const toolError = lines[2] as TelemetryRecord;
      expect(toolError.event).toEqual({ tool_name: "bash", error: "boom" });

      const aliasHit = lines[3] as TelemetryRecord;
      expect(aliasHit.event).toEqual({
        alias: "Task_Create",
        canonical: "todowrite",
        kind: "redirect",
      });

      const systemDiff = lines[4] as TelemetryRecord;
      // session_id is duplicated inside the event per the fixed schema.
      expect(systemDiff.session_id).toBe("ses_ev");
      expect(systemDiff.event).toEqual({
        frozen_sha256: "frozen",
        incoming_sha256: "incoming",
        session_id: "ses_ev",
      });

      expect(lines[5]?.event).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid payload -> log.error, no record, JSONL stays valid per line", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      // Valid seed line: proves the file existed and stayed parseable.
      logger.record("usage", { session_id: "ses_ok" });

      // fallback: non-number chain_index / bad error_class / bad cooldown_until.
      recordFallback(
        logger,
        ctx,
        malformed<FallbackEvent>({
          chain_index: "zero",
          from_model: "a",
          to_model: "b",
          error_name: "E",
          error_class: "transient",
          cooldown_until: null,
          reason: "r",
        }),
      );
      recordFallback(
        logger,
        ctx,
        malformed<FallbackEvent>({
          chain_index: 1,
          from_model: "a",
          to_model: "b",
          error_name: "E",
          error_class: "weird",
          cooldown_until: null,
          reason: "r",
        }),
      );
      recordFallback(
        logger,
        ctx,
        malformed<FallbackEvent>({
          chain_index: 1,
          from_model: "a",
          to_model: "b",
          error_name: "E",
          error_class: "terminal",
          cooldown_until: 5,
          reason: "r",
        }),
      );
      // compaction: unknown key / non-number token field / bad path enum.
      recordCompaction(logger, ctx, malformed<CompactionEvent>({ bogus: true }));
      recordCompaction(
        logger,
        ctx,
        malformed<CompactionEvent>({ tokens_before: "100" }),
      );
      recordCompaction(logger, ctx, malformed<CompactionEvent>({ path: "quantum" }));
      // tool_error: missing tool_name / non-string error.
      recordToolError(
        logger,
        ctx,
        malformed<ToolErrorEvent>({ error: "no tool name" }),
      );
      recordToolError(
        logger,
        ctx,
        malformed<ToolErrorEvent>({ tool_name: "bash", error: 42 }),
      );
      // alias_hit: bad kind.
      recordAliasHit(
        logger,
        ctx,
        malformed<AliasHitEvent>({ alias: "a", canonical: "b", kind: "teleport" }),
      );
      // system_diff: empty sha field.
      recordSystemDiff(
        logger,
        ctx,
        malformed<SystemDiffEvent>({
          frozen_sha256: "",
          incoming_sha256: "b",
          session_id: "s",
        }),
      );
      // Bad context: missing session_id.
      recordToolError(
        logger,
        malformed<EventContext>({ session_id: "" }),
        { tool_name: "bash", error: "x" },
      );
      logger.close();

      expect(err).toHaveBeenCalled();
      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      // readLines JSON.parses every line — a corrupt record would throw here.
      const lines = readLines(join(dir, files[0] as string));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.kind).toBe("usage");
      expect(lines[0]?.session_id).toBe("ses_ok");
    } finally {
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recordToolError truncates error text to 500 chars", () => {
    expect(TOOL_ERROR_MAX_CHARS).toBe(500);
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      recordToolError(logger, ctx, {
        tool_name: "bash",
        error: "x".repeat(800),
      });
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      const lines = readLines(join(dir, files[0] as string));
      expect(lines).toHaveLength(1);
      const event = lines[0]?.event as Record<string, unknown>;
      expect(event.error).toBe("x".repeat(500));
      expect(event.tool_name).toBe("bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("toolErrorCaptureFromPart extracts tool parts in error state", () => {
    const capture = toolErrorCaptureFromPart({
      id: "part_1",
      type: "tool",
      tool: "bash",
      sessionID: "ses_1",
      messageID: "msg_1",
      callID: "call_1",
      state: { status: "error", input: {}, error: "exit code 1" },
    });
    expect(capture?.ctx).toEqual({ session_id: "ses_1", message_id: "msg_1" });
    expect(capture?.event).toEqual({ tool_name: "bash", error: "exit code 1" });
  });

  test("toolErrorCaptureFromPart skips non-tool parts and malformed shapes", () => {
    expect(toolErrorCaptureFromPart(undefined)).toBeUndefined();
    expect(toolErrorCaptureFromPart("garbage")).toBeUndefined();
    expect(toolErrorCaptureFromPart({ type: "text", text: "hi" })).toBeUndefined();
    expect(
      toolErrorCaptureFromPart({
        type: "tool",
        tool: "bash",
        state: { status: "completed" },
      }),
    ).toBeUndefined();
    // Missing tool name / missing error text / missing sessionID -> skip.
    expect(
      toolErrorCaptureFromPart({
        type: "tool",
        state: { status: "error", error: "x" },
      }),
    ).toBeUndefined();
    expect(
      toolErrorCaptureFromPart({
        type: "tool",
        tool: "bash",
        state: { status: "error" },
      }),
    ).toBeUndefined();
    expect(
      toolErrorCaptureFromPart({
        type: "tool",
        tool: "bash",
        state: { status: "error", error: "x" },
      }),
    ).toBeUndefined();
  });

  test("captureToolError writes one tool_error record per part id", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const part = {
        id: "part_dup",
        type: "tool",
        tool: "bash",
        sessionID: "ses_1",
        messageID: "msg_1",
        state: { status: "error", input: {}, error: "boom" },
      };
      expect(captureToolError(logger, part)).toEqual({
        tool_name: "bash",
        error: "boom",
      });
      // Re-emission of the same part is deduped.
      expect(captureToolError(logger, part)).toBeUndefined();
      // A different part records again.
      expect(
        captureToolError(logger, { ...part, id: "part_other", tool: "read" }),
      ).toEqual({ tool_name: "read", error: "boom" });
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      const lines = readLines(join(dir, files[0] as string));
      expect(lines.map((line) => line.kind)).toEqual(["tool_error", "tool_error"]);
      expect(lines[0]?.session_id).toBe("ses_1");
      expect(lines[0]?.event).toEqual({ tool_name: "bash", error: "boom" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});