import { test, expect, describe } from "bun:test";
import { resolveFamily, isCheapSamplingFamily } from "../src/models/resolveFamily";

describe("resolveFamily", () => {
  describe("claude family", () => {
    test("anthropic/claude-sonnet-4-6 -> claude", () => {
      expect(
        resolveFamily({ providerID: "anthropic", modelID: "claude-sonnet-4-6" }),
      ).toBe("claude");
    });

    test("case-insensitive: CLAUDE in modelID -> claude", () => {
      expect(
        resolveFamily({ providerID: "Anthropic", modelID: "CLAUDE-Opus-4" }),
      ).toBe("claude");
    });

    test("claude wins even via non-anthropic provider", () => {
      expect(
        resolveFamily({ providerID: "openrouter", modelID: "anthropic/claude-3.5" }),
      ).toBe("claude");
    });
  });

  describe("gpt family", () => {
    test("openai/gpt-4o -> gpt", () => {
      expect(
        resolveFamily({ providerID: "openai", modelID: "gpt-4o" }),
      ).toBe("gpt");
    });

    test("openrouter + openai/gpt-4o -> gpt (no provider gate anymore)", () => {
      expect(
        resolveFamily({ providerID: "openrouter", modelID: "openai/gpt-4o" }),
      ).toBe("gpt");
    });

    test("case-insensitive GPT-5.5 -> gpt", () => {
      expect(
        resolveFamily({ providerID: "openai", modelID: "GPT-5.5" }),
      ).toBe("gpt");
    });
  });

  describe("gemini family", () => {
    test("google/gemini-2.5-pro -> gemini", () => {
      expect(
        resolveFamily({ providerID: "google", modelID: "gemini-2.5-pro" }),
      ).toBe("gemini");
    });
  });

  describe("kimi family", () => {
    test("moonshotai/kimi-k2 -> kimi", () => {
      expect(
        resolveFamily({ providerID: "moonshotai", modelID: "kimi-k2" }),
      ).toBe("kimi");
    });

    test("openrouter + kimi -> kimi", () => {
      expect(
        resolveFamily({ providerID: "openrouter", modelID: "moonshotai/kimi-k2" }),
      ).toBe("kimi");
    });
  });

  describe("glm family", () => {
    test("zhipuai/glm-4.6 -> glm", () => {
      expect(
        resolveFamily({ providerID: "zhipuai", modelID: "glm-4.6" }),
      ).toBe("glm");
    });
  });

  describe("openrouter-generic family", () => {
    test.each(["deepseek", "qwen", "minimax", "yi", "zhipu"])(
      "allowlist substring %s -> openrouter-generic",
      (needle) => {
        expect(
          resolveFamily({ providerID: "openrouter", modelID: `vendor/${needle}-model` }),
        ).toBe("openrouter-generic");
      },
    );

    test("no longer requires openrouter provider (provider gate removed)", () => {
      expect(
        resolveFamily({ providerID: "deepseek", modelID: "deepseek-chat" }),
      ).toBe("openrouter-generic");
    });

    test("case-insensitive provider + modelID", () => {
      expect(
        resolveFamily({ providerID: "OpenRouter", modelID: "DeepSeek/DeepSeek-V3" }),
      ).toBe("openrouter-generic");
    });
  });

  describe("fallback family", () => {
    test("unknown provider/model -> fallback", () => {
      expect(
        resolveFamily({ providerID: "foo", modelID: "bar-99" }),
      ).toBe("fallback");
    });

    test("empty inputs -> fallback (no throw)", () => {
      expect(() =>
        resolveFamily({ providerID: "", modelID: "" }),
      ).not.toThrow();
      expect(resolveFamily({ providerID: "", modelID: "" })).toBe("fallback");
    });
  });

  describe("totality / determinism", () => {
    test("always returns one of the seven literals", () => {
      const valid: string[] = [
        "claude",
        "gpt",
        "gemini",
        "kimi",
        "glm",
        "openrouter-generic",
        "fallback",
      ];
      const cases = [
        { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        { providerID: "openrouter", modelID: "z-ai/glm-4.6" },
        { providerID: "foo", modelID: "bar" },
        { providerID: "", modelID: "" },
      ];
      for (const c of cases) {
        expect(valid.includes(resolveFamily(c))).toBe(true);
      }
    });

    test("deterministic: same input -> same output", () => {
      const input = { providerID: "openrouter", modelID: "kimi/k2" };
      expect(resolveFamily(input)).toBe(resolveFamily(input));
    });
  });
});

describe("isCheapSamplingFamily", () => {
  test("kimi/glm/openrouter-generic -> true", () => {
    expect(isCheapSamplingFamily("kimi")).toBe(true);
    expect(isCheapSamplingFamily("glm")).toBe(true);
    expect(isCheapSamplingFamily("openrouter-generic")).toBe(true);
  });

  test("claude/gpt/gemini/fallback -> false", () => {
    expect(isCheapSamplingFamily("claude")).toBe(false);
    expect(isCheapSamplingFamily("gpt")).toBe(false);
    expect(isCheapSamplingFamily("gemini")).toBe(false);
    expect(isCheapSamplingFamily("fallback")).toBe(false);
  });
});
