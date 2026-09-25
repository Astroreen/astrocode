// Idle continuation.
//
// Ported in spirit from oh-my-openagent's todo-continuation enforcer: when a
// session goes idle with unfinished work, inject a short continuation prompt so
// the agent keeps going instead of stopping after a partial result.
//
// astrocode's version is opt-in (`idleContinuation.enabled`), capped per session,
// and driven by opencode's `session.idle` event + the real `session.todo` API.
// If a fallback model was already used in the session, the continuation is sent
// on that model (so it does not bounce back to a rate-limited primary).

import type { PluginInput } from "@opencode-ai/plugin";
import type { TextPartInput } from "@opencode-ai/sdk";
import { getLastFallbackModel } from "../fallback/state";
import { getChildSessionAgent } from "../fallback/subagent";
import { parseModelString } from "../models/model-id";
import {
  ABORT_WINDOW_MS,
  CONTINUATION_COOLDOWN_MS,
  FAILURE_RESET_WINDOW_MS,
  MAX_BACKOFF_EXPONENT,
  MAX_CONSECUTIVE_FAILURES,
} from "./constants";

export const DEFAULT_MAX_CONTINUATIONS = 3;

interface IdleSessionState {
  lastInjectedAt?: number;
  consecutiveFailures: number;
  lastIncompleteCount?: number;
  pendingFailureCheck: boolean;
}

const counts = new Map<string, number>();
const inFlight = new Set<string>();
const states = new Map<string, IdleSessionState>();
const aborts = new Map<string, number>();

function getState(sessionID: string): IdleSessionState {
  let state = states.get(sessionID);
  if (!state) {
    state = { consecutiveFailures: 0, pendingFailureCheck: false };
    states.set(sessionID, state);
  }
  return state;
}

export function resetIdleContinuationState(): void {
  counts.clear();
  inFlight.clear();
  states.clear();
  aborts.clear();
}

export function recordAbort(sessionID: string, now: number = Date.now()): void {
  aborts.set(sessionID, now);
}

export function getIdleContinuationCount(sessionID: string): number {
  return counts.get(sessionID) ?? 0;
}

export function getIdleBackoffState(sessionID: string): {
  consecutiveFailures: number;
  lastInjectedAt?: number;
} {
  const state = states.get(sessionID);
  return {
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    lastInjectedAt: state?.lastInjectedAt,
  };
}

export interface IdleContinuationResult {
  continued: boolean;
  reason: string;
}

interface TodoLike {
  status?: string;
  content?: string;
}

export async function maybeContinueIdle(
  client: PluginInput["client"],
  sessionID: string,
  options: { max?: number; now?: number } = {},
): Promise<IdleContinuationResult> {
  const max = options.max ?? DEFAULT_MAX_CONTINUATIONS;
  const now = options.now ?? Date.now();
  if (inFlight.has(sessionID)) return { continued: false, reason: "in-flight" };
  if (getIdleContinuationCount(sessionID) >= max) {
    return { continued: false, reason: "max-reached" };
  }

  const abortAt = aborts.get(sessionID);
  if (abortAt !== undefined) {
    if (now - abortAt < ABORT_WINDOW_MS) {
      return { continued: false, reason: "abort-window" };
    }
    aborts.delete(sessionID);
  }

  inFlight.add(sessionID);
  try {
    const result = await client.session.todo({ path: { id: sessionID } });
    if (result.error || !Array.isArray(result.data) || result.data.length === 0) {
      return { continued: false, reason: "no-todos" };
    }

    const incomplete = (result.data as TodoLike[]).filter((todo) => {
      const status = (todo.status ?? "").toLowerCase();
      return status !== "completed" && status !== "cancelled";
    });
    if (incomplete.length === 0) {
      return { continued: false, reason: "all-done" };
    }

    const state = getState(sessionID);

    // Failure accounting: a send is "productive" only if the incomplete todo
    // count dropped since the last injection.
    if (state.pendingFailureCheck) {
      if (incomplete.length < (state.lastIncompleteCount ?? 0)) {
        state.consecutiveFailures = 0;
      } else {
        state.consecutiveFailures += 1;
      }
      state.pendingFailureCheck = false;
    }

    // Failure reset window: after a long quiet period, forgive accumulated failures.
    if (
      state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
      state.lastInjectedAt !== undefined &&
      now - state.lastInjectedAt >= FAILURE_RESET_WINDOW_MS
    ) {
      state.consecutiveFailures = 0;
    }

    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return { continued: false, reason: "max-failures" };
    }

    const effectiveCooldown =
      CONTINUATION_COOLDOWN_MS * 2 ** Math.min(state.consecutiveFailures, MAX_BACKOFF_EXPONENT);
    if (state.lastInjectedAt !== undefined && now - state.lastInjectedAt < effectiveCooldown) {
      return { continued: false, reason: "cooldown" };
    }

    const remaining = incomplete
      .map((todo) => todo.content)
      .filter((content): content is string => typeof content === "string")
      .slice(0, 20);

    const note: TextPartInput = {
      type: "text",
      synthetic: true,
      text:
        "[astrocode idle-continuation] Work on this session is not finished. " +
        "Continue with the remaining todos and verify each result before marking it complete:" +
        (remaining.length > 0 ? `\n- ${remaining.join("\n- ")}` : ""),
    };

    // Continue on the fallback model if one was already used this session.
    const fallbackModel = getLastFallbackModel(sessionID);
    const parsedModel = parseModelString(fallbackModel);
    const agent = getChildSessionAgent(sessionID);

    const body = {
      ...(parsedModel ? { model: parsedModel } : {}),
      ...(agent ? { agent } : {}),
      parts: [note],
    };

    const send = await client.session.promptAsync({ path: { id: sessionID }, body });
    if (send.error) return { continued: false, reason: "send-failed" };

    counts.set(sessionID, getIdleContinuationCount(sessionID) + 1);
    state.lastInjectedAt = now;
    state.lastIncompleteCount = incomplete.length;
    state.pendingFailureCheck = true;
    return { continued: true, reason: "continued" };
  } catch {
    return { continued: false, reason: "error" };
  } finally {
    inFlight.delete(sessionID);
  }
}