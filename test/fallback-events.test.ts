// Plan T14 — fallback observability tests:
//   1. recordFallback payload roundtrip (all fields; unknown-key rejection;
//      invalid payloads rejected without corrupting the JSONL stream).
//   2. Per-model cooldown override (cooldown_seconds_by_model) with a mock
//      clock at the registry boundary: a second failure inside the per-model
//      window leaves that link unselected; after the window it is selectable
//      again; models without a per-model entry fall back to the global
//      cooldown_seconds.
//   3. Terminal vs transient error-class mapping in the emitted records.
//   4. parseFallbackConfig handling of the new map + cooldownSecondsFor
//      precedence.
//
// The dispatch-level tests drive the REAL dispatchFallback (chain advance,
// cooldown marking, telemetry emission) over a mock SDK client — the same
// clientWith pattern test/fallback.test.ts uses.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTelemetryLogger,
  recordFallback,
  type EventContext,
  type FallbackEvent,
  type TelemetryRecord,
} from "../src/telemetry/log";
import {
  cooldownSecondsFor,
  parseFallbackConfig,
} from "../src/fallback/config";
import {
  clearAllModelCooldowns,
  isModelCoolingDown,
  markModelCooldown,
  modelCooldownRemainingSeconds,
} from "../src/fallback/cooldown";
import {
  decideFallback,
  dispatchFallback,
} from "../src/fallback";
import {
  clearAll,
  getLastFallbackModel,
  recordAttempt,
} from "../src/fallback/state";
import { clearAllSessionModels } from "../src/fallback/session-model";
import { clearChildSessions } from "../src/fallback/subagent";
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
  return mkdtempSync(join(tmpdir(), "astrocode-fallback-events-"));
}

function readLines(file: string): TelemetryRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TelemetryRecord);
}

function jsonlFile(dir: string): string {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return join(dir, files[0] as string);
}

// The invalid-payload cases simulate upstream untyped data with a single
// honest cast (never the forbidden kinds) — same pattern as
// test/telemetry.test.ts.
function malformed<T>(value: unknown): T {
  return value as T;
}

const ctx: EventContext = { session_id: "ses_fb" };

