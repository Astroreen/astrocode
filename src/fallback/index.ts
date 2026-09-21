// Fallback orchestrator: turns a retryable `session.error` into a resubmission
// on the next fallback-chain model, continuing the SAME session (full history,
// tool calls and file edits are already server-side, so nothing needs replaying
// — see docs/porting-plan.md "Fallback module design").
//
// Split in two layers on purpose:
//   - `decideFallback` is pure and unit-testable (no client I/O).
//   - `dispatchFallback` performs the session.messages / session.prompt calls.
//
// Dynamic-prompt reconciliation is implicit here: the resubmission carries a new
// `model`, so opencode fires `experimental.chat.system.transform` again with the
// fallback model, and astrocode's dispatch (src/prompts/sisyphus/dispatch.ts)
// rebuilds the family-specific Sisyphus prompt for that model automatically.

import type { PluginInput } from "@opencode-ai/plugin";
import type { TextPartInput } from "@opencode-ai/sdk";
import { getAgentConfigKey } from "../agents/personas";
import { areModelsEquivalent } from "./canonicalize";
import { classifyError, getErrorMessage, isRetryableError } from "./classify";
import type { ErrorClass } from "./classify";
import type { FallbackConfig } from "./config";
import {
  clearRetryKeys,
  getAttemptCount,
  getLastFallbackModel,
  hasSameModelRetried,
  markSameModelRetried,
  recordAttempt,
  resetSameModelRetried,
  shouldThrottle,
} from "./state";
import { setSessionFallbackModel } from "./session-model";
import { getChildSessionAgent, isChildSession } from "./subagent";

export interface FallbackDecision {
  retry: boolean;
  reason: string;
  model?: string;
  detail?: string;
  errorClass?: ErrorClass;
}

// One retry at a time per session.
const inFlight = new Set<string>();

// Marker on the synthetic note we prepend to a resubmission. Also used to strip
// the note when replaying a synthetic-only user turn (see collectLastUserText).
const FALLBACK_NOTE_PREFIX = "[astrocode fallback]";

