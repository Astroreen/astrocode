// Plan T10 tests: deterministic prune (pure layer), the stateful transform
// orchestrator (cache-epoch enforcement), the skip-if-frozen runner rule and
// the double-compaction end-to-end flow over mock seams.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addRegionHash,
  compactionStateSnapshot,
  consumeEpochDirty,
  markGuardConflictReported,
  markStubbedPart,
  resetCompactionState,
  setEpochDirty,
  setSummaryAnchor,
  setSummaryFrozen,
  setSummarySha256,
  stubbedPartHash,
  REGION_HASH_LIMIT,
} from "../src/compaction/state";
import {
  findMessageIndexById,
  isCompletedToolPart,
  isPruneStub,
  PRUNE_MARKER,
  PRUNE_TAIL_MESSAGES,
  PRUNE_TAIL_PARTS,
  pruneStub,
  pruneToolResults,
  SUMMARY_MARKER,
  SUMMARY_MESSAGE_ID,
  summaryAnchorId,
  summaryPartText,
  type PruneMessage,
} from "../src/compaction/prune";
import { applyCompactionTransform } from "../src/compaction/transform";
import { maybeCompact } from "../src/compaction/run";
import { sha256Hex } from "../src/prompts/freeze";
import {
  createTelemetryLogger,
  type TelemetryRecord,
} from "../src/telemetry/log";
import type {
  MessageEntry,
  SummarizerClient,
} from "../src/compaction/summarize";

