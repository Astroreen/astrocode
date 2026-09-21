// Runtime-fallback error classification, ported from oh-my-openagent's
// model-core (docs/porting-plan.md, "Fallback module design"). Pure, total,
// never throws: decides whether an errored turn is worth retrying on the next
// fallback-chain model.

// Message-body patterns (lowercased message is tested). Covers the common
// provider rate-limit / capacity responses, including the Chinese-localized
// variants the original shipped.
export const RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /usage.?limit/i,
  /limit.?reached/i,
  /reached.?your.?limit/i,
  /quota.?exceeded/i,
  /insufficient.?quota/i,
  /exceeded.?your.?current.?quota/i,
  /out.?of.?credits?/i,
  /credit.?balance/i,
  /insufficient.?credit/i,
  /billing/i,
  /payment.?required/i,
  /service.?unavailable/i,
  /overloaded/i,
  /overloaded_error/i,
  /capacity/i,
  /resource.?exhausted/i,
  /temporarily.?unavailable/i,
  /try.?again/i,
  /server.?error/i,
  /bad.?gateway/i,
  /gateway.?timeout/i,
  // Claude Code subscription wording ("You've hit your session limit · resets
  // 4am") — the error often arrives wrapped in a MessageAbortedError, so the
  // message text is what has to carry the signal.
  /session.?limit/i,
  /hit your/i,
  /you'?ve hit/i,
  /resets?\s+\d/i,
  // Model/provider unavailable — oh-my classifies model_not_found as retryable,
  // since the obvious fix is to switch to the next model in the chain.
  /model.?not.?found/i,
  /unknown.?(model|provider)/i,
  /no such model/i,
  /\b404\b/,
  /\b400\b.*\blimit\b/i,
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /\b529\b/,
  /使用上限/,
  /频率限制/,
  /请求过于频繁/,
  /暂时不可用/,
  /服务不可用/,
  /请稍后重试/,
  // Broad catch-all for provider "hit your limit" wording; context-overflow is
  // excluded explicitly above before this list is consulted.
  /\blimit\b/i,
];

// Errors that must never trigger a fallback retry regardless of anything else.
const ABORT_ERROR_NAME = "MessageAbortedError";

const CONTEXT_OVERFLOW_PATTERN = /context.?length|context.?overflow|maximum.?context/i;

export function getErrorMessage(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const record = error as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).message;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }

  const message = record.message;
  if (typeof message === "string" && message.length > 0) return message;

  const cause = record.cause;
  if (cause !== undefined && cause !== error) return getErrorMessage(cause);

  return "";
}

export function getErrorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const name = (error as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
}

export function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const record = error as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).statusCode;
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }

  const direct = record.statusCode;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;

  const match = getErrorMessage(error).match(/\b(\d{3})\b/);
  if (match) {
    const parsed = Number(match[1]);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}

export function isRetryableError(error: unknown, retryOnErrors: number[]): boolean {
  const message = getErrorMessage(error);

  // Never retry a context-window overflow on another model.
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) return false;

  // NOTE: we deliberately do NOT veto on `error.data.isRetryable === false`.
  // That flag means "this request is not retryable on the SAME model" — which
  // is exactly the case (quota/auth/usage-limit) where switching providers is
  // the right move. Vetoing on it was why subscription-limit errors never
  // triggered a fallback.

  // A clear retryable message wins even if the error is an abort: opencode wraps
  // provider quota/limit failures in MessageAbortedError ("interrupted"), and the
  // message text is the only reliable signal left.
  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }

  // A bare abort with no provider message is a user cancellation: never retry.
  if (getErrorName(error) === ABORT_ERROR_NAME) return false;

  const status = getStatusCode(error);
  if (status !== undefined) {
    if (retryOnErrors.includes(status)) return true;
    if (status >= 500 && status <= 599) return true;
  }

  return false;
}