import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUDGET_ERROR_PREFIX,
  checkBudget,
  configureBudget,
  enforceBudget,
  recordUsageSpend,
  resetBudgetState,
  setCurrentAgent,
  spendSnapshot,
} from "../src/telemetry/budget";
import { createTelemetryLogger, type TelemetryRecord } from "../src/telemetry/log";
import { configureLogger, type LogClient } from "../src/log";
import { loadAstrocodeConfig } from "../src/config/astrocode";

afterEach(() => {
  resetBudgetState();
  configureLogger(undefined);
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astrocode-budget-"));
}

function readLines(file: string): TelemetryRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TelemetryRecord);
}

// Toast capture: the log facade no-ops without a wired TUI client, so tests
// that assert the toast wire a stub LogClient first.
function toastBodies(): { variant: string; title?: string; message: string }[] {
  const bodies: { variant: string; title?: string; message: string }[] = [];
  const client: LogClient = {
    app: { log: () => undefined },
    tui: {
      showToast: (options) => {
        bodies.push(options.body);
        return undefined;
      },
    },
  };
  configureLogger(client);
  return bodies;
}

describe("recordUsageSpend aggregation", () => {
  test("accumulates session total and per-agent breakdown", () => {
    recordUsageSpend("agg-1", 0.01);
    recordUsageSpend("agg-1", 0.02, "build");
    recordUsageSpend("agg-1", 0.005, "build");
    recordUsageSpend("agg-1", 0.004, "explore");

    const snapshot = spendSnapshot("agg-1");
    expect(snapshot.total_usd).toBeCloseTo(0.039, 10);
    expect(snapshot.by_agent["build"]).toBeCloseTo(0.025, 10);
    expect(snapshot.by_agent["explore"]).toBeCloseTo(0.004, 10);
  });

  test("garbage costs and empty session ids are ignored", () => {
    recordUsageSpend("", 0.1);
    recordUsageSpend("agg-2", undefined);
    recordUsageSpend("agg-2", Number.NaN);
    recordUsageSpend("agg-2", -0.5);
    recordUsageSpend("agg-2", 0);
    expect(spendSnapshot("agg-2")).toEqual({ total_usd: 0, by_agent: {} });
  });

  test("omitted agent falls back to the tracked current agent", () => {
    setCurrentAgent("agg-3", "explore");
    recordUsageSpend("agg-3", 0.02);
    expect(spendSnapshot("agg-3").by_agent["explore"]).toBeCloseTo(0.02, 10);
  });

  test("setCurrentAgent ignores garbage", () => {
    setCurrentAgent("agg-4", "  ");
    setCurrentAgent("", "build");
    recordUsageSpend("agg-4", 0.02);
    expect(spendSnapshot("agg-4").by_agent).toEqual({});
  });
});

