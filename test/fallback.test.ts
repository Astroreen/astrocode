import { test, expect, describe, beforeEach } from "bun:test";
import { parseFallbackConfig, DEFAULT_FALLBACK_CONFIG } from "../src/fallback/config";
import { isRetryableError, getStatusCode, getErrorMessage, classifyError } from "../src/fallback/classify";
import {
  decideFallback,
  parseModelString,
  resolveFallbackModels,
} from "../src/fallback";
import { clearAll, markSameModelRetried, recordAttempt, shouldThrottle } from "../src/fallback/state";

function configWith(overrides: Record<string, unknown> = {}) {
  return parseFallbackConfig({ enabled: true, models: ["openai/gpt-4o"], ...overrides });
}

describe("parseFallbackConfig", () => {
  test("empty/undefined input -> defaults", () => {
    expect(parseFallbackConfig(undefined)).toEqual({
      ...DEFAULT_FALLBACK_CONFIG,
      agents: {},
    });
    expect(parseFallbackConfig(null).enabled).toBe(false);
  });

  test("merges provided values over defaults", () => {
    const parsed = parseFallbackConfig({
      enabled: true,
      retry_on_errors: [429],
      max_attempts: 5,
      cooldown_seconds: 10,
      models: ["a/b"],
      agents: { oracle: { models: ["x/y"] } },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.retry_on_errors).toEqual([429]);
    expect(parsed.max_attempts).toBe(5);
    expect(parsed.cooldown_seconds).toBe(10);
    expect(parsed.models).toEqual(["a/b"]);
    expect(parsed.agents.oracle.models).toEqual(["x/y"]);
  });

  test("garbage fields fall back to defaults", () => {
    const parsed = parseFallbackConfig({
      retry_on_errors: "nope",
      max_attempts: -3,
      models: [1, 2, "ok"],
    });
    expect(parsed.retry_on_errors).toEqual(DEFAULT_FALLBACK_CONFIG.retry_on_errors);
    expect(parsed.max_attempts).toBe(DEFAULT_FALLBACK_CONFIG.max_attempts);
    expect(parsed.models).toEqual(["ok"]);
  });
});

describe("classify", () => {
  test("getErrorMessage unwraps nested data.message", () => {
    expect(getErrorMessage({ data: { message: "boom" } })).toBe("boom");
    expect(getErrorMessage("plain")).toBe("plain");
    expect(getErrorMessage(undefined)).toBe("");
  });

  test("getStatusCode reads nested data.statusCode then number in text", () => {
    expect(getStatusCode({ data: { statusCode: 503 } })).toBe(503);
    expect(getStatusCode({ message: "Error 429 too many" })).toBe(429);
    expect(getStatusCode({})).toBeUndefined();
  });

  test("rate-limit / 5xx / 429 are retryable", () => {
    const codes = [429, 500, 502, 503, 504];
    expect(isRetryableError({ message: "rate limit exceeded" }, codes)).toBe(true);
    expect(isRetryableError({ message: "overloaded" }, codes)).toBe(true);
    expect(isRetryableError({ data: { statusCode: 503 } }, codes)).toBe(true);
    expect(isRetryableError({ message: "HTTP 502 bad gateway" }, codes)).toBe(true);
    expect(isRetryableError({ message: "请求过于频繁" }, codes)).toBe(true);
    expect(isRetryableError({ message: "You have reached your usage limit" }, codes)).toBe(true);
    expect(isRetryableError({ message: "out of credits" }, codes)).toBe(true);
  });

  test("abort / context-overflow are not retryable", () => {
    const codes = [429, 500, 502, 503, 504];
    expect(isRetryableError({ name: "MessageAbortedError", message: "aborted" }, codes)).toBe(false);
    expect(isRetryableError({ message: "maximum context length exceeded" }, codes)).toBe(false);
  });

  test("abort wrapping a provider limit IS retryable (Claude Code session limit)", () => {
    const codes = [429, 500, 502, 503, 504];
    expect(
      isRetryableError(
        {
          name: "MessageAbortedError",
          data: { message: "Claude Code returned an error result: You've hit your session limit · resets 4am" },
        },
        codes,
      ),
    ).toBe(true);
    expect(
      isRetryableError({ name: "MessageAbortedError", message: "you've hit your limit" }, codes),
    ).toBe(true);
  });

  test("explicit isRetryable:false does NOT veto a model switch", () => {
    const codes = [429, 500, 502, 503, 504];
    // Switching providers is exactly what a subscription/quota limit needs.
    expect(isRetryableError({ data: { message: "nope", isRetryable: false, statusCode: 429 } }, codes)).toBe(true);
    expect(isRetryableError({ data: { message: "reached your limit", isRetryable: false } }, codes)).toBe(true);
  });

  test("model-not-found is retryable (switch model)", () => {
    const codes = [429, 500, 502, 503, 504];
    expect(isRetryableError({ message: "model not found" }, codes)).toBe(true);
    expect(isRetryableError({ data: { message: "unknown provider" } }, codes)).toBe(true);
  });

  test("unrelated errors are not retryable", () => {
    expect(isRetryableError({ message: "invalid api key" }, [429])).toBe(false);
    expect(isRetryableError({}, [])).toBe(false);
  });

  test("classifyError distinguishes terminal quota / non-terminal / overflow / fatal", () => {
    expect(classifyError({ message: "You've hit your session limit · resets 4am" }, [429])).toBe(
      "terminal_quota",
    );
    expect(classifyError({ message: "429 Too Many Requests" }, [429])).toBe("non_terminal");
    expect(classifyError({ message: "maximum context length exceeded" }, [])).toBe(
      "context_overflow",
    );
    expect(classifyError({ message: "syntax error" }, [])).toBe("not_retryable");
  });
});

describe("model helpers", () => {
  test("parseModelString splits provider/model", () => {
    expect(parseModelString("anthropic/claude-sonnet-4-6")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    });
    expect(parseModelString("no-slash")).toBeUndefined();
    expect(parseModelString("/leading")).toBeUndefined();
    expect(parseModelString("trailing/")).toBeUndefined();
  });

  test("resolveFallbackModels: per-agent replaces global", () => {
    const config = configWith({ agents: { oracle: { models: ["x/y"] } } });
    expect(resolveFallbackModels(config, "oracle")).toEqual(["x/y"]);
    expect(resolveFallbackModels(config, "explore")).toEqual(["openai/gpt-4o"]);
    expect(resolveFallbackModels(config)).toEqual(["openai/gpt-4o"]);
  });
});

