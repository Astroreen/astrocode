import { test, expect, describe } from "bun:test";
import {
  classifyError,
  getErrorResponseBody,
  getErrorHeaders,
  getRetryAfterSeconds,
  getWaitSeconds,
  getEvidenceText,
  parseResetSeconds,
  isRetryableError,
} from "../src/fallback/classify";

const CODES = [429, 500, 502, 503, 504];

// ---------------------------------------------------------------------------
// Evidence extractors
// ---------------------------------------------------------------------------

describe("getErrorResponseBody", () => {
  test("returns string responseBody from data", () => {
    expect(getErrorResponseBody({ data: { responseBody: "hello" } })).toBe("hello");
  });
  test("returns empty string for missing / non-string", () => {
    expect(getErrorResponseBody({ data: {} })).toBe("");
    expect(getErrorResponseBody({ data: { responseBody: 42 } })).toBe("");
    expect(getErrorResponseBody(undefined)).toBe("");
    expect(getErrorResponseBody("str")).toBe("");
  });
});

describe("getErrorHeaders", () => {
  test("normalizes keys to lowercase", () => {
    expect(
      getErrorHeaders({ data: { responseHeaders: { "Retry-After": "30", "X-Foo": "bar" } } }),
    ).toEqual({ "retry-after": "30", "x-foo": "bar" });
  });
  test("returns {} for missing / non-object", () => {
    expect(getErrorHeaders({ data: {} })).toEqual({});
    expect(getErrorHeaders({ data: { responseHeaders: "str" } })).toEqual({});
    expect(getErrorHeaders(undefined)).toEqual({});
  });
});

describe("getRetryAfterSeconds", () => {
  test("reads retry-after header as seconds", () => {
    expect(
      getRetryAfterSeconds({ data: { responseHeaders: { "retry-after": "36000" } } }),
    ).toBe(36000);
  });
  test("non-numeric header falls through to data.retryAfter", () => {
    expect(
      getRetryAfterSeconds({
        data: { responseHeaders: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, retryAfter: 12 },
      }),
    ).toBe(12);
  });
  test("non-numeric header with no fallback -> undefined", () => {
    expect(
      getRetryAfterSeconds({ data: { responseHeaders: { "retry-after": "later" } } }),
    ).toBeUndefined();
  });
  test("data.retryAfter defensive fallback", () => {
    expect(getRetryAfterSeconds({ data: { retryAfter: 5 } })).toBe(5);
    expect(getRetryAfterSeconds({ data: { retryAfter: -1 } })).toBeUndefined();
    expect(getRetryAfterSeconds({ data: { retryAfter: "5" } })).toBeUndefined();
  });
});

describe("parseResetSeconds", () => {
  const now = new Date(2026, 8, 25, 12, 0, 0); // 2026-09-25 12:00 local

  test("wall-clock pm", () => {
    const s = parseResetSeconds("resets 4:20pm (Europe/Vilnius)", now);
    expect(s).toBeGreaterThan(0);
    expect(s!).toBeLessThanOrEqual(86400);
    // 16:20 - 12:00 = 4h20m = 15600s
    expect(s!).toBeCloseTo(15600, 0);
  });
  test("wall-clock 24h 'at' form", () => {
    const s = parseResetSeconds("resets at 16:20", now);
    expect(s!).toBeCloseTo(15600, 0);
  });
  test("wall-clock already past -> +24h", () => {
    const s = parseResetSeconds("resets 9:00am", now);
    // 09:00 is before 12:00 -> tomorrow 09:00 = 21h = 75600s
    expect(s!).toBeCloseTo(75600, 0);
  });
  test("duration form", () => {
    expect(parseResetSeconds("resets in 90 minutes", now)).toBe(5400);
    expect(parseResetSeconds("resets 2 hours", now)).toBe(7200);
    expect(parseResetSeconds("resets in 30 seconds", now)).toBe(30);
    expect(parseResetSeconds("resets in 1 day", now)).toBe(86400);
  });
  test("no match -> undefined", () => {
    expect(parseResetSeconds("something else", now)).toBeUndefined();
    expect(parseResetSeconds("", now)).toBeUndefined();
    expect(parseResetSeconds(undefined as unknown as string, now)).toBeUndefined();
  });
});