describe("recordFallback payload roundtrip", () => {
  test("writes every field of the fixed event schema", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      recordFallback(logger, ctx, {
        chain_index: 2,
        from_model: "anthropic/claude-sonnet-5-5",
        to_model: "openrouter/xiaomi/mimo-v2.6-pro",
        error_name: "MessageAbortedError",
        error_class: "terminal",
        cooldown_until: "2026-10-11T12:00:00.000Z",
        reason: "retry",
      });
      logger.close();

      const lines = readLines(jsonlFile(dir));
      expect(lines).toHaveLength(1);
      const record = lines[0] as TelemetryRecord;
      expect(record.ts).toBeString();
      expect(record.kind).toBe("fallback");
      expect(record.session_id).toBe("ses_fb");
      expect(record.event).toEqual({
        chain_index: 2,
        from_model: "anthropic/claude-sonnet-5-5",
        to_model: "openrouter/xiaomi/mimo-v2.6-pro",
        error_name: "MessageAbortedError",
        error_class: "terminal",
        cooldown_until: "2026-10-11T12:00:00.000Z",
        reason: "retry",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown event keys are rejected (log.error, no record)", () => {
    const dir = tempDir();
    // bun does not auto-restore spies between tests, and a later spyOn on the
    // same function inherits the leaked call count — restore explicitly so
    // following test files start from a clean console.
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createTelemetryLogger({ dir });
      recordFallback(
        logger,
        ctx,
        malformed<FallbackEvent>({
          chain_index: 0,
          from_model: "a/b",
          to_model: "c/d",
          error_name: "E",
          error_class: "transient",
          cooldown_until: null,
          reason: "retry",
          // Typo'd producer key — must reject the whole record, not write a
          // lossy one (same discipline as the compaction event schema).
          cooldown_secnds: 5,
        }),
      );
      logger.close();

      expect(err).toHaveBeenCalled();
      // No file was created at all: the only record was rejected.
      expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
    } finally {
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid required fields are rejected; the JSONL stream stays parseable", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      logger.record("usage", { session_id: "ses_seed" });
      recordFallback(
        logger,
        ctx,
        malformed<FallbackEvent>({
          chain_index: "zero",
          from_model: "a/b",
          to_model: "c/d",
          error_name: "E",
          error_class: "transient",
          cooldown_until: null,
          reason: "retry",
        }),
      );
      recordFallback(
        logger,
        ctx,
        malformed<FallbackEvent>({
          chain_index: 1,
          from_model: "a/b",
          to_model: "c/d",
          error_name: "E",
          error_class: "weird",
          cooldown_until: null,
          reason: "retry",
        }),
      );
      recordFallback(
        logger,
        ctx,
        malformed<FallbackEvent>({
          chain_index: 1,
          from_model: "a/b",
          to_model: "c/d",
          error_name: "E",
          error_class: "terminal",
          cooldown_until: 5,
          reason: "retry",
        }),
      );
      logger.close();

      const lines = readLines(jsonlFile(dir));
      expect(lines.map((line) => line.kind)).toEqual(["usage"]);
    } finally {
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchFallback-level tests: real chain advance + cooldown marking +
// telemetry emission over a mock SDK client.
// ---------------------------------------------------------------------------

const TERMINAL_ERROR = { message: "You've hit your session limit · resets 6pm" };
const TRANSIENT_ERROR = { message: "overloaded" };

function userTurn(model: string): unknown {
  const slash = model.indexOf("/");
  const providerID = slash > 0 ? model.slice(0, slash) : model;
  const modelID = slash > 0 ? model.slice(slash + 1) : model;
  return {
    info: {
      role: "user",
      agent: "Atlas - Plan Executor",
      model: { providerID, modelID },
    },
    parts: [{ type: "text", text: "do the thing" }],
  };
}

function clientWith(messages: unknown[]) {
  const calls = { abort: 0, promptAsync: 0 };
  const client = {
    session: {
      messages: async () => ({ data: messages }),
      abort: async () => {
        calls.abort += 1;
        return {};
      },
      prompt: async () => ({ data: {} }),
      promptAsync: async () => {
        calls.promptAsync += 1;
        return { data: {} };
      },
    },
  };
  return { client, calls };
}

describe("dispatchFallback telemetry + per-model cooldown", () => {
  beforeEach(() => {
    clearAll();
    clearAllSessionModels();
    clearAllModelCooldowns();
    clearChildSessions();
  });

  test("rotation emits one fallback record with the full chain context", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const { client } = clientWith([userTurn("a/one")]);
      const config = parseFallbackConfig({
        enabled: true,
        models: ["a/one", "b/two"],
        cooldown_seconds: 60,
        cooldown_seconds_by_model: { "a/one": 300 },
      });

      const decision = await dispatchFallback(
        client as never,
        config,
        "tel-1",
        TERMINAL_ERROR,
        undefined,
        logger,
      );
      logger.close();

      expect(decision.retry).toBe(true);
      expect(decision.model).toBe("b/two");
      expect(decision.chain_index).toBe(1);

      const lines = readLines(jsonlFile(dir));
      expect(lines).toHaveLength(1);
      const record = lines[0] as TelemetryRecord;
      expect(record.kind).toBe("fallback");
      expect(record.session_id).toBe("tel-1");
      expect(record.agent).toBe("Atlas - Plan Executor");
      expect(record.event).toEqual({
        chain_index: 1,
        from_model: "a/one",
        to_model: "b/two",
        // getErrorName is empty for a bare {message} error -> the helper falls
        // back to the message's first line.
        error_name: "You've hit your session limit · resets 6pm",
        error_class: "terminal",
        cooldown_until: record.event?.cooldown_until ?? null,
        reason: "retry",
      });
      // Per-model override (300s) beats the global (60s): the cooldown_until
      // must sit ~300s in the future, not ~60s.
      const untilRaw = record.event?.cooldown_until;
      expect(typeof untilRaw).toBe("string");
      const until = Date.parse(untilRaw as string);
      const deltaSeconds = (until - Date.now()) / 1000;
      expect(deltaSeconds).toBeGreaterThan(290);
      expect(deltaSeconds).toBeLessThanOrEqual(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("second failure inside the per-model window leaves that link unselected", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const config = parseFallbackConfig({
        enabled: true,
        models: ["a/one", "b/two"],
        cooldown_seconds: 60,
        cooldown_seconds_by_model: { "a/one": 300 },
      });

      // First failure: a/one (primary) -> rotates to b/two, a/one cools 300s.
      const first = clientWith([userTurn("a/one")]);
      const d1 = await dispatchFallback(
        first.client as never,
        config,
        "tel-2",
        TERMINAL_ERROR,
        undefined,
        logger,
      );
      expect(d1.retry).toBe(true);
      expect(d1.model).toBe("b/two");

      // Second failure (b/two dies, the resubmitted turn ran on b/two):
      // a/one is still inside its 300s window -> not selected -> exhausted.
      const second = clientWith([userTurn("b/two")]);
      const d2 = await dispatchFallback(
        second.client as never,
        config,
        "tel-2",
        TERMINAL_ERROR,
        "b/two",
        logger,
      );
      expect(d2.retry).toBe(false);
      expect(d2.reason).toBe("chain-exhausted");
      logger.close();

      // Exactly ONE fallback record: the exhausted decision wrote nothing.
      const lines = readLines(jsonlFile(dir));
      expect(lines).toHaveLength(1);
      expect((lines[0] as TelemetryRecord).event?.to_model).toBe("b/two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("after the per-model window the link is selectable again (mock clock)", () => {
    const config = parseFallbackConfig({
      enabled: true,
      models: ["a/one", "b/two"],
      cooldown_seconds: 60,
      cooldown_seconds_by_model: { "a/one": 300 },
    });

    // Mock clock: arm a/one's window 301s in the past -> expired.
    const now = Date.now();
    markModelCooldown("tel-3", "a/one", 300, now - 301_000);
    expect(isModelCoolingDown("tel-3", "a/one", now)).toBe(false);

    const decision = decideFallback(
      config,
      "tel-3",
      TERMINAL_ERROR,
      undefined,
      "b/two",
      "b/two",
    );
    expect(decision.retry).toBe(true);
    expect(decision.model).toBe("a/one");
    expect(decision.chain_index).toBe(0);
  });

  test("model without a per-model entry uses the global cooldown", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const config = parseFallbackConfig({
        enabled: true,
        models: ["a/one", "b/two"],
        cooldown_seconds: 60,
        // Per-model entry only for a/one; b/two must fall back to the global.
        cooldown_seconds_by_model: { "a/one": 300 },
      });

      // a/one (primary) fails -> rotates to b/two.
      const first = clientWith([userTurn("a/one")]);
      await dispatchFallback(first.client as never, config, "tel-4", TERMINAL_ERROR, undefined, logger);

      // b/two fails immediately -> rotates back toward a/one? No: a/one is
      // cooling (300s) AND b/two is current/lastUsed -> exhausted. Instead
      // verify the GLOBAL window on a fresh session: b/two as primary fails
      // -> rotates to a/one -> b/two's cooldown must be the global 60s.
      const second = clientWith([userTurn("b/two")]);
      const d2 = await dispatchFallback(
        second.client as never,
        config,
        "tel-4g",
        TERMINAL_ERROR,
        undefined,
        logger,
      );
      expect(d2.retry).toBe(true);
      expect(d2.model).toBe("a/one");
      logger.close();

      const lines = readLines(jsonlFile(dir));
      expect(lines).toHaveLength(2);
      // lines[0] = tel-4 (a/one failed, per-model 300s); lines[1] = tel-4g
      // (b/two failed, no per-model entry -> global 60s).
      const record = lines[1] as TelemetryRecord;
      expect(record.event?.from_model).toBe("b/two");
      const untilRaw = record.event?.cooldown_until;
      expect(typeof untilRaw).toBe("string");
      const until = Date.parse(untilRaw as string);
      const deltaSeconds = (until - Date.now()) / 1000;
      // Global 60s (not the 300s per-model entry, which belongs to a/one).
      expect(deltaSeconds).toBeGreaterThan(50);
      expect(deltaSeconds).toBeLessThanOrEqual(60);

      // And the global window really blocks: b/two is not selectable right
      // now on tel-4g, but is after the 60s window (mock clock at the
      // registry boundary).
      expect(isModelCoolingDown("tel-4g", "b/two")).toBe(true);
      markModelCooldown("tel-4g", "b/two", 60, Date.now() - 61_000);
      expect(isModelCoolingDown("tel-4g", "b/two")).toBe(false);
      const after = decideFallback(
        config,
        "tel-4g",
        TERMINAL_ERROR,
        undefined,
        "a/one",
        "a/one",
      );
      expect(after.retry).toBe(true);
      expect(after.model).toBe("b/two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("terminal vs transient error_class mapping", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const config = parseFallbackConfig({
        enabled: true,
        models: ["a/one", "b/two"],
        cooldown_seconds: 0,
        // Rotate immediately on transient errors too.
        same_model_max_retries: 0,
      });

      const terminal = clientWith([userTurn("a/one")]);
      const d1 = await dispatchFallback(
        terminal.client as never,
        config,
        "tel-5",
        TERMINAL_ERROR,
        undefined,
        logger,
      );
      expect(d1.retry).toBe(true);

      const transient = clientWith([userTurn("b/two")]);
      const d2 = await dispatchFallback(
        transient.client as never,
        config,
        "tel-5",
        TRANSIENT_ERROR,
        "b/two",
        logger,
      );
      expect(d2.retry).toBe(true);
      logger.close();

      const lines = readLines(jsonlFile(dir));
      expect(lines.map((line) => (line as TelemetryRecord).event?.error_class)).toEqual([
        "terminal",
        "transient",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-retryable error -> no fallback record (no noise)", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const { client } = clientWith([userTurn("a/one")]);
      const config = parseFallbackConfig({
        enabled: true,
        models: ["a/one", "b/two"],
        cooldown_seconds: 60,
      });

      const decision = await dispatchFallback(
        client as never,
        config,
        "tel-6",
        { message: "invalid api key" },
        undefined,
        logger,
      );
      expect(decision.retry).toBe(false);
      expect(decision.reason).toBe("not-retryable");
      logger.close();

      expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cooldown_until is null when the effective cooldown is 0", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const { client } = clientWith([userTurn("a/one")]);
      const config = parseFallbackConfig({
        enabled: true,
        models: ["a/one", "b/two"],
        cooldown_seconds: 0,
      });

      await dispatchFallback(client as never, config, "tel-7", TERMINAL_ERROR, undefined, logger);
      logger.close();

      const lines = readLines(jsonlFile(dir));
      expect((lines[0] as TelemetryRecord).event?.cooldown_until).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("error_name prefers the error's name, then the message's first line", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const config = parseFallbackConfig({
        enabled: true,
        models: ["a/one", "b/two"],
        cooldown_seconds: 0,
        // Rotate immediately on transient errors too.
        same_model_max_retries: 0,
      });

      const named = clientWith([userTurn("a/one")]);
      await dispatchFallback(
        named.client as never,
        config,
        "tel-8",
        { name: "RateLimitError", message: "slow down" },
        undefined,
        logger,
      );

      const unnamed = clientWith([userTurn("b/two")]);
      await dispatchFallback(
        unnamed.client as never,
        config,
        "tel-8b",
        { message: "HTTP 502 bad gateway\ndetails..." },
        undefined,
        logger,
      );
      logger.close();

      const lines = readLines(jsonlFile(dir));
      expect((lines[0] as TelemetryRecord).event?.error_name).toBe("RateLimitError");
      expect((lines[1] as TelemetryRecord).event?.error_name).toBe("HTTP 502 bad gateway");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cooldown registry", () => {
  beforeEach(() => {
    clearAllModelCooldowns();
  });

  test("mark + expiry via injected now (mock clock)", () => {
    const now = 1_000_000_000;
    const until = markModelCooldown("s", "A/One", 300, now);
    expect(until).toBe(now + 300_000);
    expect(isModelCoolingDown("s", "a/one", now + 299_999)).toBe(true);
    // Lookup is case-insensitive and trim-tolerant on both sides (checked
    // before the expiry probe below, whose lazy-delete drops the entry).
    expect(isModelCoolingDown("s", "  A/ONE ", now + 1)).toBe(true);
    expect(modelCooldownRemainingSeconds("s", "a/one", now + 100)).toBeCloseTo(299.9, 1);
    // Expiry probe last: an expired lookup lazy-deletes the entry.
    expect(isModelCoolingDown("s", "a/one", now + 300_000)).toBe(false);
  });

  test("zero-seconds mark never blocks", () => {
    const now = 1_000_000_000;
    markModelCooldown("s", "a/one", 0, now);
    expect(isModelCoolingDown("s", "a/one", now)).toBe(false);
  });

  test("unknown session/model never blocks", () => {
    expect(isModelCoolingDown("nope", "a/one")).toBe(false);
    expect(modelCooldownRemainingSeconds("nope", "a/one")).toBe(0);
  });

  test("re-marking refreshes the window", () => {
    const now = 1_000_000_000;
    markModelCooldown("s", "a/one", 60, now);
    markModelCooldown("s", "a/one", 60, now + 30_000);
    expect(isModelCoolingDown("s", "a/one", now + 89_999)).toBe(true);
    expect(isModelCoolingDown("s", "a/one", now + 90_001)).toBe(false);
  });
});

describe("cooldownSecondsFor precedence", () => {
  test("per-model override beats the global; absent entry uses the global", () => {
    const config = parseFallbackConfig({
      enabled: true,
      cooldown_seconds: 60,
      cooldown_seconds_by_model: { "A/One": 300, "c/three": 0 },
    });
    expect(cooldownSecondsFor(config, "a/one")).toBe(300);
    expect(cooldownSecondsFor(config, "A/ONE")).toBe(300);
    expect(cooldownSecondsFor(config, "b/two")).toBe(60);
    expect(cooldownSecondsFor(config, undefined)).toBe(60);
    // Explicit 0 is a valid override (disables the cooldown for that model).
    expect(cooldownSecondsFor(config, "c/three")).toBe(0);
  });
});

describe("parseFallbackConfig cooldown_seconds_by_model", () => {
  test("valid entries survive, keys are lowercased", () => {
    const parsed = parseFallbackConfig({
      enabled: true,
      cooldown_seconds_by_model: { "A/One": 300, "b/two": 0 },
    });
    expect(parsed.cooldown_seconds_by_model).toEqual({ "a/one": 300, "b/two": 0 });
  });

  test("invalid entries are dropped, never fatal", () => {
    const parsed = parseFallbackConfig({
      enabled: true,
      cooldown_seconds_by_model: {
        "ok/one": 5,
        "negative/two": -3,
        // asNonNegativeInt discipline: finite non-negative numbers are floored
        // to ints, so 1.5 is a valid 1.
        "float/three": 1.5,
        "no-slash": 10,
        "": 10,
        "garbage/four": "lots",
      },
    });
    expect(parsed.cooldown_seconds_by_model).toEqual({ "ok/one": 5, "float/three": 1 });
  });

  test("non-object input yields an empty map; camelCase alias accepted", () => {
    expect(parseFallbackConfig({ cooldown_seconds_by_model: "nope" }).cooldown_seconds_by_model).toEqual({});
    expect(parseFallbackConfig(undefined).cooldown_seconds_by_model).toEqual({});
    const camel = parseFallbackConfig({ cooldownSecondsByModel: { "a/one": 7 } });
    expect(camel.cooldown_seconds_by_model).toEqual({ "a/one": 7 });
  });
});

describe("decideFallback chain_index", () => {
  beforeEach(() => {
    clearAll();
    clearAllSessionModels();
    clearAllModelCooldowns();
  });

  test("pick path reports the selected link's chain position", () => {
    const config = parseFallbackConfig({
      enabled: true,
      models: ["a/one", "b/two", "c/three"],
      cooldown_seconds: 0,
    });
    const decision = decideFallback(config, "ci-1", TERMINAL_ERROR, undefined, "a/one");
    expect(decision.retry).toBe(true);
    expect(decision.model).toBe("b/two");
    expect(decision.chain_index).toBe(1);
  });

  test("snap-back resume reports the resumed link's chain position", () => {
    const config = parseFallbackConfig({
      enabled: true,
      models: ["a/one", "b/two", "c/three"],
      cooldown_seconds: 0,
    });
    // Simulate a session that rotated to b/two, then the client snapped back
    // to the primary a/one, which failed again.
    recordAttempt("ci-2", "b/two");
    const decision = decideFallback(
      config,
      "ci-2",
      TERMINAL_ERROR,
      undefined,
      "a/one",
      "a/one",
    );
    expect(decision.retry).toBe(true);
    expect(decision.model).toBe("b/two");
    expect(decision.chain_index).toBe(1);
    expect(getLastFallbackModel("ci-2")).toBe("b/two");
  });

  test("non-retry decisions carry no chain_index", () => {
    const config = parseFallbackConfig({
      enabled: true,
      models: ["a/one"],
      cooldown_seconds: 0,
    });
    const decision = decideFallback(config, "ci-3", { message: "invalid api key" });
    expect(decision.retry).toBe(false);
    expect(decision.chain_index).toBeUndefined();
  });
});
