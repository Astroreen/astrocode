import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAstrocodeConfig, sanitizeJsonc } from "../src/config/astrocode";
import { parseFallbackConfig } from "../src/fallback/config";

describe("sanitizeJsonc", () => {
  test("strips line and block comments and trailing commas", () => {
    const input = `{
      // line comment
      "a": 1, /* block */
      "b": [1, 2,],
    }`;
    expect(JSON.parse(sanitizeJsonc(input))).toEqual({ a: 1, b: [1, 2] });
  });

  test("does not strip comment-like text inside strings", () => {
    const input = `{ "url": "https://x/y//z", "note": "a /* b */ c" }`;
    expect(JSON.parse(sanitizeJsonc(input))).toEqual({
      url: "https://x/y//z",
      note: "a /* b */ c",
    });
  });
});

describe("parseFallbackConfig", () => {
  test("accepts per-agent fallback_models (and legacy models)", () => {
    const config = parseFallbackConfig({
      enabled: true,
      models: ["global/one"],
      agents: {
        sisyphus: { fallback_models: ["anthropic/claude-sonnet-4-6"] },
        legacy: { models: ["x/y"] },
      },
    });
    expect(config.agents.sisyphus.models).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(config.agents.legacy.models).toEqual(["x/y"]);
    expect(config.models).toEqual(["global/one"]);
  });
});

describe("loadAstrocodeConfig", () => {
  test("reads the dedicated file and lets inline options override it", () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-"));
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(
      join(dir, ".opencode", "astrocode.jsonc"),
      `{
        // dedicated astrocode config
        "agents": { "oracle": { "model": "anthropic/claude-opus-4-6", "fallback_models": ["a/b"], "color": "#E74C3C" } },
        "fallback": { "enabled": true, "models": ["file/chain"] }
      }`,
    );

    const fromFile = loadAstrocodeConfig([dir]);
    expect(fromFile.agents.oracle?.model).toBe("anthropic/claude-opus-4-6");
    expect(fromFile.agents.oracle?.fallbackModels).toEqual(["a/b"]);
    expect(fromFile.agents.oracle?.color).toBe("#E74C3C");
    expect(fromFile.fallback.enabled).toBe(true);
    expect(fromFile.fallback.models).toEqual(["file/chain"]);

    const withInline = loadAstrocodeConfig([dir], {
      fallback: { enabled: false, models: ["inline/chain"] },
      agents: { oracle: { model: "inline/model" } },
    });
    expect(withInline.fallback.enabled).toBe(false);
    expect(withInline.fallback.models).toEqual(["inline/chain"]);
    expect(withInline.agents.oracle?.model).toBe("inline/model");
    // fallback_models from the file survive an unrelated inline override
    expect(withInline.agents.oracle?.fallbackModels).toEqual(["a/b"]);
  });

  test("missing file yields defaults plus inline options", () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-empty-"));
    const config = loadAstrocodeConfig([dir], { fallback: { enabled: true } });
    expect(config.fallback.enabled).toBe(true);
    expect(config.fallback.models).toEqual([]);
    expect(config.agents).toEqual({});
  });
});