describe("getWaitSeconds", () => {
  test("prefers retry-after", () => {
    expect(
      getWaitSeconds({ data: { responseHeaders: { "retry-after": "30" }, message: "resets in 2 hours" } }),
    ).toBe(30);
  });
  test("error.next as epoch ms", () => {
    const w = getWaitSeconds({ data: { message: "x" }, next: Date.now() + 120000 });
    expect(w).toBeGreaterThan(115);
    expect(w!).toBeLessThan(125);
  });
  test("falls back to parseResetSeconds on message", () => {
    const w = getWaitSeconds({
      data: { message: "You've hit your session limit · resets 4:20pm (Europe/Vilnius)" },
    });
    expect(w).toBeGreaterThan(0);
    expect(w!).toBeLessThanOrEqual(86400);
  });
  test("nothing matches -> undefined", () => {
    expect(getWaitSeconds({ data: { message: "x" } })).toBeUndefined();
    expect(getWaitSeconds(undefined)).toBeUndefined();
  });
});

describe("getEvidenceText", () => {
  test("concatenates name + message + responseBody", () => {
    const e = getEvidenceText({
      name: "ApiError",
      data: { message: "boom", responseBody: '{"type":"FreeUsageLimitError"}' },
    });
    expect(e).toBe('ApiError\nboom\n{"type":"FreeUsageLimitError"}');
  });
});

// ---------------------------------------------------------------------------
// Discriminator tables (each pattern gets at least one fixture)
// ---------------------------------------------------------------------------

