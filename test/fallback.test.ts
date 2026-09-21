import { test, expect, describe, beforeEach } from "bun:test";
import { parseFallbackConfig, DEFAULT_FALLBACK_CONFIG } from "../src/fallback/config";
import { isRetryableError, getStatusCode, getErrorMessage, classifyError } from "../src/fallback/classify";
import {
  decideFallback,
  dispatchFallback,
  parseModelString,
  resolveFallbackModels,
} from "../src/fallback";
import {
  clearAll,
  clearRetryKeys,
  markRetryKey,
  markSameModelRetried,
  recordAttempt,
  shouldThrottle,
  effectiveCooldownSeconds,
} from "../src/fallback/state";
import {
  clearAllSessionModels,
  getSessionModelState,
  isFallbackPinActive,
  setSessionFallbackModel,
  touchSessionFallbackModel,
} from "../src/fallback/session-model";
import {
  clearChildSessions,
  registerChildSession,
} from "../src/fallback/subagent";

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

  test("provider credit / in-flight-requests error is retryable (subagent case)", () => {
    const codes = [429, 500, 502, 503, 504];
    const message =
      "This request would exceed your available credits given your current in-flight requests";
    expect(isRetryableError({ message }, codes)).toBe(true);
    expect(isRetryableError({ data: { message } }, codes)).toBe(true);
    // Transient concurrency accounting, not a terminal account quota.
    expect(classifyError({ message }, codes)).toBe("non_terminal");
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

describe("effectiveCooldownSeconds", () => {
  test("doubles per failure, capped at 2^5", () => {
    expect(effectiveCooldownSeconds(60, 0)).toBe(60);
    expect(effectiveCooldownSeconds(60, 1)).toBe(120);
    expect(effectiveCooldownSeconds(60, 5)).toBe(1920);
    expect(effectiveCooldownSeconds(60, 9)).toBe(1920);
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

describe("retry-key dedup", () => {
  beforeEach(() => clearAll());

  test("first key accepted, duplicate rejected, clearRetryKeys resets", () => {
    expect(markRetryKey("s1", "1:rate limit")).toBe(true);
    expect(markRetryKey("s1", "1:rate limit")).toBe(false);
    expect(markRetryKey("s1", "2:rate limit")).toBe(true);

    clearRetryKeys("s1");
    expect(markRetryKey("s1", "1:rate limit")).toBe(true);
  });

  test("keys are scoped per session", () => {
    expect(markRetryKey("s1", "k")).toBe(true);
    expect(markRetryKey("s2", "k")).toBe(true);
  });

  test("clearAll wipes retry keys too", () => {
    markRetryKey("s1", "k");
    clearAll();
    expect(markRetryKey("s1", "k")).toBe(true);
  });
});

describe("session-model pin", () => {
  beforeEach(() => clearAllSessionModels());

  test("records original + fallback and reports an active window", () => {
    const now = 1_000_000;
    setSessionFallbackModel("s1", "anthropic/claude-sonnet-4-6", "openrouter/x/y", now);
    expect(getSessionModelState("s1")).toEqual({
      originalModel: "anthropic/claude-sonnet-4-6",
      currentModel: "openrouter/x/y",
      pinnedAt: now,
    });
    expect(isFallbackPinActive("s1", 60, now + 30_000)).toBe(true);
    expect(isFallbackPinActive("s1", 60, now + 90_000)).toBe(false);
  });

  test("cooldown 0 still yields a minimum window", () => {
    const now = 1_000_000;
    setSessionFallbackModel("s1", "a/b", "c/d", now);
    expect(isFallbackPinActive("s1", 0, now + 30_000)).toBe(true);
  });

  test("touch refreshes the window", () => {
    const now = 1_000_000;
    setSessionFallbackModel("s1", "a/b", "c/d", now);
    touchSessionFallbackModel("s1", now + 90_000);
    expect(isFallbackPinActive("s1", 60, now + 100_000)).toBe(true);
  });

  test("unknown session is not pinned", () => {
    expect(isFallbackPinActive("nope", 60)).toBe(false);
  });
});

describe("dispatchFallback", () => {
  beforeEach(() => {
    clearAll();
    clearAllSessionModels();
    clearChildSessions();
  });

  const userMessage = {
    info: {
      role: "user",
      agent: "Atlas - Plan Executor",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    },
    parts: [{ type: "text", text: "do the thing" }],
  };

  function clientWith(messages: unknown[]) {
    const calls = {
      abort: 0,
      prompt: 0,
      promptAsync: 0,
      lastBody: undefined as Record<string, unknown> | undefined,
    };
    const client = {
      session: {
        messages: async () => ({ data: messages }),
        abort: async () => {
          calls.abort += 1;
          return {};
        },
        prompt: async () => {
          calls.prompt += 1;
          return { data: {} };
        },
        promptAsync: async (options: { body: Record<string, unknown> }) => {
          calls.promptAsync += 1;
          calls.lastBody = options.body;
          return { data: {} };
        },
      },
    };
    return { client, calls };
  }

  test("terminal limit: aborts, resubmits async with agent, and pins the fallback", async () => {
    const { client, calls } = clientWith([userMessage]);
    const config = parseFallbackConfig({
      enabled: true,
      models: ["openrouter/~deepseek/deepseek-flash-latest"],
      cooldown_seconds: 0,
    });

    const decision = await dispatchFallback(client as never, config, "s1", {
      message: "You've hit your session limit · resets 6pm",
    });

    expect(decision.retry).toBe(true);
    expect(decision.model).toBe("openrouter/~deepseek/deepseek-flash-latest");
    expect(calls.abort).toBe(1);
    expect(calls.promptAsync).toBe(1);
    // The old implementation used the blocking prompt, which deadlocked.
    expect(calls.prompt).toBe(0);
    expect(calls.lastBody?.agent).toBe("Atlas - Plan Executor");
    expect(calls.lastBody?.model).toEqual({
      providerID: "openrouter",
      modelID: "~deepseek/deepseek-flash-latest",
    });
    expect(getSessionModelState("s1")?.currentModel).toBe(
      "openrouter/~deepseek/deepseek-flash-latest",
    );
  });

  test("non-terminal error does not pin (stays a one-shot same-model retry)", async () => {
    const { client, calls } = clientWith([userMessage]);
    const config = parseFallbackConfig({
      enabled: true,
      models: ["openrouter/x/y"],
      cooldown_seconds: 0,
    });

    const decision = await dispatchFallback(client as never, config, "s2", {
      message: "429 Too Many Requests",
    });

    expect(decision.reason).toBe("same-model-retry");
    expect(calls.promptAsync).toBe(0);
    expect(getSessionModelState("s2")).toBeUndefined();
  });

  test("immediate repeat is throttled by cooldown (no duplicate dispatch)", async () => {
    const { client, calls } = clientWith([userMessage]);
    const config = parseFallbackConfig({
      enabled: true,
      models: ["openrouter/x/y"],
      cooldown_seconds: 60,
    });
    const error = { message: "You've hit your session limit · resets 6pm" };

    await dispatchFallback(client as never, config, "s3", error);
    const second = await dispatchFallback(client as never, config, "s3", error);

    expect(second.reason).toBe("throttled");
    expect(calls.promptAsync).toBe(1);
  });

  test("synthetic-only history is replayed (e.g. injected background result)", async () => {
    const { client, calls } = clientWith([
      {
        info: { role: "user", agent: "explore" },
        parts: [
          { type: "text", text: "Background task completed: do the thing", synthetic: true },
        ],
      },
    ]);
    const config = parseFallbackConfig({
      enabled: true,
      models: ["openrouter/x/y"],
      cooldown_seconds: 0,
    });

    const decision = await dispatchFallback(client as never, config, "s4", {
      message: "You've hit your session limit · resets 6pm",
    });

    expect(decision.retry).toBe(true);
    expect(calls.abort).toBe(1);
    expect(calls.promptAsync).toBe(1);
    expect((calls.lastBody?.parts as unknown[]).length).toBe(2);
  });

  test("our own fallback note alone -> no-user-message (no note stacking)", async () => {
    const { client, calls } = clientWith([
      {
        info: { role: "user", agent: "explore" },
        parts: [
          {
            type: "text",
            text: "[astrocode fallback] The previous attempt failed with: boom",
            synthetic: true,
          },
        ],
      },
    ]);
    const config = parseFallbackConfig({
      enabled: true,
      models: ["openrouter/x/y"],
    });

    const decision = await dispatchFallback(client as never, config, "s4b", {
      message: "You've hit your session limit · resets 6pm",
    });

    expect(decision.reason).toBe("no-user-message");
    expect(calls.abort).toBe(0);
    expect(calls.promptAsync).toBe(0);
  });

  test("registered child with synthetic-only prompt still resubmits on rotation", async () => {
    registerChildSession("child-1", "explore");
    const { client, calls } = clientWith([
      {
        info: { role: "user", agent: "explore" },
        parts: [{ type: "text", text: "delegated", synthetic: true }],
      },
    ]);
    const config = parseFallbackConfig({
      enabled: true,
      models: ["openrouter/x/y"],
      cooldown_seconds: 0,
    });
    const error = {
      message:
        "This request would exceed your available credits given your current in-flight requests",
    };

    // Transient -> one same-model retry first, no resubmission yet.
    const first = await dispatchFallback(client as never, config, "child-1", error);
    expect(first.reason).toBe("same-model-retry");
    expect(calls.promptAsync).toBe(0);

    // Next error rotates the chain and resubmits the synthetic payload.
    const second = await dispatchFallback(client as never, config, "child-1", error);
    expect(second.retry).toBe(true);
    expect(calls.abort).toBe(1);
    expect(calls.promptAsync).toBe(1);
    expect(calls.lastBody?.agent).toBe("explore");
    expect((calls.lastBody?.parts as unknown[]).length).toBe(2);
  });

  test("child with no fallback models on terminal quota -> aborts instead of hanging", async () => {
    registerChildSession("child-2", "explore");
    const { client, calls } = clientWith([userMessage]);
    const config = parseFallbackConfig({ enabled: true, models: [] });

    const decision = await dispatchFallback(client as never, config, "child-2", {
      message: "You've hit your session limit · resets 6pm",
    });

    expect(decision.reason).toBe("no-fallback-models");
    expect(decision.detail).toBe("child-aborted");
    expect(calls.abort).toBe(1);
    expect(calls.promptAsync).toBe(0);
  });

  test("non-child with no fallback models is left alone (no abort)", async () => {
    const { client, calls } = clientWith([userMessage]);
    const config = parseFallbackConfig({ enabled: true, models: [] });

    const decision = await dispatchFallback(client as never, config, "root-1", {
      message: "You've hit your session limit · resets 6pm",
    });

    expect(decision.reason).toBe("no-fallback-models");
    expect(decision.detail).toBeUndefined();
    expect(calls.abort).toBe(0);
    expect(calls.promptAsync).toBe(0);
  });

  test("disabled -> no I/O at all", async () => {
    const { client, calls } = clientWith([userMessage]);
    const config = parseFallbackConfig({ enabled: false, models: ["openrouter/x/y"] });

    const decision = await dispatchFallback(client as never, config, "s5", {
      message: "rate limit",
    });

    expect(decision.reason).toBe("disabled");
    expect(calls.abort).toBe(0);
    expect(calls.promptAsync).toBe(0);
  });
});