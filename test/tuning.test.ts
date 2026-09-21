import { test, expect, describe } from "bun:test";
import {
  reasoningConfigForFamily,
  resolveSampling,
  DEFAULT_SAMPLING,
  clampReasoningLevel,
  splitReasoningSuffix,
} from "../src/models/tuning";

describe("clampReasoningLevel", () => {
  test("clamps down to the strongest allowed level", () => {
    expect(clampReasoningLevel("max", ["low", "medium"])).toBe("medium");
  });

  test("returns undefined when nothing at or below is allowed", () => {
    expect(clampReasoningLevel("low", ["high"])).toBeUndefined();
  });
});

describe("splitReasoningSuffix", () => {
  test("splits a provider-prefixed reasoning suffix", () => {
    expect(splitReasoningSuffix("anthropic/claude-opus-4-7:high")).toEqual({
      base: "anthropic/claude-opus-4-7",
      level: "high",
    });
  });

  test("keeps a bare :max attached unless allowMaxSuffix", () => {
    expect(splitReasoningSuffix("claude-opus-4-7:max")).toEqual({
      base: "claude-opus-4-7:max",
    });
    expect(splitReasoningSuffix("anthropic/claude-opus-4-7:max")).toEqual({
      base: "anthropic/claude-opus-4-7",
      level: "max",
    });
  });

  test("leaves non-level suffixes attached", () => {
    expect(splitReasoningSuffix("model:notalevel")).toEqual({
      base: "model:notalevel",
    });
  });
});

describe("reasoningConfigForFamily", () => {
  test("claude gets extended thinking with a budget", () => {
    const config = reasoningConfigForFamily("claude") as {
      thinking?: { type?: string; budgetTokens?: number };
    };
    expect(config.thinking?.type).toBe("enabled");
    expect(config.thinking?.budgetTokens).toBe(32000);
  });

  test("gpt gets reasoningEffort medium", () => {
    expect(reasoningConfigForFamily("gpt")).toEqual({ reasoningEffort: "medium" });
  });

  test("gpt maps an explicit level to reasoningEffort", () => {
    expect(reasoningConfigForFamily("gpt", "high")).toEqual({
      reasoningEffort: "high",
    });
  });

  test("other families get nothing", () => {
    expect(reasoningConfigForFamily("gemini")).toEqual({});
    expect(reasoningConfigForFamily("kimi")).toEqual({});
    expect(reasoningConfigForFamily("glm")).toEqual({});
    expect(reasoningConfigForFamily("openrouter-generic")).toEqual({});
    expect(reasoningConfigForFamily("fallback")).toEqual({});
  });
});

describe("resolveSampling", () => {
  test("defaults cover the cheap sampling families", () => {
    expect(DEFAULT_SAMPLING.kimi).toEqual({ temperature: 0.3, topP: 0.9 });
    expect(DEFAULT_SAMPLING.glm).toEqual({ temperature: 0.3, topP: 0.9 });
    expect(DEFAULT_SAMPLING["openrouter-generic"]).toEqual({
      temperature: 0.3,
      topP: 0.9,
    });
    expect(DEFAULT_SAMPLING.claude).toBeUndefined();
  });

  test("user overrides win per family", () => {
    expect(
      resolveSampling("kimi", { kimi: { temperature: 0.7 } }),
    ).toEqual({ temperature: 0.7 });
    expect(
      resolveSampling("claude", { claude: { temperature: 0.5, topP: 0.8 } }),
    ).toEqual({ temperature: 0.5, topP: 0.8 });
  });

  test("unknown family with no default and no override is undefined", () => {
    expect(resolveSampling("fallback")).toBeUndefined();
    expect(resolveSampling("gpt")).toBeUndefined();
  });
});