describe("terminal discriminators", () => {
  const fixtures: Array<[string, unknown]> = [
    // New provider type names
    ["freeusagelimiterror", { data: { message: "x", responseBody: '{"type":"FreeUsageLimitError"}' } }],
    ["gousagelimiterror", { data: { message: "x", responseBody: '{"type":"GoUsageLimitError"}' } }],
    ["blackusagelimiterror", { data: { message: "x", responseBody: '{"type":"BlackUsageLimitError"}' } }],
    ["quota_exceeded", { data: { message: "x", responseBody: "quota_exceeded" } }],
    ["quotaexceeded", { data: { message: "x", responseBody: "quotaexceeded" } }],
    ["credit_balance_exhausted", { data: { message: "x", responseBody: "credit_balance_exhausted" } }],
    ["insufficient_quota", { data: { message: "x", responseBody: "insufficient_quota" } }],
    ["insufficientquota", { data: { message: "x", responseBody: "insufficientquota" } }],
    ["exceeded_current_quota_error", { data: { message: "x", responseBody: "exceeded_current_quota_error" } }],
    ["organization_spend_limit_exceeded", { data: { message: "x", responseBody: "organization_spend_limit_exceeded" } }],
    ["project_spend_limit_exceeded", { data: { message: "x", responseBody: "project_spend_limit_exceeded" } }],
    ["organization_usage_limit_exceeded", { data: { message: "x", responseBody: "organization_usage_limit_exceeded" } }],
    ["weight_exceeds_budget", { data: { message: "x", responseBody: "weight_exceeds_budget" } }],
    ["billing_error", { data: { message: "x", responseBody: "billing_error" } }],
    ["payment_required", { data: { message: "x", responseBody: "payment_required" } }],
    ["paymentrequired", { data: { message: "x", responseBody: "paymentrequired" } }],
    ["glmcodingplan", { data: { message: "x", responseBody: "GLMCodingPlan expired" } }],
    // Existing TERMINAL_QUOTA_PATTERNS kept verbatim
    ["quota exceeded (dot form)", { data: { message: "quota exceeded" } }],
    ["insufficient quota (dot form)", { data: { message: "insufficient quota" } }],
    ["exceeded your current quota", { data: { message: "exceeded your current quota" } }],
    ["usage limit", { data: { message: "usage limit" } }],
    ["limit reached", { data: { message: "limit reached" } }],
    ["reached your limit", { data: { message: "reached your limit" } }],
    ["out of credits", { data: { message: "out of credits" } }],
    ["credit balance", { data: { message: "credit balance" } }],
    ["insufficient credit", { data: { message: "insufficient credit" } }],
    ["billing", { data: { message: "billing" } }],
    ["payment required (dot form)", { data: { message: "payment required" } }],
    ["session limit", { data: { message: "session limit" } }],
    ["hit your", { data: { message: "hit your limit" } }],
    ["you've hit", { data: { message: "you've hit your limit" } }],
    ["resets digit", { data: { message: "resets 4am" } }],
    ["Chinese quota", { data: { message: "额度不足" } }],
    ["Chinese pei", { data: { message: "配额" } }],
    ["Chinese yue", { data: { message: "余额不足" } }],
    // Z.ai terminal business codes
    ["zai 1113", { data: { message: "x", responseBody: '{"code":"1113","message":"insufficient balance"}' } }],
    ["zai 1308", { data: { message: "x", responseBody: '{"code":"1308"}' } }],
    ["zai 1309", { data: { message: "x", responseBody: '{"code":"1309"}' } }],
    ["zai 1310", { data: { message: "x", responseBody: '{"code":"1310"}' } }],
    ["zai 1316", { data: { message: "x", responseBody: '{"code":"1316"}' } }],
    ["zai 1317", { data: { message: "x", responseBody: '{"code":"1317"}' } }],
    ["zai 1318", { data: { message: "x", responseBody: '{"code":"1318"}' } }],
    ["zai 1319", { data: { message: "x", responseBody: '{"code":"1319"}' } }],
    ["zai 1320", { data: { message: "x", responseBody: '{"code":"1320"}' } }],
    ["zai 1321", { data: { message: "x", responseBody: '{"code":"1321"}' } }],
  ];

  test.each(fixtures)("%s → terminal_quota", (_name, error) => {
    expect(classifyError(error, CODES)).toBe("terminal_quota");
  });
});

