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

export const DEFAULT_MAX_CONTINUATIONS = 3;

const counts = new Map<string, number>();
const inFlight = new Set<string>();

export function resetIdleContinuationState(): void {
  counts.clear();
  inFlight.clear();
}

export function getIdleContinuationCount(sessionID: string): number {
  return counts.get(sessionID) ?? 0;
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
  options: { max?: number } = {},
): Promise<IdleContinuationResult> {
  const max = options.max ?? DEFAULT_MAX_CONTINUATIONS;
  if (inFlight.has(sessionID)) return { continued: false, reason: "in-flight" };
  if (getIdleContinuationCount(sessionID) >= max) {
    return { continued: false, reason: "max-reached" };
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
    let parsedModel: { providerID: string; modelID: string } | undefined;
    if (fallbackModel) {
      const slash = fallbackModel.indexOf("/");
      if (slash > 0 && slash < fallbackModel.length - 1) {
        parsedModel = {
          providerID: fallbackModel.slice(0, slash),
          modelID: fallbackModel.slice(slash + 1),
        };
      }
    }

    const body = parsedModel
      ? { model: parsedModel, parts: [note] }
      : { parts: [note] };

    const send = await client.session.prompt({ path: { id: sessionID }, body });
    if (send.error) return { continued: false, reason: "send-failed" };

    counts.set(sessionID, getIdleContinuationCount(sessionID) + 1);
    return { continued: true, reason: "continued" };
  } catch {
    return { continued: false, reason: "error" };
  } finally {
    inFlight.delete(sessionID);
  }
}