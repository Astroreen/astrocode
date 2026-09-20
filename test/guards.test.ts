import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLY_PATCH_GUIDANCE, TOOL_LOOP_GUARD, getGuards } from "../src/prompts/guards";
import { dumpPrompt } from "../src/prompts/dump";
import type { ModelFamily } from "../src/models/resolveFamily";

const NON_CLAUDE_FAMILIES: ModelFamily[] = [
  "gpt",
  "gemini",
  "kimi",
  "glm",
  "openrouter-generic",
  "fallback",
];

describe("getGuards family mapping", () => {
  test("claude -> empty array", () => {
    expect(getGuards("claude")).toEqual([]);
    expect(getGuards("claude").length).toBe(0);
  });

  test.each(NON_CLAUDE_FAMILIES)(
    "%s contains anti-tool-loop guard text",
    (family) => {
      const g = getGuards(family);
      expect(g.length).toBeGreaterThan(0);
      expect(
        g.some((s) => s.includes("Never call the same tool with the same arguments more than twice in a row")),
      ).toBe(true);
      expect(g).toContain(TOOL_LOOP_GUARD);
      expect(g).toContain(APPLY_PATCH_GUIDANCE);
    },
  );

  test("all non-claude families return identical guard sets", () => {
    const sets = NON_CLAUDE_FAMILIES.map((f) => getGuards(f));
    for (const s of sets) expect(s).toEqual(sets[0]);
  });

  test("idempotent: repeated calls return equal, mutation-isolated arrays", () => {
    const a = getGuards("fallback");
    const b = getGuards("fallback");
    expect(a).toEqual(b);
    a.push("MUTATION");
    expect(getGuards("fallback")).toEqual(b);
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
