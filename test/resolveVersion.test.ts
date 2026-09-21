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