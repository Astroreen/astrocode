// Budget enforcement aggregates (plan T2).
//
// In-memory spend ledger fed from the T1 usage records: every finished
// assistant message adds its cost to the session total and to the per-agent
// breakdown. The enforcement point is the `tool.execute.before` hook in
// src/index.ts — opencode can only reject a tool call before it executes, so
// spend that accumulates mid-generation is caught at the NEXT tool call.
// Between tool calls enforcement is impossible by design.
//
// Opt-in by default: blocking tool calls on spend is a destructive behavior,
// so `budget.enabled` defaults to false in the config layer
// (src/config/astrocode.ts). The aggregates are always fed (cheap, in-memory)
// so flipping the config on mid-process still sees spend since plugin load.
//
// Limit semantics:
//   undefined limit -> unlimited (never blocks)
//   0 limit         -> blocks everything (spend >= 0 is always true)
//
// The ledger lives only for the plugin process lifetime; it resets on
// restart. Maps are bounded like the telemetry dedup set so a long-lived
// host process cannot grow them forever.

import { log } from "../log";
import type { TelemetryLogger } from "./log";

export interface BudgetLimits {
  enabled: boolean;
  /** Session spend cap in USD. undefined = unlimited, 0 = block all. */
  session_usd?: number;
  /** Per-agent spend cap in USD. undefined = unlimited, 0 = block all. */
  agent_usd?: number;
}

export interface BudgetDecision {
  blocked: boolean;
  /** Full enforcement message; becomes the thrown Error text when blocked. */
  reason?: string;
  /** Which scope tripped. */
  scope?: "session" | "agent";
  /** Spend at check time (USD). */
  spend?: number;
  /** The limit that tripped (USD). */
  limit?: number;
  /** Agent name when the agent limit tripped. */
  agent?: string;
}

/** Every budget rejection starts with this exact prefix. */
export const BUDGET_ERROR_PREFIX = "astrocode budget exceeded:";

interface SessionSpend {
  total_usd: number;
  by_agent: Map<string, number>;
}

const SESSION_LIMIT = 4096;
const sessions = new Map<string, SessionSpend>();
// Last agent seen per session (from the chat.message hook) — tool.execute.before
// does not carry the agent name, so attribution falls back to this.
const currentAgent = new Map<string, string>();

let config: BudgetLimits = { enabled: false };

function asLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function asAgentName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Install the parsed config; re-validated defensively, garbage -> unlimited. */
export function configureBudget(next: BudgetLimits | undefined): void {
  const session = asLimit(next?.session_usd);
  const agent = asLimit(next?.agent_usd);
  config = {
    enabled: next?.enabled === true,
    ...(session !== undefined ? { session_usd: session } : {}),
    ...(agent !== undefined ? { agent_usd: agent } : {}),
  };
}

/**
 * Add one usage record's cost to the session ledger. Zero/garbage costs are
 * ignored (nothing to enforce on). When `agent` is omitted, the spend is
 * attributed to the session's tracked current agent, if any.
 */
export function recordUsageSpend(
  sessionID: string,
  cost_usd: number | undefined,
  agent?: string,
): void {
  if (!sessionID) return;
  const cost =
    typeof cost_usd === "number" && Number.isFinite(cost_usd) && cost_usd > 0
      ? cost_usd
      : undefined;
  if (cost === undefined) return;

  if (sessions.size >= SESSION_LIMIT) sessions.clear();
  let spend = sessions.get(sessionID);
  if (!spend) {
    spend = { total_usd: 0, by_agent: new Map() };
    sessions.set(sessionID, spend);
  }
  spend.total_usd += cost;

  const name = asAgentName(agent) ?? currentAgent.get(sessionID);
  if (name) {
    // The last agent that produced spend is the session's current agent —
    // keeps checkBudget self-sufficient when callers pass the agent directly.
    if (currentAgent.size >= SESSION_LIMIT) currentAgent.clear();
    currentAgent.set(sessionID, name);
    spend.by_agent.set(name, (spend.by_agent.get(name) ?? 0) + cost);
  }
}

/** Remember the agent currently driving a session (from chat.message). */
export function setCurrentAgent(sessionID: string, agent: string | undefined): void {
  const name = asAgentName(agent);
  if (!sessionID || !name) return;
  if (currentAgent.size >= SESSION_LIMIT) currentAgent.clear();
  currentAgent.set(sessionID, name);
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Pure query against the aggregates. Never throws, never mutates.
 * Session limit trips on total >= session_usd; agent limit on that agent's
 * total >= agent_usd (explicit `agent` param wins over the tracked one).
 */
export function checkBudget(sessionID: string, agent?: string): BudgetDecision {
  if (!config.enabled || !sessionID) return { blocked: false };

  const spend = sessions.get(sessionID);
  const sessionTotal = spend?.total_usd ?? 0;
  const sessionLimit = config.session_usd;
  if (sessionLimit !== undefined && sessionTotal >= sessionLimit) {
    return {
      blocked: true,
      scope: "session",
      spend: sessionTotal,
      limit: sessionLimit,
      reason: `${BUDGET_ERROR_PREFIX} session spend ${usd(sessionTotal)} ≥ ${usd(sessionLimit)} limit`,
    };
  }

  const name = asAgentName(agent) ?? currentAgent.get(sessionID);
  const agentLimit = config.agent_usd;
  if (name && agentLimit !== undefined) {
    const agentTotal = spend?.by_agent.get(name) ?? 0;
    if (agentTotal >= agentLimit) {
      return {
        blocked: true,
        scope: "agent",
        spend: agentTotal,
        limit: agentLimit,
        agent: name,
        reason: `${BUDGET_ERROR_PREFIX} agent spend ${usd(agentTotal)} ≥ ${usd(agentLimit)} limit (agent: ${name})`,
      };
    }
  }

  return { blocked: false };
}

/**
 * The single enforcement point, called from `tool.execute.before`. When the
 * budget tripped: writes the `budget_block` telemetry record, emits the user
 * toast, and returns the rejection message (the caller throws it as an Error
 * — the throw itself must happen in the hook so opencode rejects the call).
 * Returns undefined (and does nothing else) when not blocked.
 */
export function enforceBudget(
  sessionID: string,
  telemetry: TelemetryLogger,
): string | undefined {
  const decision = checkBudget(sessionID);
  if (!decision.blocked || !decision.reason) return undefined;

  telemetry.record("budget_block", {
    session_id: sessionID,
    ...(decision.agent ? { agent: decision.agent } : {}),
    cost_usd: decision.spend,
    event: {
      scope: decision.scope ?? "session",
      spend: decision.spend ?? null,
      limit: decision.limit ?? null,
      ...(decision.agent ? { agent: decision.agent } : {}),
    },
  });
  log.toast({
    variant: "warning",
    title: "astrocode budget",
    message: decision.reason,
  });
  return decision.reason;
}

/** Test/observability snapshot of one session's ledger. */
export function spendSnapshot(sessionID: string): {
  total_usd: number;
  by_agent: Record<string, number>;
} {
  const spend = sessions.get(sessionID);
  const by_agent: Record<string, number> = {};
  if (spend) {
    for (const [name, total] of spend.by_agent) by_agent[name] = total;
  }
  return { total_usd: spend?.total_usd ?? 0, by_agent };
}

/** Full reset (aggregates + tracked agents + config). Tests and dispose. */
export function resetBudgetState(): void {
  sessions.clear();
  currentAgent.clear();
  config = { enabled: false };
}