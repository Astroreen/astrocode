import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLY_PATCH_GUIDANCE,
  EDIT_TOOL_GUIDANCE,
  TOOL_LOOP_GUARD,
  getGuards,
} from "../src/prompts/guards";
import { dumpPrompt } from "../src/prompts/dump";
import type { ModelFamily } from "../src/models/resolveFamily";

const EDIT_MODEL_CASES: Array<[ModelFamily, string]> = [
  ["gpt", "gpt-4o"],
  ["gpt", "gpt-oss-20b"],
  ["gpt", "o3-mini"],
  ["gemini", "gemini-2.5-pro"],
  ["kimi", "kimi-k2"],
  ["glm", "glm-4.6"],
  ["grok", "grok-4-5"],
  ["minimax", "minimax-m2"],
  ["openrouter-generic", "deepseek-chat"],
  ["fallback", "x"],
];

describe("getGuards tool-visibility gate", () => {
  test("gpt-5.5 -> apply_patch guidance", () => {
    const g = getGuards("gpt", "gpt-5.5");
    expect(g).toContain(APPLY_PATCH_GUIDANCE);
    expect(g).toContain(TOOL_LOOP_GUARD);
  });

  test.each(EDIT_MODEL_CASES)(
    "%s / %s -> edit guidance, not apply_patch",
    (family, modelID) => {
      const g = getGuards(family, modelID);
      expect(g).toContain(EDIT_TOOL_GUIDANCE);
      expect(g).not.toContain(APPLY_PATCH_GUIDANCE);
      expect(g).toContain(TOOL_LOOP_GUARD);
    },
  );

  test("claude -> empty array", () => {
    expect(getGuards("claude", "claude-opus-5")).toEqual([]);
    expect(getGuards("claude", "claude-opus-5").length).toBe(0);
  });

  test("claude case keeps tool-loop guard out of the system prompt entirely", () => {
    for (const g of getGuards("claude", "claude-sonnet-4-6")) {
      expect(g.includes("tool_loop_guard")).toBe(false);
    }
  });

  test("idempotent: repeated calls return equal, mutation-isolated arrays", () => {
    const a = getGuards("fallback", "x");
    const b = getGuards("fallback", "x");
    expect(a).toEqual(b);
    a.push("MUTATION");
    expect(getGuards("fallback", "x")).toEqual(b);
  });
});

describe("dumpPrompt side-channel", () => {
  const origEnv = process.env.ASTROCODE_DUMP;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.ASTROCODE_DUMP;
    else process.env.ASTROCODE_DUMP = origEnv;
  });

  test("writes valid JSON line(s), appended, when ASTROCODE_DUMP is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-dump-"));
    const path = join(dir, "dump.json");
    process.env.ASTROCODE_DUMP = path;

    dumpPrompt({ family: "claude", system: ["x"] });
    dumpPrompt({ family: "fallback", system: ["y"] });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.family).toBe("claude");
    expect(second.family).toBe("fallback");

    rmSync(dir, { recursive: true, force: true });
  });

  test("no-op (no throw, no file written) when ASTROCODE_DUMP is unset", () => {
    delete process.env.ASTROCODE_DUMP;
    const dir = mkdtempSync(join(tmpdir(), "astrocode-dump-"));
    const path = join(dir, "should-not-exist.json");

    expect(() => dumpPrompt({ family: "claude", system: ["x"], path })).not.toThrow();
    expect(existsSync(path)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});
