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

  test("known version composes family body plus version calibration", () => {
    const claude = buildDynamicSisyphusPrompt("claude");
    const versioned = buildDynamicSisyphusPrompt("claude", "claude-opus-4-7");
    expect(versioned.startsWith(claude)).toBe(true);
    expect(versioned.includes("<model_version_calibration")).toBe(true);
    expect(versioned.includes('version="claude-opus-4-7"')).toBe(true);
  });

  test("unknown version falls back to the plain family body", () => {
    const claude = buildDynamicSisyphusPrompt("claude");
    const unmatched = buildDynamicSisyphusPrompt("claude", "claude-sonnet-4-6");
    expect(unmatched).toBe(claude);
    expect(unmatched.includes("<model_version_calibration")).toBe(false);
  });

  test("kimi version composes kimi family body plus k3 calibration", () => {
    const kimi = buildDynamicSisyphusPrompt("kimi");
    const versioned = buildDynamicSisyphusPrompt("kimi", "kimi-k3");
    expect(versioned.startsWith(kimi)).toBe(true);
    expect(versioned.includes("<model_version_calibration")).toBe(true);
    expect(versioned.includes('version="kimi-k3"')).toBe(true);
  });

  test("one-arg fallback call still works", () => {
    const fallback = buildDynamicSisyphusPrompt("fallback");
    expect(fallback.length).toBeGreaterThan(500);
    expect(fallback.includes("<model_version_calibration")).toBe(false);
  });
});