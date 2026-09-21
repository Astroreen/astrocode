import { test, expect, describe } from "bun:test";
import {
  areModelsEquivalent,
  canonicalizeModelID,
} from "../src/fallback/canonicalize";
import { pickFallbackModel } from "../src/fallback";

describe("canonicalizeModelID", () => {
  test("lowercases and replaces dots with dashes", () => {
    expect(canonicalizeModelID("GPT-4.1")).toBe("gpt-4-1");
  });

  test("strips claude reasoning suffixes", () => {
    expect(canonicalizeModelID("claude-opus-4-7-thinking")).toBe("claude-opus-4-7");
    expect(canonicalizeModelID("claude-sonnet-4-6-max")).toBe("claude-sonnet-4-6");
    expect(canonicalizeModelID("claude-haiku-4-5-high")).toBe("claude-haiku-4-5");
  });

  test("leaves non-claude ids untouched", () => {
    expect(canonicalizeModelID("gpt-4o-thinking")).toBe("gpt-4o-thinking");
  });
});

describe("areModelsEquivalent", () => {
  test("suffix-variant of the same claude model is equivalent", () => {
    expect(
      areModelsEquivalent("anthropic/claude-opus-4-7-thinking", "anthropic/claude-opus-4-7"),
    ).toBe(true);
  });

  test("same model id under a different provider is NOT equivalent", () => {
    expect(
      areModelsEquivalent("anthropic/claude-opus-4-7", "openrouter/claude-opus-4-7"),
    ).toBe(false);
  });

  test("identical ids are equivalent", () => {
    expect(areModelsEquivalent("openai/gpt-4o", "openai/gpt-4o")).toBe(true);
  });

  test("undefined / empty operands are never equivalent", () => {
    expect(areModelsEquivalent(undefined, "openai/gpt-4o")).toBe(false);
    expect(areModelsEquivalent("openai/gpt-4o", undefined)).toBe(false);
    expect(areModelsEquivalent("", "")).toBe(false);
  });
});

describe("pickFallbackModel equivalence", () => {
  test("skips a suffix-variant of the failed model", () => {
    expect(
      pickFallbackModel(
        ["anthropic/claude-opus-4-7-thinking", "openai/gpt-4o"],
        "anthropic/claude-opus-4-7",
      ),
    ).toBe("openai/gpt-4o");
  });

  test("chain of only suffix-variants of the failed model -> undefined", () => {
    expect(
      pickFallbackModel(
        ["anthropic/claude-opus-4-7-thinking", "anthropic/claude-opus-4-7-max"],
        "anthropic/claude-opus-4-7",
      ),
    ).toBeUndefined();
  });

  test("skips both currentModel and lastUsed", () => {
    expect(
      pickFallbackModel(["a/one", "b/two", "c/three"], "a/one", "b/two"),
    ).toBe("c/three");
  });
});
