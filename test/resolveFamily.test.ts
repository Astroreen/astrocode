import { test, expect, describe } from "bun:test";
import {
  resolveFamily,
  isCheapSamplingFamily,
  type ModelFamily,
} from "../src/models/resolveFamily";

const NINE_FAMILIES: ModelFamily[] = [
  "claude",
  "gpt",
  "gemini",
  "kimi",
  "glm",
  "grok",
  "minimax",
  "openrouter-generic",
  "fallback",
];

describe("regression: no substring collisions", () => {
  test('openrouter "openai/gpt-4o" -> gpt (slug token openai -> gpt rule)', () => {
    expect(
      resolveFamily({ providerID: "openrouter", modelID: "openai/gpt-4o" }),
    ).toBe("gpt");
  });

  test('openrouter "deepseek/gpt-oss-120b" -> openrouter-generic (vendor beats gpt)', () => {
    expect(
      resolveFamily({
        providerID: "openrouter",
        modelID: "deepseek/gpt-oss-120b",
      }),
    ).toBe("openrouter-generic");
  });

  test('meta "llama-3.1-70b" -> fallback (no collision)', () => {
    expect(
      resolveFamily({ providerID: "meta", modelID: "llama-3.1-70b" }),
    ).toBe("fallback");
  });

  test('x "family-guy-model" -> fallback (yi no longer matches inside words)', () => {
    expect(
      resolveFamily({ providerID: "x", modelID: "family-guy-model" }),
    ).toBe("fallback");
  });

  test('x "my-gpt-helper" -> gpt (gpt token — ACCEPTED, this is what family means)', () => {
    expect(
      resolveFamily({ providerID: "x", modelID: "my-gpt-helper" }),
    ).toBe("gpt");
  });

  test('x "lightning-fast" -> fallback', () => {
    expect(
      resolveFamily({ providerID: "x", modelID: "lightning-fast" }),
    ).toBe("fallback");
  });

  test('x "grok-4-5" -> grok', () => {
    expect(resolveFamily({ providerID: "x", modelID: "grok-4-5" })).toBe("grok");
  });

  test('x "minimax-m2" -> minimax', () => {
    expect(resolveFamily({ providerID: "x", modelID: "minimax-m2" })).toBe(
      "minimax",
    );
  });

  test('x "MiniMax-M1" -> minimax (case-insensitive tokens)', () => {
    expect(resolveFamily({ providerID: "x", modelID: "MiniMax-M1" })).toBe(
      "minimax",
    );
  });

  test('deepseek "deepseek-chat" -> openrouter-generic', () => {
    expect(
      resolveFamily({ providerID: "deepseek", modelID: "deepseek-chat" }),
    ).toBe("openrouter-generic");
  });

  test('"" / "" -> fallback, must not throw', () => {
    expect(() =>
      resolveFamily({ providerID: "", modelID: "" }),
    ).not.toThrow();
    expect(resolveFamily({ providerID: "", modelID: "" })).toBe("fallback");
  });

  test('zhipuai "glm-4.6" -> glm (zhipu -> glm, NOT generic)', () => {
    expect(
      resolveFamily({ providerID: "zhipuai", modelID: "glm-4.6" }),
    ).toBe("glm");
  });
});

describe("collision table", () => {
  test.each([
    "family-guy-model",
    "lightning-fast",
    "yikes-model",
    "vladimir-ilyich",
    "miniature-max",
  ])("%s -> fallback", (modelID) => {
    expect(resolveFamily({ providerID: "x", modelID })).toBe("fallback");
  });
});

describe("claude family", () => {
  test.each([
    "claude-sonnet-4-6",
    "CLAUDE-Opus-4",
    "anthropic/claude-3.5",
    "my-opus-thing",
    "my-sonnet-thing",
    "my-haiku-thing",
    "fable-2",
    "mythos-1",
  ])("%s -> claude", (modelID) => {
    expect(resolveFamily({ providerID: "anthropic", modelID })).toBe("claude");
  });
});

describe("kimi family", () => {
  test.each([
    "kimi-k2",
    "moonshotai/kimi-k2",
    "moonshot-v1",
    "kimi-k3",
    "moonshotai/swe-2",
    "swe-2",
  ])("%s -> kimi", (modelID) => {
    expect(resolveFamily({ providerID: "moonshotai", modelID })).toBe("kimi");
  });

  test("swe without 2 is not kimi", () => {
    expect(resolveFamily({ providerID: "x", modelID: "swe-bench" })).toBe(
      "fallback",
    );
  });
});

