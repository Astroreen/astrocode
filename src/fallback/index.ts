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
import { getErrorMessage, isRetryableError } from "./classify";
import type { FallbackConfig } from "./config";
import {
  getAttemptCount,
  getLastFallbackModel,
  recordAttempt,
  shouldThrottle,
} from "./state";

export interface FallbackDecision {
  retry: boolean;
  reason: string;
  model?: string;
}

// One retry at a time per session.
const inFlight = new Set<string>();

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
export function resolveFallbackModels(
  config: FallbackConfig,
  agent?: string,
): string[] {
  if (agent && config.agents[agent]) {
    return config.agents[agent].models;
  }
  return config.models;
}

// Pick the next unused candidate: skip the model that just failed and any model
// already recorded from a previous attempt in this session.
export function pickFallbackModel(
  candidates: string[],
  currentModel?: string,
): string | undefined {
  const used = currentModel ? [currentModel] : [];
  const remaining = candidates.filter((candidate) => !used.includes(candidate));
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
  if (!isRetryableError(error, config.retry_on_errors)) {
    return { retry: false, reason: "not-retryable" };
  }
  if (shouldThrottle(sessionID, config.max_attempts, config.cooldown_seconds)) {
    return { retry: false, reason: "throttled" };
  }

  const candidates = resolveFallbackModels(config, agent);
  if (candidates.length === 0) {
    return { retry: false, reason: "no-fallback-models" };
  }

  // Advance through the chain by attempt count, then skip the current model.
  const attempts = getAttemptCount(sessionID);
  const offset = attempts % candidates.length;
  const rotated = candidates.slice(offset).concat(candidates.slice(0, offset));
  const lastUsed = getLastFallbackModel(sessionID);
  const model = pickFallbackModel(rotated, currentModel ?? lastUsed);
  if (!model) {
    return { retry: false, reason: "chain-exhausted" };
  }

  return { retry: true, reason: "retry", model };
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

    const textParts: TextPartInput[] = [];
    for (const part of entry.parts) {
      // Skip synthetic parts (including our own "[astrocode fallback]" note from
      // a previous attempt) so retries don't stack notes.
      if (isTextPart(part) && !(part as { synthetic?: boolean }).synthetic) {
        textParts.push({ type: "text", text: part.text });
      }
    }
    if (textParts.length === 0) return undefined;

    const info = entry.info;
    const agent = typeof info.agent === "string" ? info.agent : undefined;
    const modelRef = info.model;
    const model = modelRef
      ? `${modelRef.providerID}/${modelRef.modelID}`
      : undefined;
    return { parts: textParts, agent, model };
  }
  return undefined;
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
    // First pass with no message lookup: cheap rejection for disabled /
    // non-retryable errors without hitting the SDK.
    const precheck = decideFallback(config, sessionID, error);
    if (!precheck.retry) return precheck;

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
    if (!decision.retry || !decision.model) return decision;

    const parsed = parseModelString(decision.model);
    if (!parsed) {
      return { retry: false, reason: "bad-model-string" };
    }

    const note: TextPartInput = {
      type: "text",
      synthetic: true,
      text:
        `[astrocode fallback] The previous attempt failed with: ` +
        `${getErrorMessage(error) || "unknown error"}. ` +
        `Retrying automatically on ${decision.model}. ` +
        `Resume the task from where it stopped; do not restart from scratch.`,
    };

    recordAttempt(sessionID, decision.model);

    const body = {
      model: parsed,
      parts: [note, ...last.parts],
    };

    let result = await client.session.prompt({
      path: { id: sessionID },
      body,
    });

    // The failed turn may have left the session marked busy; abort and retry the
    // resubmission once before giving up.
    if (result.error) {
      try {
        await client.session.abort({ path: { id: sessionID } });
      } catch {
        // abort is best-effort
      }
      result = await client.session.prompt({ path: { id: sessionID }, body });
    }

    if (result.error) {
      return { retry: true, reason: "resubmit-failed", model: decision.model };
    }
    return decision;
  } catch {
    return { retry: false, reason: "error" };
  } finally {
    inFlight.delete(sessionID);
  }
}