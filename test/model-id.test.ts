import { describe, expect, test } from "bun:test";
import { formatModelString, parseModelString } from "../src/models/model-id";

describe("parseModelString", () => {
  test.each([
    ["a/b", { providerID: "a", modelID: "b" }],
    ["a/b/c", { providerID: "a", modelID: "b/c" }],
    ["  anthropic/claude-sonnet-4-6  ", { providerID: "anthropic", modelID: "claude-sonnet-4-6" }],
  ])("parses %j", (input, expected) => {
    expect(parseModelString(input)).toEqual(expected);
  });

  test.each([
    "/b", // slash at index 0
    "a/", // slash is last character
    "a", // no slash
    "", // empty
    "   ", // whitespace only
    undefined, // undefined input
  ])("returns undefined for %j", (input) => {
    expect(parseModelString(input)).toBeUndefined();
  });
});

describe("formatModelString", () => {
  test("formats provider/model", () => {
    expect(formatModelString({ providerID: "a", modelID: "b/c" })).toBe("a/b/c");
  });

  test("round-trips with parseModelString", () => {
    const refs = [
      { providerID: "anthropic", modelID: "claude-opus-5" },
      { providerID: "openrouter", modelID: "deepseek/gpt-oss-120b" },
      { providerID: "moonshotai", modelID: "kimi-k2-7" },
    ];
    for (const ref of refs) {
      expect(parseModelString(formatModelString(ref))).toEqual(ref);
    }
  });
});
