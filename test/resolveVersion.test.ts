import { test, expect, describe } from "bun:test";
import { resolveModelVersion } from "../src/models/resolveVersion";

describe("resolveModelVersion", () => {
  test("claude versions", () => {
    expect(resolveModelVersion("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(resolveModelVersion("claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(resolveModelVersion("claude-fable-5")).toBe("claude-fable");
    expect(resolveModelVersion("claude-mythos-preview")).toBe("claude-mythos");
  });

  test("kimi versions", () => {
    expect(resolveModelVersion("kimi-k2.7")).toBe("kimi-k2-7");
    expect(resolveModelVersion("kimi-k3")).toBe("kimi-k3");
    expect(resolveModelVersion("swe-2")).toBe("kimi-swe-2");
  });

  test("grok versions", () => {
    expect(resolveModelVersion("grok-4.5")).toBe("grok-4-5");
    expect(resolveModelVersion("grok-4.6-fast")).toBe("grok-4-6");
    expect(resolveModelVersion("grok-4.20")).toBeUndefined();
  });

  test("minimax and unknown", () => {
    expect(resolveModelVersion("minimax-m2")).toBe("minimax");
    expect(resolveModelVersion("gpt-5")).toBeUndefined();
    expect(resolveModelVersion("")).toBeUndefined();
    expect(resolveModelVersion(undefined as unknown as string)).toBeUndefined();
  });
});

describe("digit boundaries and ordering", () => {
  test("plan acceptance fixtures", () => {
    expect(resolveModelVersion("claude-opus-5-5")).toBeUndefined();
    expect(resolveModelVersion("claude-opus-5")).toBe("claude-opus-5");
    expect(resolveModelVersion("moonshotai/swe-2")).toBe("kimi-swe-2");
    expect(resolveModelVersion("kimi-k2.7")).toBe("kimi-k2-7");
    expect(resolveModelVersion("grok-4-5")).toBe("grok-4-5");
    expect(resolveModelVersion("grok-4-51")).toBeUndefined();
  });

  test("never eats digit prefix of a longer number (k2-6 vs k2-6.5)", () => {
    expect(resolveModelVersion("kimi-k2-6.5")).toBeUndefined();
    expect(resolveModelVersion("kimi-k2-65")).toBeUndefined();
    expect(resolveModelVersion("kimi-k2-6")).toBe("kimi-k2-6");
    expect(resolveModelVersion("kimi-k2.6")).toBe("kimi-k2-6");
    expect(resolveModelVersion("kimi-k2.8")).toBe("kimi-k2-8");
    expect(resolveModelVersion("claude-opus-4-7-2")).toBeUndefined();
    expect(resolveModelVersion("swe-2-5")).toBeUndefined();
    expect(resolveModelVersion("kimi-swe-2")).toBe("kimi-swe-2");
  });
});