export function parseModelString(
  value: string,
): { providerID: string; modelID: string } | undefined {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

// Per-agent list fully replaces the global list (decision #3: no merge).
// Accepts either the display name ("Sisyphus - ultraworker") or the canonical
// key ("sisyphus"), since a session's message.agent carries the display name.
export function resolveFallbackModels(
  config: FallbackConfig,
  agent?: string,
): string[] {
  if (agent) {
    const entry =
      config.agents[agent] ?? config.agents[getAgentConfigKey(agent)];
    if (entry) return entry.models;
  }
  return config.models;
}

// Pick the next unused candidate: skip any model equivalent to the one that
// just failed (`currentModel`) and any model already recorded from a previous
// attempt in this session (`lastUsed`). Equivalence is canonical, so a
// suffix-variant of the failed model is not treated as a real fallback.
export function pickFallbackModel(
  candidates: string[],
  currentModel?: string,
  lastUsed?: string,
): string | undefined {
  const remaining = candidates.filter(
    (candidate) =>
      !areModelsEquivalent(candidate, currentModel) &&
      !areModelsEquivalent(candidate, lastUsed),
  );
  if (remaining.length === 0) return undefined;
  return remaining[0];
}

export function decideFallback(
  config: FallbackConfig,
  sessionID: string,
  error: unknown,
  agent?: string,
  currentModel?: string,
): FallbackDecision {
  if (!config.enabled) {
    return { retry: false, reason: "disabled" };
  }
  const errorClass = classifyError(error, config.retry_on_errors);
  if (!isRetryableError(error, config.retry_on_errors)) {
    return { retry: false, reason: "not-retryable", errorClass };
  }
  if (shouldThrottle(sessionID, config.max_attempts, config.cooldown_seconds)) {
    return { retry: false, reason: "throttled", errorClass };
  }

  const candidates = resolveFallbackModels(config, agent);
  if (candidates.length === 0) {
    return { retry: false, reason: "no-fallback-models", errorClass };
  }

  // Transient (non-terminal) errors get one same-model attempt first: let
  // opencode's own retry handle it before we rotate the fallback chain.
  if (errorClass === "non_terminal" && !hasSameModelRetried(sessionID)) {
    return { retry: false, reason: "same-model-retry", errorClass };
  }

  // Advance through the chain by attempt count, then skip the current model.
  const attempts = getAttemptCount(sessionID);
  const offset = attempts % candidates.length;
  const rotated = candidates.slice(offset).concat(candidates.slice(0, offset));
  const lastUsed = getLastFallbackModel(sessionID);
  const model = pickFallbackModel(rotated, currentModel, lastUsed);
  if (!model) {
    return { retry: false, reason: "chain-exhausted", errorClass };
  }

  return { retry: true, reason: "retry", model, errorClass };
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

async function collectLastUserText(
  client: PluginInput["client"],
  sessionID: string,
): Promise<{ parts: TextPartInput[]; agent?: string; model?: string } | undefined> {
  const result = await client.session.messages({ path: { id: sessionID } });
  if (result.error || !result.data) return undefined;

  const history = result.data;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || entry.info.role !== "user") continue;

    // Prefer the real (non-synthetic) user text, so retries don't stack our own
    // "[astrocode fallback]" note. A synthetic-only user turn still resolves
    // agent/model: opencode injects background-subagent results as a synthetic
    // part, and a child session's delegation prompt may be synthetic too.
    //
    // NOTE: the returned `parts` are no longer replayed (fix A resubmits only
    // the synthetic note); they exist so a caller can inspect the prompt if
    // needed. The turn is used mainly to resolve `agent` and `model`.
    const visible: TextPartInput[] = [];
    const synthetic: TextPartInput[] = [];
    let sawTextPart = false;
    for (const part of entry.parts) {
      if (!isTextPart(part)) continue;
      sawTextPart = true;
      const textPart: TextPartInput = { type: "text", text: part.text };
      if ((part as { synthetic?: boolean }).synthetic) {
        if (!part.text.startsWith(FALLBACK_NOTE_PREFIX)) synthetic.push(textPart);
      } else {
        visible.push(textPart);
      }
    }
    const textParts = visible.length > 0 ? visible : synthetic;
    if (textParts.length === 0) {
      // A user turn carrying only our own fallback note (fix A resubmits
      // note-only). Skip it and keep scanning older turns so a chained fallback
      // still resolves the real prompt, agent and model. A turn with no text
      // part at all is a genuine dead end.
      if (sawTextPart) continue;
      return undefined;
    }

    const info = entry.info;
    // The registry is the safety net for a child session whose last user message
    // carries no agent (synthetic-only delegation prompt).
    const agent =
      (typeof info.agent === "string" ? info.agent : undefined) ??
      getChildSessionAgent(sessionID);
    const modelRef = info.model;
    const model = modelRef
      ? `${modelRef.providerID}/${modelRef.modelID}`
      : undefined;
    return { parts: textParts, agent, model };
  }
  return undefined;
}

