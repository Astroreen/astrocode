import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
  test("parses global settings; ignores fallback.agents input", () => {
    const config = parseFallbackConfig({
      enabled: true,
      models: ["global/one"],
      agents: {
        sisyphus: { fallback_models: ["ignored/chain"] },
      },
    });
    expect(config.enabled).toBe(true);
    expect(config.models).toEqual(["global/one"]);
    // single source of truth: top-level agents[].fallback_models, bridged by
    // loadAstrocodeConfig — a raw fallback.agents input is NOT parsed
    expect(config.agents).toEqual({});
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
    // top-level agents[].fallback_models bridges into the fallback engine
    expect(fromFile.fallback.agents.oracle?.models).toEqual(["a/b"]);

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

  test("parses sampling, skills, idleContinuation and reasoning", () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-extras-"));
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(
      join(dir, ".opencode", "astrocode.jsonc"),
      `{
        "sampling": { "claude": { "temperature": 0.4, "topP": 0.8 } },
        "skills": { "extraDirs": ["/tmp/skills-a", "/tmp/skills-b"] },
        "idleContinuation": { "enabled": true, "max": 5 },
        "reasoning": { "enabled": false }
      }`,
    );

    const config = loadAstrocodeConfig([dir]);
    expect(config.sampling.claude).toEqual({ temperature: 0.4, topP: 0.8 });
    expect(config.skills.extraDirs).toEqual(["/tmp/skills-a", "/tmp/skills-b"]);
    expect(config.idleContinuation).toEqual({ enabled: true, max: 5 });
    expect(config.reasoning.enabled).toBe(false);

    // Defaults when absent.
    const defaults = loadAstrocodeConfig([]);
    expect(defaults.sampling).toEqual({});
    expect(defaults.skills.extraDirs).toEqual([]);
    expect(defaults.idleContinuation.enabled).toBe(false);
    expect(defaults.reasoning.enabled).toBe(true);
  });

  test("fallback.agents input is ignored; top-level agents is the only source", () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-bridge-"));
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(
        join(dir, ".opencode", "astrocode.jsonc"),
        JSON.stringify({
          agents: { oracle: { fallback_models: ["top/chain"] } },
          fallback: {
            agents: { oracle: { fallback_models: ["ignored/chain"] } },
          },
        }),
      );

      const config = loadAstrocodeConfig([dir]);
      expect(config.fallback.agents.oracle?.models).toEqual(["top/chain"]);
      expect(config.agents.oracle?.fallbackModels).toEqual(["top/chain"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file yields defaults plus inline options", () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-empty-"));
    const config = loadAstrocodeConfig([dir], { fallback: { enabled: true } });
    expect(config.fallback.enabled).toBe(true);
    expect(config.fallback.models).toEqual([]);
    expect(config.agents).toEqual({});
  });
});

describe("loadAstrocodeConfig walk-up layers", () => {
  function makeLayers(): { root: string; home: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), "astrocode-layers-"));
    const home = join(root, "home");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    return { root, home, project };
  }

  test("nearest layer wins for fallback.max_attempts", () => {
    const { root, home, project } = makeLayers();
    try {
      writeFileSync(
        join(home, "astrocode.json"),
        JSON.stringify({ fallback: { max_attempts: 5 } }),
      );
      writeFileSync(
        join(project, "astrocode.json"),
        JSON.stringify({ fallback: { max_attempts: 2 } }),
      );

      const config = loadAstrocodeConfig([project]);
      expect(config.fallback.max_attempts).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("per-agent merge: nearest model wins, farther color survives", () => {
    const { root, home, project } = makeLayers();
    try {
      writeFileSync(
        join(home, "astrocode.json"),
        JSON.stringify({
          agents: { sisyphus: { model: "home/model", color: "#00CED1" } },
        }),
      );
      writeFileSync(
        join(project, "astrocode.json"),
        JSON.stringify({ agents: { sisyphus: { model: "project/model" } } }),
      );

      const config = loadAstrocodeConfig([project]);
      expect(config.agents.sisyphus?.model).toBe("project/model");
      expect(config.agents.sisyphus?.color).toBe("#00CED1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skills.extraDirs is fully replaced by the nearest layer", () => {
    const { root, home, project } = makeLayers();
    try {
      writeFileSync(
        join(home, "astrocode.json"),
        JSON.stringify({ skills: { extraDirs: ["/far/a", "/far/b"] } }),
      );
      writeFileSync(
        join(project, "astrocode.json"),
        JSON.stringify({ skills: { extraDirs: ["/near/c"] } }),
      );

      const config = loadAstrocodeConfig([project]);
      expect(config.skills.extraDirs).toEqual(["/near/c"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed nearest layer is skipped, farther layer still applies", () => {
    const { root, home, project } = makeLayers();
    try {
      writeFileSync(
        join(home, "astrocode.json"),
        JSON.stringify({ fallback: { max_attempts: 5 } }),
      );
      writeFileSync(join(project, "astrocode.json"), "{ not valid json ");

      const config = loadAstrocodeConfig([project]);
      expect(config.fallback.max_attempts).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});