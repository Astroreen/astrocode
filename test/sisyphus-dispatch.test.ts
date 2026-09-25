import { test, expect, describe } from "bun:test";
import {
  SISYPHUS_MARKER,
  buildDynamicSisyphusPrompt,
  isSisyphusSession,
} from "../src/prompts/sisyphus/dispatch";
import { buildGrokSisyphusPrompt } from "../src/prompts/sisyphus/families/grok";
import { buildMinimaxSisyphusPrompt } from "../src/prompts/sisyphus/families/minimax";
import { buildGrok45SisyphusPrompt } from "../src/prompts/sisyphus/families/versions/grok-4-5";
import { buildMinimaxSisyphusPrompt as buildMinimaxVersionSisyphusPrompt } from "../src/prompts/sisyphus/families/versions/minimax";

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

describe("grok and minimax families", () => {
  test('("grok","grok-4-9") falls through to the grok family builder', () => {
    const grok = buildDynamicSisyphusPrompt("grok", "grok-4-9");
    expect(grok).toBe(buildGrokSisyphusPrompt());
    expect(grok.includes("<model_version_calibration")).toBe(false);
  });

  test("grok family block is non-empty and distinct from fallback", () => {
    const grok = buildDynamicSisyphusPrompt("grok", "grok-9");
    expect(grok.length).toBeGreaterThan(500);
    expect(grok).not.toBe(buildDynamicSisyphusPrompt("fallback"));
    expect(grok).toBe(buildGrokSisyphusPrompt());
    expect(grok.includes("<grok_calibration>")).toBe(true);
  });

  test('("grok","grok-4-5") version builder output wins over the family builder', () => {
    const versioned = buildDynamicSisyphusPrompt("grok", "grok-4-5");
    expect(versioned).toBe(buildGrok45SisyphusPrompt());
    expect(versioned.includes('version="grok-4-5"')).toBe(true);
    expect(versioned).not.toBe(buildGrokSisyphusPrompt());
  });

  test('("minimax","minimax-m2") resolves to the minimax builder', () => {
    // resolveModelVersion("minimax-m2") === "minimax", so the shipped minimax
    // version prompt keeps priority over the family prompt (version-first).
    const out = buildDynamicSisyphusPrompt("minimax", "minimax-m2");
    expect(out).toBe(buildMinimaxVersionSisyphusPrompt());
    expect(out.includes('version="minimax"')).toBe(true);
  });

  test("minimax family case wires the new minimax family builder", () => {
    const family = buildDynamicSisyphusPrompt("minimax");
    expect(family).toBe(buildMinimaxSisyphusPrompt());
    expect(family.length).toBeGreaterThan(500);
    expect(family).not.toBe(buildDynamicSisyphusPrompt("fallback"));
    expect(family.includes("<minimax_calibration>")).toBe(true);
    expect(family.includes("<model_version_calibration")).toBe(false);
  });

  test("grok and minimax family prompts differ from each other", () => {
    expect(buildGrokSisyphusPrompt()).not.toBe(buildMinimaxSisyphusPrompt());
  });

  test("new family builders never contain the sisyphus marker", () => {
    expect(buildGrokSisyphusPrompt().includes(SISYPHUS_MARKER)).toBe(false);
    expect(buildMinimaxSisyphusPrompt().includes(SISYPHUS_MARKER)).toBe(false);
  });
});