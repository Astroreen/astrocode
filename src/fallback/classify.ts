// Runtime-fallback error classification, ported from oh-my-openagent's
// model-core (docs/porting-plan.md, "Fallback module design"). Pure, total,
// never throws: decides whether an errored turn is worth retrying on the next
// fallback-chain model.
//
// Evidence extraction: pattern matching runs against `getEvidenceText` (name +
// message + responseBody) so provider error-type names buried in JSON bodies
// (FreeUsageLimitError, GoUsageLimitError, Z.ai business codes, …) are visible.

// ---------------------------------------------------------------------------
// Evidence extractors (pure, total)
// ---------------------------------------------------------------------------

export function getErrorResponseBody(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const data = (error as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return "";
  const body = (data as Record<string, unknown>).responseBody;
  return typeof body === "string" ? body : "";
}

export function getErrorHeaders(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const data = (error as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return {};
  const raw = (data as Record<string, unknown>).responseHeaders;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
  }
  return result;
}

export function getRetryAfterSeconds(error: unknown): number | undefined {
  const headers = getErrorHeaders(error);
  const raw = headers["retry-after"];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (error && typeof error === "object") {
    const data = (error as Record<string, unknown>).data;
    if (data && typeof data === "object") {
      const retryAfter = (data as Record<string, unknown>).retryAfter;
      if (
        typeof retryAfter === "number" &&
        Number.isFinite(retryAfter) &&
        retryAfter >= 0
      ) {
        return retryAfter;
      }
    }
  }
  return undefined;
}

// Seconds until a "resets …" wording elapses. Two shapes:
//   "resets 4:20pm (Europe/Vilnius)" / "resets at 16:20"  → wall-clock today
//   "resets in 90 minutes" / "resets 2 hours"             → duration
// Returns undefined when nothing matches. Never throws.
export function parseResetSeconds(
  message: string,
  now: Date = new Date(),
): number | undefined {
  if (typeof message !== "string" || message.length === 0) return undefined;

  const clockMatch = message.match(
    /resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i,
  );
  if (clockMatch) {
    let hours = Number(clockMatch[1]);
    const minutes = Number(clockMatch[2]);
    const meridiem = clockMatch[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return undefined;
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return Math.max(0, (target.getTime() - now.getTime()) / 1000);
  }

  const durationMatch = message.match(
    /resets?\s+(?:in\s+)?(\d+)\s*(second|minute|hour|day)s?/i,
  );
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
    };
    const multiplier = multipliers[unit];
    if (multiplier === undefined) return undefined;
    return value * multiplier;
  }

  return undefined;
}

// Best-effort wait window in seconds: retry-after header → error.next (epoch
// ms, session.status retry shape) → "resets …" message wording.
export function getWaitSeconds(error: unknown): number | undefined {
  const retryAfter = getRetryAfterSeconds(error);
  if (retryAfter !== undefined) return retryAfter;

  if (error && typeof error === "object") {
    const next = (error as Record<string, unknown>).next;
    if (typeof next === "number" && Number.isFinite(next) && next >= 0) {
      return Math.max(0, (next - Date.now()) / 1000);
    }
  }

  return parseResetSeconds(getErrorMessage(error));
}

// The ONLY text used for pattern matching. `getErrorMessage` stays display-only.
export function getEvidenceText(error: unknown): string {
  return (
    getErrorName(error) + "\n" + getErrorMessage(error) + "\n" + getErrorResponseBody(error)
  );
}

// ---------------------------------------------------------------------------
// Pattern sets (classification matches against lowercased evidence)
// ---------------------------------------------------------------------------

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
  // Provider-side credit/concurrency accounting (OpenRouter and proxies):
  // "This request would exceed your available credits given your current
  // in-flight requests". Transient — the in-flight window clears on its own —
  // and it was previously unmatched, so subagent sessions never fell back.
  /available.?credits/i,
  /in.?flight.?requests/i,
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

// Terminal quota / billing exhaustion: the current model (or provider account)
// is out of budget, so retrying the SAME model is pointless — rotate to the next
// fallback model immediately. Distinct from transient `non_terminal` errors
// (rate limits, overloads) where opencode's own same-model retry should get one
// shot first. Kept verbatim; folded into TERMINAL_DISCRIMINATORS below.
export const TERMINAL_QUOTA_PATTERNS: RegExp[] = [
  /quota.?exceeded/i,
  /insufficient.?quota/i,
  /exceeded.?your.?current.?quota/i,
  /usage.?limit/i,
  /limit.?reached/i,
  /reached.?your.?limit/i,
  /out.?of.?credits?/i,
  /credit.?balance/i,
  /insufficient.?credit/i,
  /billing/i,
  /payment.?required/i,
  /session.?limit/i,
  /hit your/i,
  /you'?ve hit/i,
  /resets?\s+\d/i,
  // Chinese-localized quota wording.
  /额度|配额|余额不足/,
];