describe("decideFallback", () => {
  beforeEach(() => clearAll());

  test("disabled -> no retry", () => {
    const config = parseFallbackConfig({ enabled: false, models: ["a/b"] });
    expect(decideFallback(config, "s1", { message: "rate limit" }).reason).toBe("disabled");
  });

  test("non-retryable -> no retry", () => {
    expect(decideFallback(configWith(), "s1", { message: "invalid api key" }).reason).toBe(
      "not-retryable",
    );
  });

  test("no candidate models -> no retry", () => {
    const config = parseFallbackConfig({ enabled: true, models: [] });
    expect(decideFallback(config, "s1", { message: "rate limit" }).reason).toBe(
      "no-fallback-models",
    );
  });

  test("retryable with chain -> picks first candidate", () => {
    const decision = decideFallback(configWith(), "s1", { message: "usage limit exceeded" });
    expect(decision.retry).toBe(true);
    expect(decision.model).toBe("openai/gpt-4o");
  });

  test("skips the current model", () => {
    const config = configWith({ models: ["a/one", "b/two"] });
    const decision = decideFallback(
      config,
      "s1",
      { message: "usage limit exceeded" },
      undefined,
      "a/one",
    );
    expect(decision.model).toBe("b/two");
  });

  test("throttled after max_attempts", () => {
    const config = configWith({ max_attempts: 1, cooldown_seconds: 0 });
    recordAttempt("s1", "openai/gpt-4o");
    expect(decideFallback(config, "s1", { message: "overloaded" }).reason).toBe("throttled");
  });

  test("throttled during cooldown", () => {
    const config = configWith({ max_attempts: 5, cooldown_seconds: 60 });
    recordAttempt("s1", "openai/gpt-4o");
    expect(shouldThrottle("s1", 5, 60)).toBe(true);
    expect(decideFallback(config, "s1", { message: "overloaded" }).reason).toBe("throttled");
  });

  test("rotates through the chain by attempt count", () => {
    const config = configWith({ models: ["a/one", "b/two"], max_attempts: 5, cooldown_seconds: 0 });
    recordAttempt("s1", "a/one");
    markSameModelRetried("s1");
    const decision = decideFallback(config, "s1", { message: "overloaded" });
    expect(decision.retry).toBe(true);
    expect(decision.model).toBe("b/two");
  });

  test("non-terminal error with 0 attempts -> same-model-retry", () => {
    const decision = decideFallback(configWith(), "s1", { message: "429 Too Many Requests" });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe("same-model-retry");
    expect(decision.errorClass).toBe("non_terminal");
  });

  test("non-terminal error after 1 attempt rotates the chain", () => {
    const config = configWith({ models: ["a/one", "b/two"], max_attempts: 5, cooldown_seconds: 0 });
    recordAttempt("s1", "a/one");
    markSameModelRetried("s1");
    const decision = decideFallback(config, "s1", { message: "429 Too Many Requests" });
    expect(decision.retry).toBe(true);
    expect(decision.model).toBe("b/two");
    expect(decision.errorClass).toBe("non_terminal");
  });

  test("same-model retry is bounded to one per failure episode", () => {
    const config = configWith({ models: ["a/one", "b/two"], max_attempts: 5, cooldown_seconds: 0 });
    const error = { message: "429 Too Many Requests" };

    const first = decideFallback(config, "s1", error);
    expect(first.retry).toBe(false);
    expect(first.reason).toBe("same-model-retry");

    markSameModelRetried("s1");

    const second = decideFallback(config, "s1", error);
    expect(second.retry).toBe(true);
    expect(second.model).toBe("a/one");
    expect(second.reason).toBe("retry");
  });
});