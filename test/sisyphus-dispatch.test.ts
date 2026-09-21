import { test, expect, describe } from "bun:test";
import {
  SISYPHUS_MARKER,
  buildDynamicSisyphusPrompt,
  isSisyphusSession,
} from "../src/prompts/sisyphus/dispatch";

describe("isSisyphusSession", () => {
  test("detects the marker in the system array", () => {
    expect(isSisyphusSession([SISYPHUS_MARKER])).toBe(true);
    expect(
      isSisyphusSession(["some other prompt", `role text ${SISYPHUS_MARKER} more`]),
    ).toBe(true);
  });

  test("returns false without the marker", () => {
    expect(isSisyphusSession(["unrelated system prompt"])).toBe(false);
    expect(isSisyphusSession([])).toBe(false);
  });
});

describe("buildDynamicSisyphusPrompt", () => {
  test("produces non-empty, family-specific prompts", () => {
    const claude = buildDynamicSisyphusPrompt("claude");
    const generic = buildDynamicSisyphusPrompt("openrouter-generic");
    expect(claude.length).toBeGreaterThan(500);
    expect(generic.length).toBeGreaterThan(500);
    // claude family gets its own calibration block, generic does not.
    expect(claude.includes("<self_knowledge>")).toBe(true);
    expect(generic.includes("<glm_calibration>")).toBe(false);
  });

  test("gemini reuses fallback plus its override blocks", () => {
    const gemini = buildDynamicSisyphusPrompt("gemini");
    const fallback = buildDynamicSisyphusPrompt("fallback");
    expect(gemini.includes("<gemini_tool_call_mandate>")).toBe(true);
    expect(gemini.includes("<gemini_verification_override>")).toBe(true);
    expect(gemini.startsWith(fallback)).toBe(true);
    expect(gemini.length).toBeGreaterThan(fallback.length);
  });

  test("openrouter-generic uses the fallback family prompt", () => {
    expect(buildDynamicSisyphusPrompt("openrouter-generic")).toBe(
      buildDynamicSisyphusPrompt("fallback"),
    );
  });

  test("switching family changes the generated prompt (post-fallback re-injection)", () => {
    expect(buildDynamicSisyphusPrompt("claude")).not.toBe(
      buildDynamicSisyphusPrompt("openrouter-generic"),
    );
  });
});