describe("checkBudget", () => {
  test("disabled -> never blocks, even with a 0 limit and huge spend", () => {
    configureBudget({ enabled: false, session_usd: 0, agent_usd: 0 });
    recordUsageSpend("dis-1", 5);
    expect(checkBudget("dis-1").blocked).toBe(false);
  });

  test("under the limits -> not blocked", () => {
    configureBudget({ enabled: true, session_usd: 1, agent_usd: 1 });
    recordUsageSpend("under-1", 0.5, "build");
    const decision = checkBudget("under-1");
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  test("session limit exceeded -> blocked with formatted sums", () => {
    configureBudget({ enabled: true, session_usd: 0.1 });
    recordUsageSpend("ses-over", 0.2);
    const decision = checkBudget("ses-over");
    expect(decision.blocked).toBe(true);
    expect(decision.scope).toBe("session");
    expect(decision.spend).toBeCloseTo(0.2, 10);
    expect(decision.limit).toBe(0.1);
    expect(decision.reason).toBe(
      "astrocode budget exceeded: session spend $0.20 ≥ $0.10 limit",
    );
  });

  test("agent limit exceeded -> blocked and names the agent", () => {
    configureBudget({ enabled: true, agent_usd: 0.1 });
    recordUsageSpend("agt-over", 0.2, "build");
    const decision = checkBudget("agt-over");
    expect(decision.blocked).toBe(true);
    expect(decision.scope).toBe("agent");
    expect(decision.agent).toBe("build");
    expect(decision.reason).toBe(
      "astrocode budget exceeded: agent spend $0.20 ≥ $0.10 limit (agent: build)",
    );
  });

  test("agent limit uses the tracked current agent when none is passed", () => {
    configureBudget({ enabled: true, agent_usd: 0.1 });
    setCurrentAgent("agt-track", "explore");
    recordUsageSpend("agt-track", 0.2);
    expect(checkBudget("agt-track").blocked).toBe(true);
    expect(checkBudget("agt-track").agent).toBe("explore");
  });

  test("explicit agent param wins over the tracked one", () => {
    configureBudget({ enabled: true, agent_usd: 0.1 });
    setCurrentAgent("agt-both", "over");
    recordUsageSpend("agt-both", 0.2, "over");
    // A different agent has no spend yet -> not blocked for them.
    expect(checkBudget("agt-both", "fresh").blocked).toBe(false);
    expect(checkBudget("agt-both").blocked).toBe(true);
  });

  test("0 limit blocks everything, even with zero spend", () => {
    configureBudget({ enabled: true, session_usd: 0 });
    expect(checkBudget("virgin-session").blocked).toBe(true);

    configureBudget({ enabled: true, agent_usd: 0 });
    setCurrentAgent("zero-agent", "build");
    expect(checkBudget("zero-agent").blocked).toBe(true);
    expect(checkBudget("zero-agent").scope).toBe("agent");
  });

  test("undefined limits never block", () => {
    configureBudget({ enabled: true });
    recordUsageSpend("no-limit", 100);
    expect(checkBudget("no-limit").blocked).toBe(false);
  });

  test("unknown session with a positive limit does not block", () => {
    configureBudget({ enabled: true, session_usd: 0.01, agent_usd: 0.01 });
    expect(checkBudget("never-seen").blocked).toBe(false);
  });

  test("error prefix constant is stable", () => {
    expect(BUDGET_ERROR_PREFIX).toBe("astrocode budget exceeded:");
  });
});

describe("enforceBudget", () => {
  test("not blocked -> returns undefined, writes nothing", () => {
    const dir = tempDir();
    try {
      configureBudget({ enabled: true, session_usd: 1 });
      const logger = createTelemetryLogger({ dir });
      expect(enforceBudget("ok-1", logger)).toBeUndefined();
      logger.close();
      expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session block -> budget_block record + toast + formatted message", () => {
    const dir = tempDir();
    const toasts = toastBodies();
    try {
      configureBudget({ enabled: true, session_usd: 0.1 });
      recordUsageSpend("blk-ses", 0.2);
      const logger = createTelemetryLogger({ dir });

      const message = enforceBudget("blk-ses", logger);
      if (typeof message !== "string") throw new Error("expected a block message");
      expect(message).toBe(
        "astrocode budget exceeded: session spend $0.20 ≥ $0.10 limit",
      );
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const lines = readLines(join(dir, files[0] as string));
      expect(lines).toHaveLength(1);
      const record = lines[0] as TelemetryRecord;
      expect(record.kind).toBe("budget_block");
      expect(record.session_id).toBe("blk-ses");
      expect(record.cost_usd).toBeCloseTo(0.2, 10);
      expect(record.event?.scope).toBe("session");
      expect(record.event?.limit).toBeCloseTo(0.1, 10);
      expect(record.event?.spend).toBeCloseTo(0.2, 10);
      expect(record).not.toHaveProperty("agent");

      expect(toasts).toHaveLength(1);
      expect(toasts.map((toast) => toast.variant)).toEqual(["warning"]);
      expect(toasts.map((toast) => toast.title)).toEqual(["astrocode budget"]);
      expect(toasts.map((toast) => toast.message)).toEqual([message]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agent block -> record carries the agent, scope agent", () => {
    const dir = tempDir();
    const toasts = toastBodies();
    try {
      configureBudget({ enabled: true, agent_usd: 0.1 });
      recordUsageSpend("blk-agt", 0.2, "build");
      const logger = createTelemetryLogger({ dir });

      const message = enforceBudget("blk-agt", logger);
      if (typeof message !== "string") throw new Error("expected a block message");
      expect(message).toBe(
        "astrocode budget exceeded: agent spend $0.20 ≥ $0.10 limit (agent: build)",
      );
      logger.close();

      const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      const lines = readLines(join(dir, files[0] as string));
      const record = lines[0] as TelemetryRecord;
      expect(record.kind).toBe("budget_block");
      expect(record.agent).toBe("build");
      expect(record.event?.scope).toBe("agent");
      expect(record.event?.agent).toBe("build");

      expect(toasts.map((toast) => toast.message)).toEqual([message]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("message formats sums to exactly 2 decimals", () => {
    configureBudget({ enabled: true, session_usd: 0.1 });
    recordUsageSpend("fmt-1", 0.2);
    const message = enforceBudget("fmt-1", createTelemetryLogger({ enabled: false }));
    expect(message).toBe(
      "astrocode budget exceeded: session spend $0.20 ≥ $0.10 limit",
    );
  });
});

describe("budget config parsing", () => {
  test("default is disabled with no limits", () => {
    const config = loadAstrocodeConfig([]);
    expect(config.budget).toEqual({ enabled: false });
  });

  test("parses limits; 0 is a valid limit and survives", () => {
    const config = loadAstrocodeConfig([], {
      budget: { enabled: true, session_usd: 0, agent_usd: 0.25 },
    });
    expect(config.budget.enabled).toBe(true);
    expect(config.budget.session_usd).toBe(0);
    expect(config.budget.agent_usd).toBe(0.25);
  });

  test("garbage fields fall back to defaults without throwing", () => {
    const config = loadAstrocodeConfig([], {
      budget: { enabled: "yes", session_usd: -1, agent_usd: "nope", extra: true },
    });
    expect(config.budget.enabled).toBe(false);
    expect(config.budget.session_usd).toBeUndefined();
    expect(config.budget.agent_usd).toBeUndefined();
  });

  test("non-object budget input is ignored", () => {
    const config = loadAstrocodeConfig([], { budget: "block everything" });
    expect(config.budget).toEqual({ enabled: false });
  });

  test("parsed config drives enforcement end to end", () => {
    configureBudget(
      loadAstrocodeConfig([], { budget: { enabled: true, session_usd: 0.01 } })
        .budget,
    );
    recordUsageSpend("e2e-1", 0.02);
    expect(checkBudget("e2e-1").blocked).toBe(true);
  });
});