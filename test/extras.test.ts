import { test, expect, describe, beforeEach, spyOn } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvContext, hasEnvContext, ENV_CONTEXT_MARKER } from "../src/env/context";
import {
  EXTRA_SKILL_PRIORITY,
  linkExtraSkillDirs,
  discoverSkills,
  discoverSkillsWithPriority,
  skillCommandTemplate,
  standardSkillSources,
  stripFrontmatter,
  thinSkillCommandTemplate,
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

    const spy = spyOn(console, "warn").mockImplementation(() => {});
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

    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const skills = discoverSkills([first, second]);
      expect(skills.length).toBe(1);
      expect(skills[0]?.location).toBe(join(first, "dup", "SKILL.md"));
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bundled builtin skills are discovered", () => {
    const bundledDir = join(import.meta.dir, "..", "skills", "builtin");
    const skills = discoverSkillsWithPriority(standardSkillSources([], bundledDir));
    const bundled = skills.filter((skill) => skill.source === "builtin");
    const names = bundled.map((skill) => skill.name);
    expect(names).toContain("commit-message");
    expect(names).toContain("code-review");
    expect(names).toContain("verify-before-done");
    expect(bundled.length).toBe(3);
    for (const skill of bundled) {
      expect(skill.priority).toBe(5);
    }
  });

  test("project skill overrides a bundled skill of the same name", () => {
    const bundledDir = join(import.meta.dir, "..", "skills", "builtin");
    const root = mkdtempSync(join(tmpdir(), "astrocode-override-"));
    const project = join(root, "project");
    const projectSkill = join(project, ".opencode", "skills", "commit-message");
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(
      join(projectSkill, "SKILL.md"),
      "---\nname: commit-message\ndescription: project override\n---\nbody\n",
    );

    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const skills = discoverSkillsWithPriority(standardSkillSources([project], bundledDir));
      const winner = skills.find((skill) => skill.name === "commit-message");
      expect(winner?.location).toBe(join(projectSkill, "SKILL.md"));
      expect(winner?.source).toBe("project-opencode");
      expect(winner?.priority).toBe(60);
      expect(winner?.location).not.toBe(join(bundledDir, "commit-message", "SKILL.md"));
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("extra skill priority stays below user-opencode", () => {
    expect(EXTRA_SKILL_PRIORITY).toBeLessThan(30);
  });

  test("same physical skill reached twice is deduped, not reported as a collision", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-realpath-"));
    const cache = join(root, "cache");
    const userDir = join(root, "user");
    mkdirSync(join(cache, "security-review"), { recursive: true });
    writeFileSync(
      join(cache, "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: bridged\n---\nbody\n",
    );
    mkdirSync(userDir, { recursive: true });
    // Mirrors linkExtraSkillDirs: the cache dir is symlinked into the user dir,
    // so discovery reaches the same physical file from two sources.
    symlinkSync(join(cache, "security-review"), join(userDir, "security-review"), "dir");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = discoverSkillsWithPriority([
        { dir: userDir, priority: 30, label: "user-opencode" },
        { dir: cache, priority: EXTRA_SKILL_PRIORITY, label: "extra" },
      ]);
      expect(skills.length).toBe(1);
      expect(skills[0]?.name).toBe("security-review");
      expect(skills[0]?.source).toBe("user-opencode");
      expect(warnSpy).toHaveBeenCalledTimes(0);
      expect(errorSpy).toHaveBeenCalledTimes(0);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("skillCommandTemplate (oh-my parity)", () => {
  test("stripFrontmatter removes the YAML block, keeps the body", () => {
    const raw = "---\nname: x\ndescription: y\n---\nWrite commits terse.\n";
    expect(stripFrontmatter(raw)).toBe("Write commits terse.\n");
  });

  test("stripFrontmatter is a no-op without frontmatter", () => {
    expect(stripFrontmatter("# plain\n")).toBe("# plain\n");
  });

  test("wraps body in skill-instruction and puts $ARGUMENTS in user-request", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-tmpl-"));
    try {
      const dir = join(root, "caveman-commit");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: caveman-commit\ndescription: commit gen\n---\nWrite commits terse.\n",
      );
      const skills = discoverSkills([root]);
      expect(skills.length).toBe(1);

      const template = skillCommandTemplate(skills[0]!);
      expect(template).toContain("<skill-instruction>");
      expect(template).toContain("Write commits terse.");
      expect(template).not.toContain("name: caveman-commit");
      expect(template).toContain("<user-request>\n$ARGUMENTS\n</user-request>");
      // Body first, user request last (oh-my order).
      expect(template.indexOf("</skill-instruction>")).toBeLessThan(
        template.indexOf("<user-request>"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing SKILL.md falls back to the thin skill-tool template", () => {
    const skill = {
      name: "ghost",
      description: "",
      location: "/definitely/not/here/SKILL.md",
    };
    const template = skillCommandTemplate(skill);
    expect(template).toBe(thinSkillCommandTemplate("ghost"));
    expect(template).toContain('calling the skill tool');
    expect(template).toContain("$ARGUMENTS");
  });

  test("empty body falls back to the thin template", () => {
    const root = mkdtempSync(join(tmpdir(), "astrocode-empty-"));
    try {
      const dir = join(root, "empty");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: empty\n---\n   \n");
      const skills = discoverSkills([root]);
      expect(skills.length).toBe(1);
      expect(skillCommandTemplate(skills[0]!)).toBe(thinSkillCommandTemplate("empty"));
    } finally {
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