// Terminal discriminators — checked FIRST in classifyError, win over everything.
// New provider-specific type names (matched against lowercased evidence, so no
// /i needed) plus the existing TERMINAL_QUOTA_PATTERNS entries kept verbatim.
export const TERMINAL_DISCRIMINATORS: RegExp[] = [
  /freeusagelimiterror/,
  /gousagelimiterror/,
  /blackusagelimiterror/,
  /quota_?exceeded/,
  /credit_balance_exhausted/,
  /insufficient_?quota/,
  /exceeded_current_quota_error/,
  /(organization|project)_spend_limit_exceeded/,
  /organization_usage_limit_exceeded/,
  /weight_exceeds_budget/,
  /billing_error/,
  /payment_?required/,
  /glmcodingplan/,
  ...TERMINAL_QUOTA_PATTERNS,
];

// Transient discriminators — same-model retry is meaningful (rate limits,
// overloads). Matched against lowercased evidence.
export const TRANSIENT_DISCRIMINATORS: RegExp[] = [
  /in_flight_budget_exhausted/,
  /engine_overloaded_error/,
  /provider_overloaded/,
  /provider_unavailable/,
  /overloaded_error/,
  /service_?unavailable/,
  /server_is_overloaded/,
  /rate_limit_exceeded/,
  /slow_down/,
  /too_many_requests/,
  /rate_limit_reached_error/,
  /resource_?exhausted/,
];

// Z.ai/GLM business codes (Ground Truth §9): the `code` field is a STRING and
// every business error arrives as HTTP 429. The quoted-code form means these
// fire ONLY on the JSON business code, never on free message text.
const ZAI_TERMINAL_CODE_PATTERN =
  /"code"\s*:\s*"(1113|1308|1309|1310|131[6-9]|132[01])"/;
const ZAI_TRANSIENT_CODE_PATTERN = /"code"\s*:\s*"(1302|1305)"/;

// Transient signals that must beat broader terminal patterns and the
// 429/402-no-retry-after rule when both would match:
//   - rate_limit_reached_error (Moonshot, Ground Truth §10) contains
//     "limit_reached" which TERMINAL_DISCRIMINATORS matches via /limit.?reached/i.
//   - Z.ai 1302/1305 arrive as bare HTTP 429 which the Anthropic/OpenAI rule
//     would call terminal.
const TRANSIENT_OVERRIDE_PATTERNS: RegExp[] = [
  /rate_limit_reached_error/,
  ZAI_TRANSIENT_CODE_PATTERN,
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ErrorClass =
  | "terminal_quota"
  | "non_terminal"
  | "context_overflow"
  | "not_retryable";

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
  const evidence = getEvidenceText(error);

  // Never retry a context-window overflow on another model.
  if (CONTEXT_OVERFLOW_PATTERN.test(evidence)) return false;

  // NOTE: we deliberately do NOT veto on `error.data.isRetryable === false`.
  // That flag means "this request is not retryable on the SAME model" — which
  // is exactly the case (quota/auth/usage-limit) where switching providers is
  // the right move. Vetoing on it was why subscription-limit errors never
  // triggered a fallback.

  // A clear retryable message wins even if the error is an abort: opencode wraps
  // provider quota/limit failures in MessageAbortedError ("interrupted"), and the
  // message text is the only reliable signal left.
  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(evidence))) {
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

// Additive classification on top of `isRetryableError` (whose behavior is
// unchanged). Decision order:
//   1. context-overflow          → context_overflow
//   2. transient overrides       → non_terminal  (Z.ai 1302/1305, rate_limit_reached_error)
//   3. terminal discriminators   → terminal_quota (incl. Z.ai terminal codes)
//   4. 429/402 without retry-after → terminal_quota (Anthropic spend-cap / OpenAI credit)
//   5. transient discriminators  → non_terminal
//   6. isRetryableError          → non_terminal
//   7. else                      → not_retryable
export function classifyError(error: unknown, retryOnErrors: number[]): ErrorClass {
  const evidence = getEvidenceText(error).toLowerCase();

  if (CONTEXT_OVERFLOW_PATTERN.test(evidence)) return "context_overflow";

  if (TRANSIENT_OVERRIDE_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return "non_terminal";
  }

  if (TERMINAL_DISCRIMINATORS.some((pattern) => pattern.test(evidence))) {
    return "terminal_quota";
  }
  if (ZAI_TERMINAL_CODE_PATTERN.test(evidence)) return "terminal_quota";

  const status = getStatusCode(error);
  if (
    (status === 429 || status === 402) &&
    getRetryAfterSeconds(error) === undefined
  ) {
    return "terminal_quota";
  }

  if (TRANSIENT_DISCRIMINATORS.some((pattern) => pattern.test(evidence))) {
    return "non_terminal";
  }

  if (isRetryableError(error, retryOnErrors)) return "non_terminal";
  return "not_retryable";
}
