import { test, expect, describe, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvContext, hasEnvContext, ENV_CONTEXT_MARKER } from "../src/env/context";
import {
  linkExtraSkillDirs,
  discoverSkills,
  discoverSkillsWithPriority,
} from "../src/skills/extra";
import {
  maybeContinueIdle,
  resetIdleContinuationState,
  getIdleContinuationCount,
} from "../src/idle/continue";

describe("env context", () => {
  test("builds an omo-env block with timezone, locale and today", () => {
    const block = buildEnvContext();
    expect(block).toContain(ENV_CONTEXT_MARKER);
    expect(block).toContain("Timezone:");
    expect(block).toContain("Locale:");
    expect(block).toContain("Today:");
    expect(block).toContain("</omo-env>");
  });

  test("hasEnvContext detects the marker", () => {
    expect(hasEnvContext(["<omo-env>...</omo-env>"])).toBe(true);
    expect(hasEnvContext(["plain"])).toBe(false);
  });
});

describe("linkExtraSkillDirs", () => {
  test("symlinks dirs containing SKILL.md and skips existing", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-skills-"));
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, "good-skill"), { recursive: true });
    writeFileSync(join(source, "good-skill", "SKILL.md"), "# good");
    mkdirSync(join(source, "not-a-skill"), { recursive: true });

    const report = linkExtraSkillDirs([source], target);
    expect(report.linked).toContain("good-skill");
    expect(report.linked).not.toContain("not-a-skill");
    expect(existsSync(join(target, "good-skill", "SKILL.md"))).toBe(true);

    const second = linkExtraSkillDirs([source], target);
    expect(second.skipped).toContain("good-skill");

    rmSync(root, { recursive: true, force: true });
  });

  test("empty list is a no-op", () => {
    const report = linkExtraSkillDirs([]);
    expect(report).toEqual({ linked: [], skipped: [], errors: [] });
  });
});

describe("discoverSkills", () => {
  test("parses name and folded description from frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-disc-"));
    mkdirSync(join(root, "caveman"), { recursive: true });
    writeFileSync(
      join(root, "caveman", "SKILL.md"),
      "---\nname: caveman\ndescription: >\n  Ultra-compressed mode.\n  Cuts tokens 65%.\n---\nbody\n",
    );
    mkdirSync(join(root, "plain"), { recursive: true });
    writeFileSync(join(root, "plain", "SKILL.md"), "# no frontmatter\n");

    const skills = discoverSkills([root]);
    expect(skills.length).toBe(1);
    expect(skills[0]?.name).toBe("caveman");
    expect(skills[0]?.description).toBe("Ultra-compressed mode. Cuts tokens 65%.");

    rmSync(root, { recursive: true, force: true });
  });

  test("dedupes and tolerates missing dirs", () => {
    expect(discoverSkills(["/definitely/not/here"]).length).toBe(0);
  });

  test("higher-priority source wins on a name collision", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-prio-"));
    const low = join(root, "low");
    const high = join(root, "high");
    mkdirSync(join(low, "dup"), { recursive: true });
    mkdirSync(join(high, "dup"), { recursive: true });
    writeFileSync(join(low, "dup", "SKILL.md"), "---\nname: dup\n---\nbody\n");
    writeFileSync(join(high, "dup", "SKILL.md"), "---\nname: dup\n---\nbody\n");

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = discoverSkillsWithPriority([
        { dir: low, priority: 10, label: "low" },
        { dir: high, priority: 60, label: "high" },
      ]);
      expect(skills.length).toBe(1);
      expect(skills[0]?.location).toBe(join(high, "dup", "SKILL.md"));
      expect(skills[0]?.source).toBe("high");
      expect(skills[0]?.priority).toBe(60);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy discoverSkills keeps first-dir-wins", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-legacy-"));
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(join(first, "dup"), { recursive: true });
    mkdirSync(join(second, "dup"), { recursive: true });
    writeFileSync(join(first, "dup", "SKILL.md"), "---\nname: dup\n---\nbody\n");
    writeFileSync(join(second, "dup", "SKILL.md"), "---\nname: dup\n---\nbody\n");

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = discoverSkills([first, second]);
      expect(skills.length).toBe(1);
      expect(skills[0]?.location).toBe(join(first, "dup", "SKILL.md"));
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fakeClient(todos: unknown[]) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      session: {
        todo: async () => ({ data: todos }),
        prompt: async (args: unknown) => {
          sent.push(args);
          return { data: {} };
        },
      },
    } as any,
  };
}

describe("idle continuation", () => {
  beforeEach(() => {
    resetIdleContinuationState();
  });

  test("continues when todos are unfinished", async () => {
    const { client, sent } = fakeClient([
      { status: "completed", content: "done" },
      { status: "pending", content: "remaining work" },
    ]);
    const result = await maybeContinueIdle(client, "s1");
    expect(result.continued).toBe(true);
    expect(sent.length).toBe(1);
    expect(getIdleContinuationCount("s1")).toBe(1);
  });

  test("does not continue when all todos are done", async () => {
    const { client, sent } = fakeClient([{ status: "completed", content: "x" }]);
    const result = await maybeContinueIdle(client, "s2");
    expect(result.continued).toBe(false);
    expect(result.reason).toBe("all-done");
    expect(sent.length).toBe(0);
  });

  test("does not continue without todos", async () => {
    const { client, sent } = fakeClient([]);
    const result = await maybeContinueIdle(client, "s3");
    expect(result.reason).toBe("no-todos");
    expect(sent.length).toBe(0);
  });

  test("stops after the per-session cap", async () => {
    const { client } = fakeClient([{ status: "pending", content: "x" }]);
    await maybeContinueIdle(client, "s4", { max: 1 });
    const again = await maybeContinueIdle(client, "s4", { max: 1 });
    expect(again.continued).toBe(false);
    expect(again.reason).toBe("max-reached");
  });
});