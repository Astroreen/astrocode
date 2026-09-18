import { test, expect, describe } from "bun:test";
import { resolveFamily } from "../src/models/resolveFamily";

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

  describe("cheap-openrouter family", () => {
    test("openrouter + deepseek/deepseek-chat -> cheap-openrouter", () => {
      expect(
        resolveFamily({ providerID: "openrouter", modelID: "deepseek/deepseek-chat" }),
      ).toBe("cheap-openrouter");
    });

    test("openrouter + z-ai/glm-4.6 -> cheap-openrouter", () => {
      expect(
        resolveFamily({ providerID: "openrouter", modelID: "z-ai/glm-4.6" }),
      ).toBe("cheap-openrouter");
    });

    test.each(["deepseek", "glm", "kimi", "qwen", "minimax", "yi", "zhipu"])(
      "openrouter + allowlist substring %s -> cheap-openrouter",
      (needle) => {
        expect(
          resolveFamily({ providerID: "openrouter", modelID: `vendor/${needle}-model` }),
        ).toBe("cheap-openrouter");
      },
    );

    test("case-insensitive provider + modelID", () => {
      expect(
        resolveFamily({ providerID: "OpenRouter", modelID: "DeepSeek/DeepSeek-V3" }),
      ).toBe("cheap-openrouter");
    });

    test("allowlist model without openrouter provider -> fallback (provider guard)", () => {
      expect(
        resolveFamily({ providerID: "deepseek", modelID: "deepseek-chat" }),
      ).toBe("fallback");
    });

    test("openrouter without allowlist model -> fallback", () => {
      expect(
        resolveFamily({ providerID: "openrouter", modelID: "openai/gpt-4o" }),
      ).toBe("fallback");
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
    test("always returns one of the three literals", () => {
      const valid: string[] = ["claude", "cheap-openrouter", "fallback"];
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