// Abort the in-progress turn so opencode's own same-model retry loop stops
// before we resubmit. Bounded so a hung abort request cannot stall the fallback.
async function abortSession(
  client: PluginInput["client"],
  sessionID: string,
  timeoutMs = 5000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.session.abort({ path: { id: sessionID } }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // abort is best-effort
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function dispatchFallback(
  client: PluginInput["client"],
  config: FallbackConfig,
  sessionID: string,
  error: unknown,
): Promise<FallbackDecision> {
  if (inFlight.has(sessionID)) {
    return { retry: false, reason: "in-flight" };
  }
  inFlight.add(sessionID);

  try {
    // Cheap rejection first: disabled / non-retryable / throttled need no I/O.
    // NOTE: we intentionally do NOT call `decideFallback` here without an agent,
    // because a config with only per-agent fallback lists (no global `models`)
    // would wrongly report "no-fallback-models" before we look up the agent.
    if (!config.enabled) return { retry: false, reason: "disabled" };
    if (!isRetryableError(error, config.retry_on_errors)) {
      return {
        retry: false,
        reason: "not-retryable",
        detail: getErrorMessage(error).slice(0, 200),
      };
    }
    if (shouldThrottle(sessionID, config.max_attempts, config.cooldown_seconds)) {
      return { retry: false, reason: "throttled" };
    }

    const last = await collectLastUserText(client, sessionID);
    if (!last) {
      return { retry: false, reason: "no-user-message" };
    }

    const decision = decideFallback(
      config,
      sessionID,
      error,
      last.agent,
      last.model,
    );
    if (decision.reason === "same-model-retry") {
      markSameModelRetried(sessionID);
      return decision;
    }
    if (!decision.retry || !decision.model) {
      // A child (subagent) session with no fallback chain has nobody to report a
      // terminal quota failure to: the parent's `task` tool call just blocks.
      // Abort the child so the parent resolves immediately. oh-my-openagent does
      // the same (hooks/runtime-fallback/message-update-handler.ts,
      // "message.updated.subagent-quota-no-fallback").
      if (
        decision.reason === "no-fallback-models" &&
        decision.errorClass === "terminal_quota" &&
        isChildSession(sessionID)
      ) {
        await abortSession(client, sessionID);
        return { ...decision, detail: "child-aborted" };
      }
      return decision;
    }

    const parsed = parseModelString(decision.model);
    if (!parsed) {
      return { retry: false, reason: "bad-model-string" };
    }

    // A terminal limit (subscription / quota / session limit) leaves the primary
    // model unusable for a long while, so remember the switch and keep the
    // session on the fallback for the following turns too (see session-model.ts).
    //
    // Applies to every successful retry, not just terminal quota: opencode
    // resolves the generation model from the client's own selection, so without
    // the pin `chat.message` never rewrites it and the client snaps back to the
    // primary on the very next turn (fix B).
    if (last.model) {
      setSessionFallbackModel(sessionID, last.model, decision.model);
    }

    const note: TextPartInput = {
      type: "text",
      synthetic: true,
      text:
        `${FALLBACK_NOTE_PREFIX} The previous attempt failed with: ` +
        `${getErrorMessage(error) || "unknown error"}. ` +
        `Retrying automatically on ${decision.model}. ` +
        `Resume the task from where it stopped; do not restart from scratch.`,
    };

    recordAttempt(sessionID, decision.model);

    // Carry the agent too: opencode resolves the generation agent from the last
    // user message, and a resubmission without it would fall back to the default
    // agent (wrong for subagent/child sessions).
    //
    // Send ONLY the synthetic note (fix A): the real user turn is already in the
    // server-side history, so replaying its text would append a duplicate user
    // message that the TUI renders as a second copy of the prompt.
    const body = {
      model: parsed,
      parts: [note],
      ...(last.agent ? { agent: last.agent } : {}),
    };

    // Stop opencode's own same-model retry loop before resubmitting. Leaving it
    // running keeps the session busy and made the previous (blocking) dispatch
    // deadlock behind the provider's retry backoff.
    await abortSession(client, sessionID);

    // Non-blocking resubmission: the blocking `session.prompt` variant would hold
    // this hook (and the in-flight guard) for the entire generation, so every
    // later error/status event would be swallowed as "in-flight".
    const result = await client.session.promptAsync({
      path: { id: sessionID },
      body,
    });

    if (result.error) {
      return { retry: true, reason: "resubmit-failed", model: decision.model };
    }
    resetSameModelRetried(sessionID);
    clearRetryKeys(sessionID);
    return decision;
  } catch {
    return { retry: false, reason: "error" };
  } finally {
    inFlight.delete(sessionID);
  }
}