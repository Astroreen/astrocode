import { describe, test, expect } from "bun:test";
import {
  createReasoningDecider,
  reasoningOptionsForOverride,
  resolveChatReasoning,
  CLAUDE_LEVEL_BUDGET_TOKENS,
  CLAUDE_THINKING_BUDGET_TOKENS,
  type ReasoningOverride,
} from "../src/models/tuning";
import { parseReasoningOverrides } from "../src/config/astrocode";

function captureWarn(): { warnings: string[]; warn: (message: string) => void } {
  const warnings: string[] = [];
  return { warnings, warn: (message: string) => warnings.push(message) };
}

describe("parseReasoningOverrides", () => {
  test("keeps valid entries (claude with explicit clear_thinking)", () => {
    const parsed = parseReasoningOverrides({
      "anthropic/claude-sonnet-5-5": { level: "medium", clear_thinking: true },
      "openrouter/xiaomi/mimo-v2.6-pro": { level: "minimal", clear_thinking: false },
      "openrouter/openai/gpt-6-luna": { level: "low" },
    });
    expect(parsed["anthropic/claude-sonnet-5-5"]).toEqual({
      level: "medium",
      clear_thinking: true,
    });
    expect(parsed["openrouter/xiaomi/mimo-v2.6-pro"]).toEqual({
      level: "minimal",
      clear_thinking: false,
    });
    expect(parsed["openrouter/openai/gpt-6-luna"]).toEqual({
      level: "low",
      clear_thinking: false,
    });
  });

  test("keeps budget_tokens when it is a positive integer", () => {
    const parsed = parseReasoningOverrides({
      "anthropic/claude-opus-5-5": {
        level: "high",
        clear_thinking: true,
        budget_tokens: 4096,
      },
    });
    expect(parsed["anthropic/claude-opus-5-5"]?.budget_tokens).toBe(4096);
  });

  test("drops unknown level with a warning", () => {
    const { warnings, warn } = captureWarn();
    const parsed = parseReasoningOverrides(
      { "anthropic/claude-sonnet-5-5": { level: "ultra", clear_thinking: true } },
      warn,
    );
    expect(parsed).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("anthropic/claude-sonnet-5-5");
    expect(warnings[0]).toContain("unknown level");
  });

  test("drops non-boolean clear_thinking with a warning", () => {
    const { warnings, warn } = captureWarn();
    const parsed = parseReasoningOverrides(
      { "anthropic/claude-sonnet-5-5": { level: "high", clear_thinking: "yes" } },
      warn,
    );
    expect(parsed).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("clear_thinking must be a boolean");
  });

  test("drops claude entry without explicit clear_thinking; non-claude defaults to false", () => {
    const { warnings, warn } = captureWarn();
    const parsed = parseReasoningOverrides(
      {
        "anthropic/claude-haiku-5-5": { level: "minimal" },
        "openrouter/z-ai/glm-5.3-flash": { level: "off" },
      },
      warn,
    );
    expect(parsed["anthropic/claude-haiku-5-5"]).toBeUndefined();
    expect(parsed["openrouter/z-ai/glm-5.3-flash"]).toEqual({
      level: "off",
      clear_thinking: false,
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("explicit boolean clear_thinking");
  });

  test("drops bad budget_tokens with a warning", () => {
    const { warnings, warn } = captureWarn();
    const parsed = parseReasoningOverrides(
      {
        "anthropic/claude-opus-5-5": {
          level: "high",
          clear_thinking: true,
          budget_tokens: -5,
        },
      },
      warn,
    );
    expect(parsed).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("budget_tokens");
  });

  test("drops keys without a provider prefix and non-object entries", () => {
    const { warnings, warn } = captureWarn();
    const parsed = parseReasoningOverrides(
      {
        "just-a-model": { level: "low", clear_thinking: false },
        "openrouter/xiaomi/mimo-v2.6-pro": "minimal",
      },
      warn,
    );
    expect(parsed).toEqual({});
    expect(warnings.length).toBe(2);
  });

  test("garbage input yields an empty map without throwing", () => {
    expect(parseReasoningOverrides(undefined)).toEqual({});
    expect(parseReasoningOverrides("nope")).toEqual({});
    expect(parseReasoningOverrides(["a"])).toEqual({});
    expect(parseReasoningOverrides(null)).toEqual({});
  });
});

describe("reasoningOptionsForOverride", () => {
  const claude: ReasoningOverride = { level: "medium", clear_thinking: true };

  test("claude maps the level onto a thinking budget and carries clear_thinking", () => {
    const options = reasoningOptionsForOverride("claude", claude);
    expect(options).toEqual({
      thinking: { type: "enabled", budgetTokens: CLAUDE_LEVEL_BUDGET_TOKENS.medium },
      clear_thinking: true,
    });
  });

  test("claude budget_tokens beats the level-derived budget", () => {
    const options = reasoningOptionsForOverride("claude", {
      level: "high",
      clear_thinking: false,
      budget_tokens: 1024,
    });
    expect(options).toEqual({
      thinking: { type: "enabled", budgetTokens: 1024 },
      clear_thinking: false,
    });
  });

  test("claude off disables thinking", () => {
    const options = reasoningOptionsForOverride("claude", {
      level: "off",
      clear_thinking: true,
    });
    expect(options).toEqual({
      thinking: { type: "disabled" },
      clear_thinking: true,
    });
  });

  test("gpt maps the level onto reasoningEffort and never carries clear_thinking", () => {
    const options = reasoningOptionsForOverride("gpt", {
      level: "minimal",
      clear_thinking: true,
    });
    expect(options).toEqual({ reasoningEffort: "minimal" });
  });

  test("other families get no options at all", () => {
    for (const family of ["glm", "grok", "minimax", "fallback", "openrouter-generic", "kimi", "gemini"] as const) {
      expect(reasoningOptionsForOverride(family, claude)).toEqual({});
    }
  });
});

describe("resolveChatReasoning precedence", () => {
  const overrides: Record<string, ReasoningOverride> = {
    "openai/gpt-6-luna": { level: "low", clear_thinking: false },
    "anthropic/claude-sonnet-5-5": { level: "minimal", clear_thinking: true },
  };

  test("override beats the family default", () => {
    const decision = resolveChatReasoning({
      family: "gpt",
      modelId: "openai/gpt-6-luna",
      overrides,
    });
    expect(decision.source).toBe("override");
    expect(decision.options).toEqual({ reasoningEffort: "low" });
  });

  test("claude override replaces the 32000 family default", () => {
    const decision = resolveChatReasoning({
      family: "claude",
      modelId: "anthropic/claude-sonnet-5-5",
      overrides,
    });
    expect(decision.source).toBe("override");
    expect(decision.options).toEqual({
      thinking: { type: "enabled", budgetTokens: CLAUDE_LEVEL_BUDGET_TOKENS.minimal },
      clear_thinking: true,
    });
  });

  test("a :level suffix in the model id beats the override", () => {
    const decision = resolveChatReasoning({
      family: "gpt",
      modelId: "openai/gpt-6-luna:high",
      overrides,
    });
    expect(decision.source).toBe("suffix");
    expect(decision.options).toEqual({ reasoningEffort: "high" });
  });

  test("a :level suffix in the agent's configured model string beats the override", () => {
    const decision = resolveChatReasoning({
      family: "claude",
      modelId: "anthropic/claude-sonnet-5-5",
      agentModel: "anthropic/claude-sonnet-5-5:low",
      overrides,
    });
    expect(decision.source).toBe("suffix");
    // The suffix path keeps the historical family semantics: claude ignores
    // the level and uses the 32000 budget.
    expect(decision.options).toEqual({
      thinking: { type: "enabled", budgetTokens: CLAUDE_THINKING_BUDGET_TOKENS },
    });
  });

  test("unknown model falls back to the family default", () => {
    const decision = resolveChatReasoning({
      family: "claude",
      modelId: "anthropic/claude-opus-5-5",
      overrides,
    });
    expect(decision.source).toBe("family");
    expect(decision.matched).toBe(false);
    expect(decision.options).toEqual({
      thinking: { type: "enabled", budgetTokens: CLAUDE_THINKING_BUDGET_TOKENS },
    });
  });
});

describe("createReasoningDecider warn discipline", () => {
  test("warns exactly once per uncovered model id, only when overrides exist", () => {
    const { warnings, warn } = captureWarn();
    const decide = createReasoningDecider(
      { "anthropic/claude-sonnet-5-5": { level: "minimal", clear_thinking: true } },
      warn,
    );
    decide({ family: "fallback", modelId: "openrouter/xiaomi/mimo-v2.6-pro" });
    decide({ family: "fallback", modelId: "openrouter/xiaomi/mimo-v2.6-pro" });
    decide({ family: "fallback", modelId: "openrouter/xiaomi/mimo-v2.6-pro" });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("no override for openrouter/xiaomi/mimo-v2.6-pro");

    // A covered model never warns.
    decide({ family: "claude", modelId: "anthropic/claude-sonnet-5-5" });
    expect(warnings.length).toBe(1);
  });

  test("stays silent when no overrides are configured", () => {
    const { warnings, warn } = captureWarn();
    const decide = createReasoningDecider({}, warn);
    decide({ family: "claude", modelId: "anthropic/claude-opus-5-5" });
    expect(warnings.length).toBe(0);
  });

  test("suffix-driven decisions never warn", () => {
    const { warnings, warn } = captureWarn();
    const decide = createReasoningDecider(
      { "anthropic/claude-sonnet-5-5": { level: "minimal", clear_thinking: true } },
      warn,
    );
    const decision = decide({
      family: "gpt",
      modelId: "openai/gpt-6-luna",
      agentModel: "openai/gpt-6-luna:xhigh",
    });
    expect(decision.source).toBe("suffix");
    expect(warnings.length).toBe(0);
  });
});