describe("glm family", () => {
  test.each(["glm-4.6", "z-ai/glm-4.6", "zhipu-chat", "bigmodel-coder"])(
    "%s -> glm",
    (modelID) => {
      expect(resolveFamily({ providerID: "zhipuai", modelID })).toBe("glm");
    },
  );
});

describe("grok family", () => {
  test.each(["grok-4-5", "grok-4-9", "xai/grok-code-fast"])(
    "%s -> grok",
    (modelID) => {
      expect(resolveFamily({ providerID: "xai", modelID })).toBe("grok");
    },
  );
});

describe("minimax family", () => {
  test.each(["minimax-m2", "MiniMax-M1", "minimax-m2.5"])(
    "%s -> minimax",
    (modelID) => {
      expect(resolveFamily({ providerID: "minimax", modelID })).toBe("minimax");
    },
  );

  test("bare m1/m2 do NOT match minimax", () => {
    expect(resolveFamily({ providerID: "x", modelID: "m1" })).toBe("fallback");
    expect(resolveFamily({ providerID: "x", modelID: "m2" })).toBe("fallback");
    expect(resolveFamily({ providerID: "x", modelID: "m2-lite" })).toBe(
      "fallback",
    );
  });
});

describe("gemini family", () => {
  test.each(["gemini-2.5-pro", "google/gemma-3"])("%s -> gemini", (modelID) => {
    expect(resolveFamily({ providerID: "google", modelID })).toBe("gemini");
  });
});

describe("gpt family", () => {
  test.each([
    "gpt-4o",
    "GPT-5.5",
    "openai/gpt-4o",
    "chatgpt-4o",
    "dalle-3",
    "dall-e-3",
    "o1-preview",
    "o3-mini",
    "o4-mini",
    "text-embedding-3-small",
    "text-davinci-002",
    "codex-mini",
  ])("%s -> gpt", (modelID) => {
    expect(resolveFamily({ providerID: "openai", modelID })).toBe("gpt");
  });

  test("o-prefixed digit token must be a full token (4o is not o4)", () => {
    expect(resolveFamily({ providerID: "x", modelID: "gpt-4o" })).toBe("gpt");
    expect(resolveFamily({ providerID: "x", modelID: "4o-flash" })).toBe(
      "fallback",
    );
  });
});

describe("openrouter-generic family", () => {
  test.each([
    "deepseek-chat",
    "DeepSeek/DeepSeek-V3",
    "qwen-2.5-coder",
    "yi-34b",
    "vendor/yi-model",
    "openrouter/auto",
  ])("%s -> openrouter-generic", (modelID) => {
    expect(resolveFamily({ providerID: "openrouter", modelID })).toBe(
      "openrouter-generic",
    );
  });
});

describe("fallback family", () => {
  test.each(["bar-99", "llama-3.1-70b", "lightning-fast"])(
    "%s -> fallback",
    (modelID) => {
      expect(resolveFamily({ providerID: "foo", modelID })).toBe("fallback");
    },
  );
});

describe("totality / determinism", () => {
  test("always returns one of the nine literals", () => {
    const cases = [
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      { providerID: "openrouter", modelID: "z-ai/glm-4.6" },
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { providerID: "xai", modelID: "grok-4-5" },
      { providerID: "minimax", modelID: "MiniMax-M1" },
      { providerID: "moonshotai", modelID: "kimi-k2" },
      { providerID: "deepseek", modelID: "deepseek/gpt-oss-120b" },
      { providerID: "foo", modelID: "bar" },
      { providerID: "", modelID: "" },
    ];
    for (const c of cases) {
      expect(NINE_FAMILIES.includes(resolveFamily(c))).toBe(true);
    }
  });

  test("the union is exactly the nine literals", () => {
    expect(NINE_FAMILIES.length).toBe(9);
    expect(NINE_FAMILIES.includes("grok")).toBe(true);
    expect(NINE_FAMILIES.includes("minimax")).toBe(true);
  });

  test("deterministic: same input -> same output", () => {
    const input = { providerID: "openrouter", modelID: "kimi/k2" };
    expect(resolveFamily(input)).toBe(resolveFamily(input));
  });

  test("providerID is ignored for routing (no provider gate)", () => {
    expect(
      resolveFamily({ providerID: "meta", modelID: "claude-sonnet-4-6" }),
    ).toBe("claude");
    expect(resolveFamily({ providerID: "anthropic", modelID: "llama-3" })).toBe(
      "fallback",
    );
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

  test("grok/minimax -> false", () => {
    expect(isCheapSamplingFamily("grok")).toBe(false);
    expect(isCheapSamplingFamily("minimax")).toBe(false);
  });
});