afterEach(() => {
  resetCompactionState();
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astrocode-compaction-prune-"));
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

// ---------------------------------------------------------------------------
// Message factories (structural — no SDK imports needed)
// ---------------------------------------------------------------------------

function toolPart(id: string, output: string): Record<string, unknown> {
  return {
    id,
    sessionID: "ses",
    messageID: "m",
    type: "tool",
    callID: id,
    tool: "bash",
    state: {
      status: "completed",
      output,
      input: {},
      title: "bash",
      metadata: {},
      time: { start: 0, end: 0 },
    },
  };
}

function textPart(id: string, text: string): Record<string, unknown> {
  return { id, sessionID: "ses", messageID: "m", type: "text", text, synthetic: false };
}

function message(
  id: string,
  role: "user" | "assistant",
  parts: unknown[],
): PruneMessage {
  return { info: { id, role, sessionID: "ses" }, parts };
}

/** 5 messages x 4 tool parts = 20 parts; deterministic ids p0..p19. */
function storage(): PruneMessage[] {
  const messages: PruneMessage[] = [];
  let partIndex = 0;
  for (let m = 0; m < 5; m += 1) {
    let role: "user" | "assistant" = "user";
    if (m % 2 !== 0) role = "assistant";
    const parts: unknown[] = [];
    for (let p = 0; p < 4; p += 1) {
      parts.push(toolPart(`p${partIndex}`, `output ${partIndex} `.repeat(30)));
      partIndex += 1;
    }
    messages.push(message(`m${m}`, role, parts));
  }
  return messages;
}

function serialize(messages: readonly PruneMessage[]): string {
  return JSON.stringify(messages);
}

const CFG = { enabled: true, prune_stub_chars: 200 } as const;

// ---------------------------------------------------------------------------
// T10.1 — pure prune
// ---------------------------------------------------------------------------

describe("pruneStub bytes", () => {
  test("exact stub format and marker detection", () => {
    expect(pruneStub("hello world", 5)).toBe("hello\n[pruned by astrocode]");
    expect(PRUNE_MARKER).toBe("[pruned by astrocode]");
    expect(isPruneStub(pruneStub("x", 200))).toBe(true);
    expect(isPruneStub("plain output")).toBe(false);
    // chars are floored and guarded
    expect(pruneStub("abcdef", 2.9)).toBe("ab\n[pruned by astrocode]");
    expect(pruneStub("abc", 0)).toBe("\n[pruned by astrocode]");
  });

  test("summary part text wraps with the exact marker", () => {
    expect(summaryPartText("S")).toBe("<!-- astrocode:summary -->\nS");
    expect(SUMMARY_MARKER).toBe("<!-- astrocode:summary -->");
  });
});

describe("pruneToolResults eligibility", () => {
  test("only completed tool-result parts are stubbed", () => {
    const messages: PruneMessage[] = [];
    for (let i = 0; i < 4; i += 1) {
      messages.push(
        message(`m${i}`, "user", [
          textPart(`t${i}`, `user text ${i}`),
          toolPart(`p${i}`, `tool output ${i} padding `.repeat(20)),
          {
            id: `e${i}`,
            type: "tool",
            state: { status: "error", error: "boom", input: {} },
          },
          {
            id: `r${i}`,
            type: "tool",
            state: { status: "running", input: {} },
          },
        ]),
      );
    }
    const before = serialize(messages);
    const report = pruneToolResults(messages, 200, true, {
      hashes: new Set(),
      parts: new Map(),
    });
    // 16 messages-window: messageCut = 2, partCut = 16 - 10 = 6.
    // Eligible tool parts: m0 (indices 1 < 6? global index of p0 is 1) yes;
    // p1 global 5 < 6 yes; p2 global 9 >= 6 no; p3 global 13 no.
    expect(report.fresh.map((s) => s.part_id)).toEqual(["p0", "p1"]);
    expect(serialize(messages)).not.toBe(before);
    // Text parts and error/running tool states untouched.
    const m0 = messages[0]?.parts ?? [];
    expect((m0[0] as Record<string, unknown>).text).toBe("user text 0");
    expect((m0[2] as Record<string, unknown>).state).toEqual({
      status: "error",
      error: "boom",
      input: {},
    });
  });

  test("boundaries: part #9 eligible vs #10 not; message age 3 eligible vs 2 not", () => {
    // 5 messages x 4 parts = 20 parts; messageCut = 3, partCut = 10.
    const messages = storage();
    const report = pruneToolResults(messages, 200, true, {
      hashes: new Set(),
      parts: new Map(),
    });
    const ids = report.fresh.map((s) => s.part_id);
    // Global indices 0..9 = p0..p9 (message 0: p0-p3, message 1: p4-p7,
    // message 2: p8-p11 -> p8, p9 eligible; p10, p11 outside the window).
    expect(ids).toEqual([
      "p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9",
    ]);
    expect(ids).toContain("p9");
    expect(ids).not.toContain("p10");
    // Message 2 (index 2, age 3 from the end) contributed; message 3
    // (age exactly 2, parts p12..p15) did not.
    expect(ids).toContain("p8");
    for (const id of ["p12", "p13", "p14", "p15"]) {
      expect(ids).not.toContain(id);
    }
    expect(PRUNE_TAIL_MESSAGES).toBe(2);
    expect(PRUNE_TAIL_PARTS).toBe(10);
  });

  test("short history: nothing eligible inside the tail windows", () => {
    const messages: PruneMessage[] = [
      message("m0", "user", [toolPart("p0", "out")]),
      message("m1", "assistant", [toolPart("p1", "out")]),
    ];
    const before = serialize(messages);
    const report = pruneToolResults(messages, 200, true, {
      hashes: new Set(),
      parts: new Map(),
    });
    expect(report.fresh).toEqual([]);
    expect(serialize(messages)).toBe(before);
  });
});

describe("pruneToolResults idempotency + guard", () => {
  test("prune(prune(x)) === prune(x) via marker detection (fresh guards)", () => {
    const messages = storage();
    pruneToolResults(messages, 200, true, { hashes: new Set(), parts: new Map() });
    const once = serialize(messages);
    // Second pass over the ALREADY-STUBBED array with empty guards: the
    // marker skips every stubbed part; nothing else is eligible-new because
    // allowNewStubs only affects uncovered parts and all tool parts now
    // carry the marker.
    pruneToolResults(messages, 200, true, { hashes: new Set(), parts: new Map() });
    expect(serialize(messages)).toBe(once);
  });

  test("prune(prune(x)) === prune(x) via hash guard (rebuilt view)", () => {
    const original = storage();
    const first = JSON.parse(serialize(original)) as PruneMessage[];
    const report = pruneToolResults(first, 200, true, {
      hashes: new Set(),
      parts: new Map(),
    });
    const guards = {
      hashes: new Set(report.fresh.map((s) => s.stub_sha256)),
      parts: new Map(report.fresh.map((s) => [s.part_id, s.stub_sha256])),
    };
    const once = serialize(first);

    // Simulate the next request rebuild: fresh deep copy of storage, same
    // guards -> maintenance re-stub, byte-identical output.
    const second = JSON.parse(serialize(original)) as PruneMessage[];
    const report2 = pruneToolResults(second, 200, false, guards);
    expect(report2.fresh).toEqual([]);
    expect(report2.conflicts).toEqual([]);
    expect(report2.applied).toHaveLength(report.fresh.length);
    expect(serialize(second)).toBe(once);

    // Third pass over the already-stubbed view: marker skip, still identical.
    pruneToolResults(second, 200, true, guards);
    expect(serialize(second)).toBe(once);
  });

  test("stub hash is sha256 of the exact stub bytes", () => {
    const messages: PruneMessage[] = [
      message("m0", "user", [toolPart("p0", "abcdef")]),
      message("m1", "assistant", [toolPart("p1", "x")]),
      message("m2", "user", [toolPart("p2", "y")]),
      message("m3", "assistant", [toolPart("p3", "z")]),
    ];
    // 4 tool parts + a 10-text-part tail = 14 parts -> partCut = 4;
    // messageCut = 3 (5 messages). p0/p1/p2 pass both gates; p3 sits in
    // message m3 (age exactly 2) -> excluded by the message-age gate.
    messages.push(
      message(
        "m4",
        "user",
        Array.from({ length: 10 }, (_, i) => textPart(`pad${i}`, "pad")),
      ),
    );
    const report = pruneToolResults(messages, 3, true, {
      hashes: new Set(),
      parts: new Map(),
    });
    expect(report.fresh.map((s) => s.part_id)).toEqual(["p0", "p1", "p2"]);
    expect(report.fresh[0]?.stub_sha256).toBe(
      sha256Hex("abc\n[pruned by astrocode]"),
    );
    expect((messages[0]?.parts?.[0] as Record<string, unknown>).state).toEqual({
      status: "completed",
      output: "abc\n[pruned by astrocode]",
      input: {},
      title: "bash",
      metadata: {},
      time: { start: 0, end: 0 },
    });
  });

  test("guard conflict: covered part rewritten -> untouched + conflict reported", () => {
    const messages = storage();
    const report = pruneToolResults(messages, 200, true, {
      hashes: new Set(),
      parts: new Map(),
    });
    const guards = {
      hashes: new Set(report.fresh.map((s) => s.stub_sha256)),
      parts: new Map(report.fresh.map((s) => [s.part_id, s.stub_sha256])),
    };

    // Someone rewrites a covered part's bytes in storage.
    const mutated = JSON.parse(serialize(storage())) as PruneMessage[];
    const target = mutated[0]?.parts?.[0];
    expect(isCompletedToolPart(target)).toBe(true);
    if (isCompletedToolPart(target)) target.state.output = "REWRITTEN BY HOST";
    const before = serialize(mutated);

    const report2 = pruneToolResults(mutated, 200, true, guards);
    expect(report2.conflicts).toEqual(["p0"]);
    expect(report2.applied.every((s) => s.part_id !== "p0")).toBe(true);
    // The rewritten part was NOT touched; everything else re-stubbed.
    if (isCompletedToolPart(target)) {
      expect(target.state.output).toBe("REWRITTEN BY HOST");
    }
    expect(serialize(mutated)).not.toBe(before);
    const other = mutated[0]?.parts?.[1];
    if (isCompletedToolPart(other)) {
      expect(isPruneStub(other.state.output)).toBe(true);
    }
  });

  test("allowNewStubs=false leaves uncovered parts untouched", () => {
    const messages = storage();
    const before = serialize(messages);
    const report = pruneToolResults(messages, 200, false, {
      hashes: new Set(),
      parts: new Map(),
    });
    expect(report.applied).toEqual([]);
    expect(report.fresh).toEqual([]);
    expect(serialize(messages)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// T10 state additions
// ---------------------------------------------------------------------------

describe("compaction state T10 additions", () => {
  test("epoch_dirty set/consume semantics", () => {
    expect(consumeEpochDirty("s-epoch")).toBe(false);
    setEpochDirty("s-epoch", true);
    expect(compactionStateSnapshot("s-epoch").epoch_dirty).toBe(true);
    expect(consumeEpochDirty("s-epoch")).toBe(true);
    expect(compactionStateSnapshot("s-epoch").epoch_dirty).toBe(false);
    expect(consumeEpochDirty("s-epoch")).toBe(false);
  });

  test("stubbed parts bounded, oldest dropped", () => {
    for (let i = 0; i < REGION_HASH_LIMIT + 10; i += 1) {
      markStubbedPart("s-parts", `part-${i}`, `hash-${i}`);
    }
    expect(stubbedPartHash("s-parts", `part-${REGION_HASH_LIMIT + 9}`)).toBe(
      `hash-${REGION_HASH_LIMIT + 9}`,
    );
    expect(stubbedPartHash("s-parts", "part-0")).toBeUndefined();
    expect(stubbedPartHash("s-parts", "part-9")).toBeUndefined();
    expect(stubbedPartHash("s-parts", "part-10")).toBe("hash-10");
    expect(Object.keys(compactionStateSnapshot("s-parts").stubbed_parts)).toHaveLength(
      REGION_HASH_LIMIT,
    );
  });

  test("guard conflict reporting dedups per part", () => {
    expect(markGuardConflictReported("s-conf", "p1")).toBe(true);
    expect(markGuardConflictReported("s-conf", "p1")).toBe(false);
    expect(markGuardConflictReported("s-conf", "p2")).toBe(true);
    expect(compactionStateSnapshot("s-conf").guard_conflicts_reported).toEqual([
      "p1",
      "p2",
    ]);
  });

  test("summary anchor/sha set + clearSummaryFreeze drops all three", () => {
    setSummaryFrozen("s-sum", "text");
    setSummarySha256("s-sum", "abc");
    setSummaryAnchor("s-sum", "m3");
    let snap = compactionStateSnapshot("s-sum");
    expect(snap.summary_frozen).toBe("text");
    expect(snap.summary_sha256).toBe("abc");
    expect(snap.summary_anchor_id).toBe("m3");
    // addRegionHash still feeds the flat guard list
    addRegionHash("s-sum", "region-hash");
    expect(snap.region_hashes).toEqual([]);
    snap = compactionStateSnapshot("s-sum");
    expect(snap.region_hashes).toEqual(["region-hash"]);
    setSummaryAnchor("s-sum", "");
    expect(compactionStateSnapshot("s-sum").summary_anchor_id).toBe("m3");
    setSummarySha256("s-sum", "");
    expect(compactionStateSnapshot("s-sum").summary_sha256).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// T10.2/T10.3 — transform orchestrator
// ---------------------------------------------------------------------------

describe("applyCompactionTransform", () => {
  test("disabled config -> strict pass-through", () => {
    const messages = storage();
    const before = serialize(messages);
    applyCompactionTransform(messages, {
      cfg: { enabled: false, prune_stub_chars: 200 },
      telemetry: createTelemetryLogger({ enabled: false }),
    });
    expect(serialize(messages)).toBe(before);
  });

  test("no compaction state -> byte-identical pass-through", () => {
    const messages = storage();
    const before = serialize(messages);
    applyCompactionTransform(messages, {
      cfg: CFG,
      telemetry: createTelemetryLogger({ enabled: false }),
    });
    expect(serialize(messages)).toBe(before);
  });

  test("epoch break: prune + single summary injection + flag consumed", () => {
    const session = "ses-break";
    setSummaryFrozen(session, "## Goal\nfinish T10");
    setEpochDirty(session, true);
    const messages = storage();
    const before = serialize(messages);

    applyCompactionTransform(messages, { cfg: CFG, telemetry: createTelemetryLogger({ enabled: false }), sessionID: session });

    // Prune happened (eligible parts stubbed).
    const firstTool = messages[0]?.parts?.[0];
    expect(isCompletedToolPart(firstTool) && isPruneStub(firstTool.state.output)).toBe(true);
    // Tail parts untouched.
    const lastMsg = messages[messages.length - 1];
    const lastTool = lastMsg?.parts?.[lastMsg.parts.length - 1];
    expect(isCompletedToolPart(lastTool) && isPruneStub(lastTool.state.output)).toBe(false);

    // Exactly one summary part, placed before the tail anchor (m3).
    const summaryIndex = findMessageIndexById(messages, SUMMARY_MESSAGE_ID);
    expect(summaryIndex).toBe(3);
    const summaryMessage = messages[summaryIndex];
    expect(summaryMessage?.info?.role).toBe("user");
    const summaryPart = summaryMessage?.parts?.[0] as Record<string, unknown>;
    expect(summaryPart.text).toBe("<!-- astrocode:summary -->\n## Goal\nfinish T10");
    expect(summaryPart.synthetic).toBe(true);

    // Flag consumed; anchor + sha frozen.
    const snap = compactionStateSnapshot(session);
    expect(snap.epoch_dirty).toBe(false);
    expect(snap.summary_anchor_id).toBe("m3");
    expect(snap.summary_sha256).toBe(
      sha256Hex("<!-- astrocode:summary -->\n## Goal\nfinish T10"),
    );
    expect(snap.region_hashes.length).toBeGreaterThan(0);
    expect(serialize(messages)).not.toBe(before);
  });

  test("maintenance pass: byte-identical prefix, exactly one summary part", () => {
    const session = "ses-maint";
    setSummaryFrozen(session, "frozen summary");
    setEpochDirty(session, true);
    const original = storage();

    const firstView = JSON.parse(serialize(original)) as PruneMessage[];
    applyCompactionTransform(firstView, { cfg: CFG, telemetry: createTelemetryLogger({ enabled: false }), sessionID: session });
    const firstBytes = serialize(firstView);

    // History grew by one turn; NO new epoch break.
    const grown = JSON.parse(serialize(original)) as PruneMessage[];
    grown.push(
      message("m5", "user", [textPart("t5", "next turn"), toolPart("p20", "new output")]),
    );
    applyCompactionTransform(grown, { cfg: CFG, telemetry: createTelemetryLogger({ enabled: false }), sessionID: session });

    // Shared prefix byte-identical (the provider-cacheable property).
    expect(serialize(grown.slice(0, firstView.length))).toBe(firstBytes);
    // The new turn's tool output was NOT pruned (no epoch break).
    const newTool = grown[grown.length - 1]?.parts?.[1];
    expect(isCompletedToolPart(newTool) && isPruneStub(newTool.state.output)).toBe(false);
    // Still exactly one summary part.
    const markers = countSummaryMarkers(grown);
    expect(markers).toBe(1);
  });

  test("guard conflict through the orchestrator: one record, part untouched", () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const session = "ses-conflict";
      // Freeze a guard for p0 with the hash of the ORIGINAL stub bytes
      // (storage() builds p0's output as "output 0 ".repeat(30)).
      const originalStub = pruneStub("output 0 ".repeat(30), 200);
      addRegionHash(session, sha256Hex(originalStub));
      markStubbedPart(session, "p0", sha256Hex(originalStub));

      // Storage now holds rewritten bytes for p0.
      const messages = storage();
      const target = messages[0]?.parts?.[0];
      if (isCompletedToolPart(target)) target.state.output = "REWRITTEN";

      applyCompactionTransform(messages, { cfg: CFG, telemetry: logger, sessionID: session });
      applyCompactionTransform(messages, { cfg: CFG, telemetry: logger, sessionID: session });
      logger.close();

      if (isCompletedToolPart(target)) {
        expect(target.state.output).toBe("REWRITTEN");
      }
      const records = readRecords(dir).filter((r) => r.kind === "compaction");
      expect(records).toHaveLength(1);
      expect(records[0]?.event?.outcome).toBe("error");
      expect(records[0]?.event?.source).toBe("guard_conflict");
      expect(compactionStateSnapshot(session).guard_conflicts_reported).toEqual(["p0"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("anchor missing -> freeze dropped, no injection, no crash", () => {
    const session = "ses-gone";
    setSummaryFrozen(session, "text");
    setSummaryAnchor(session, "missing-message");
    const messages = storage();
    applyCompactionTransform(messages, { cfg: CFG, telemetry: createTelemetryLogger({ enabled: false }), sessionID: session });
    const snap = compactionStateSnapshot(session);
    expect(snap.summary_frozen).toBeUndefined();
    expect(snap.summary_anchor_id).toBeUndefined();
    expect(findMessageIndexById(messages, SUMMARY_MESSAGE_ID)).toBe(-1);
  });

  test("epoch break without a frozen summary: prune only, no injection", () => {
    const session = "ses-prune-only";
    setEpochDirty(session, true);
    const messages = storage();
    applyCompactionTransform(messages, { cfg: CFG, telemetry: createTelemetryLogger({ enabled: false }), sessionID: session });
    expect(findMessageIndexById(messages, SUMMARY_MESSAGE_ID)).toBe(-1);
    const firstTool = messages[0]?.parts?.[0];
    expect(isCompletedToolPart(firstTool) && isPruneStub(firstTool.state.output)).toBe(true);
    expect(compactionStateSnapshot(session).epoch_dirty).toBe(false);
  });

  test("summary anchor is the first message of the tail window", () => {
    const messages = storage();
    expect(summaryAnchorId(messages)).toBe("m3");
    expect(summaryAnchorId(messages.slice(0, 2))).toBe("m0");
    expect(summaryAnchorId([])).toBeUndefined();
  });
});

function countSummaryMarkers(messages: readonly PruneMessage[]): number {
  let count = 0;
  for (const message of messages) {
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (
        !!part &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string" &&
        ((part as Record<string, unknown>).text as string).includes(SUMMARY_MARKER)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// T10.3 — runner skip-if-frozen + double-compaction e2e
// ---------------------------------------------------------------------------

interface MockCounts {
  summarize: number;
  create: number;
  prompt: number;
  messages: number;
}

function scratchClient(promptText: string): SummarizerClient & { counts: MockCounts } {
  const counts: MockCounts = { summarize: 0, create: 0, prompt: 0, messages: 0 };
  let scratch = 0;
  return {
    counts,
    session: {
      summarize: async () => {
        counts.summarize += 1;
        return { data: true };
      },
      create: async () => {
        counts.create += 1;
        scratch += 1;
        return { data: { id: `scratch-${scratch}` } };
      },
      prompt: async () => {
        counts.prompt += 1;
        return {
          data: { info: {}, parts: [{ type: "text", text: promptText }] },
        };
      },
      messages: async () => {
        counts.messages += 1;
        const entries: MessageEntry[] = [
          { info: { role: "user" }, parts: [{ type: "text", text: "work" }] },
        ];
        return { data: entries };
      },
      delete: async () => ({ data: true }),
    },
    provider: {
      list: async () => ({ data: { all: [] } }),
    },
  };
}

const RUN_CFG = {
  enabled: true,
  trigger_ratio: 0.8,
  context_window: 1000,
  context_windows: {},
  cooldown_seconds: 0,
};

// A reply that passes the T11 validateSummary gate (>= 200 chars, all three
// section headers) — the e2e scratch summarizer must SUCCEED on attempt 1.
const VALID_SUMMARY =
  "## Goal\n" +
  "Compact the finished region and keep the session going without losing " +
  "the thread of the work.\n" +
  "## State\n" +
  "The engine froze this three-section summary at the epoch break; the " +
  "pruned tool outputs below still carry the exact byte-level detail.\n" +
  "## Next\n" +
  "Continue the session from the user request.";

function runUsage() {
  return {
    model: "openrouter/xiaomi/mimo-v2.6-pro",
    input: 900,
    cache_read: 0,
    cache_write: 0,
  };
}

describe("maybeCompact skip-if-frozen (T10.3)", () => {
  test("frozen summary -> skipped, zero summarizer calls, cooldown stamped", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = scratchClient("summary text");
      setSummaryFrozen("ses-skip", "frozen");

      const first = await maybeCompact(client, logger, RUN_CFG, "ses-skip", runUsage(), "turn_boundary");
      expect(first).toEqual({ ran: false, reason: "already-compacted" });
      expect(client.counts.prompt).toBe(0);
      expect(client.counts.summarize).toBe(0);

      // Cooldown stamped on the skip: an immediate re-evaluation is blocked.
      const second = await maybeCompact(client, logger, { ...RUN_CFG, cooldown_seconds: 300 }, "ses-skip", runUsage(), "session_idle");
      expect(second).toEqual({ ran: false, reason: "cooldown" });

      logger.close();
      const records = readRecords(dir).filter((r) => r.kind === "compaction");
      expect(records).toHaveLength(1);
      expect(records[0]?.event?.outcome).toBe("skipped");
      expect(records[0]?.event?.source).toBe("turn_boundary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("double-compaction end-to-end (T10.3)", () => {
  test("one summary part, second run skipped, no second summarizer call", async () => {
    const dir = tempDir();
    try {
      const logger = createTelemetryLogger({ dir });
      const client = scratchClient(VALID_SUMMARY);
      const session = "ses-e2e";

      // Epoch 1: compaction runs (scratch summarizer called once).
      const run1 = await maybeCompact(client, logger, RUN_CFG, session, runUsage(), "turn_boundary");
      expect(run1.ran).toBe(true);
      expect(run1.outcome?.path).toBe("scratch");
      expect(client.counts.prompt).toBe(1);

      // First transform after the run: epoch break applies.
      const original = storage();
      const view1 = JSON.parse(serialize(original)) as PruneMessage[];
      applyCompactionTransform(view1, { cfg: CFG, telemetry: logger, sessionID: session });
      expect(countSummaryMarkers(view1)).toBe(1);
      const bytes1 = serialize(view1);

      // Second compaction attempt on the same region: skipped WITHOUT
      // regenerating (mock count stays 1).
      const run2 = await maybeCompact(client, logger, RUN_CFG, session, runUsage(), "session_idle");
      expect(run2).toEqual({ ran: false, reason: "already-compacted" });
      expect(client.counts.prompt).toBe(1);
      expect(client.counts.create).toBe(1);

      // Second transform (rebuilt view + one more turn): byte-identical
      // prefix, still exactly one summary part.
      const grown = JSON.parse(serialize(original)) as PruneMessage[];
      grown.push(message("m5", "user", [textPart("t5", "more")]));
      applyCompactionTransform(grown, { cfg: CFG, telemetry: logger, sessionID: session });
      expect(serialize(grown.slice(0, view1.length))).toBe(bytes1);
      expect(countSummaryMarkers(grown)).toBe(1);

      logger.close();
      const records = readRecords(dir).filter((r) => r.kind === "compaction");
      expect(records.map((r) => [r.event?.path, r.event?.outcome])).toEqual([
        ["scratch", "ok"],
        [undefined, "skipped"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