describe("transient discriminators", () => {
  const fixtures: Array<[string, unknown]> = [
    ["in_flight_budget_exhausted", { data: { message: "x", responseBody: "in_flight_budget_exhausted" } }],
    ["engine_overloaded_error", { data: { message: "x", responseBody: '{"type":"engine_overloaded_error"}' } }],
    ["provider_overloaded", { data: { message: "x", responseBody: "provider_overloaded" } }],
    ["provider_unavailable", { data: { message: "x", responseBody: "provider_unavailable" } }],
    ["overloaded_error", { data: { message: "x", responseBody: "overloaded_error" } }],
    ["service_unavailable", { data: { message: "x", responseBody: "service_unavailable" } }],
    ["serviceunavailable", { data: { message: "x", responseBody: "serviceunavailable" } }],
    ["server_is_overloaded", { data: { message: "x", responseBody: "server_is_overloaded" } }],
    ["rate_limit_exceeded", { data: { message: "x", responseBody: "rate_limit_exceeded" } }],
    ["slow_down", { data: { message: "x", responseBody: "slow_down" } }],
    ["too_many_requests", { data: { message: "x", responseBody: "too_many_requests" } }],
    ["rate_limit_reached_error", { data: { message: "x", responseBody: '{"type":"rate_limit_reached_error"}' } }],
    ["resource_exhausted", { data: { message: "x", responseBody: "resource_exhausted" } }],
    ["resourceexhausted", { data: { message: "x", responseBody: "resourceexhausted" } }],
    // Z.ai transient business codes
    ["zai 1302", { data: { message: "x", responseBody: '{"code":"1302","message":"rate limit"}' } }],
    ["zai 1305", { data: { message: "x", responseBody: '{"code":"1305"}' } }],
  ];

  test.each(fixtures)("%s → non_terminal", (_name, error) => {
    expect(classifyError(error, CODES)).toBe("non_terminal");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria (plan T2)
// ---------------------------------------------------------------------------

describe("T2 acceptance", () => {
  test("FreeUsageLimitError in responseBody → terminal_quota", () => {
    expect(
      classifyError(
        {
          data: {
            message: "Rate limit exceeded. Please try again later.",
            statusCode: 429,
            responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
          },
        },
        CODES,
      ),
    ).toBe("terminal_quota");
  });

  test("discriminator wins even with retry-after", () => {
    expect(
      classifyError(
        {
          data: {
            message: "Rate limit exceeded. Please try again later.",
            statusCode: 429,
            responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
            responseHeaders: { "retry-after": "36000" },
          },
        },
        CODES,
      ),
    ).toBe("terminal_quota");
  });

  test("engine_overloaded_error with retry-after → non_terminal", () => {
    expect(
      classifyError(
        {
          data: {
            message: "The engine is currently overloaded, please try again later",
            statusCode: 429,
            responseBody: '{"error":{"type":"engine_overloaded_error"}}',
            responseHeaders: { "retry-after": "5" },
          },
        },
        CODES,
      ),
    ).toBe("non_terminal");
  });

  test("429 without headers/body → terminal_quota (rule 3)", () => {
    expect(classifyError({ data: { message: "boom", statusCode: 429 } }, CODES)).toBe(
      "terminal_quota",
    );
  });

  test("529 overloaded with retry-after → non_terminal", () => {
    expect(
      classifyError(
        {
          data: {
            message: "The API is temporarily overloaded.",
            statusCode: 529,
            responseHeaders: { "retry-after": "30" },
          },
        },
        CODES,
      ),
    ).toBe("non_terminal");
  });

  test("getWaitSeconds on 'resets 4:20pm' → finite > 0, ≤ 86400", () => {
    const w = getWaitSeconds({
      data: { message: "You've hit your session limit · resets 4:20pm (Europe/Vilnius)" },
    });
    expect(w).toBeGreaterThan(0);
    expect(w!).toBeLessThanOrEqual(86400);
  });

  test("getWaitSeconds on error.next → ≈120", () => {
    const w = getWaitSeconds({ data: { message: "x" }, next: Date.now() + 120000 });
    expect(w).toBeGreaterThan(115);
    expect(w!).toBeLessThan(125);
  });

  test("getWaitSeconds with no signal → undefined", () => {
    expect(getWaitSeconds({ data: { message: "x" } })).toBeUndefined();
  });

  test("bare MessageAbortedError → not_retryable", () => {
    expect(
      classifyError({ name: "MessageAbortedError", data: { message: "interrupted" } }, CODES),
    ).toBe("not_retryable");
  });
});

// ---------------------------------------------------------------------------
// isRetryableError now matches against evidence (responseBody visible)
// ---------------------------------------------------------------------------

describe("isRetryableError evidence matching", () => {
  test("type name in responseBody alone is retryable", () => {
    expect(
      isRetryableError({ data: { message: "x", responseBody: "FreeUsageLimitError" } }, CODES),
    ).toBe(true);
  });
  test("bare abort with no evidence pattern stays non-retryable", () => {
    expect(isRetryableError({ name: "MessageAbortedError", data: { message: "interrupted" } }, CODES)).toBe(
      false,
    );
  });
  test("abort wrapping provider limit in responseBody IS retryable", () => {
    expect(
      isRetryableError(
        {
          name: "MessageAbortedError",
          data: { message: "interrupted", responseBody: '{"type":"FreeUsageLimitError"}' },
        },
        CODES,
      ),
    ).toBe(true);
  });
});
