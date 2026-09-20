import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COLORS,
  buildNativeOverrides,
  loadPersonas,
  parsePersonaMarkdown,
} from "../src/agents/personas";

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

describe("parsePersonaMarkdown", () => {
  test("parses frontmatter fields and strips them from the prompt", () => {
    const raw = `---
description: "Test agent"
mode: subagent
temperature: 0.1
color: "#123456"
tools:
  read: true
  edit: false
---

You are a test agent.`;

    const persona = parsePersonaMarkdown("tester", raw);
    expect(persona.description).toBe("Test agent");
    expect(persona.mode).toBe("subagent");
    expect(persona.temperature).toBe(0.1);
    expect(persona.color).toBe("#123456");
    expect(persona.tools).toEqual({ read: true, edit: false });
    expect(persona.prompt).toBe("You are a test agent.");
    expect(persona.prompt.includes("---")).toBe(false);
  });

  test("falls back to the default color map and 'all' mode", () => {
    const persona = parsePersonaMarkdown("explore", "body");
    expect(persona.mode).toBe("all");
    expect(persona.color).toBe(DEFAULT_COLORS.explore);
  });
});

describe("loadPersonas", () => {
  test("loads all shipped personas from agents/", () => {
    const personas = loadPersonas(AGENTS_DIR);
    for (const name of [
      "sisyphus",
      "sisyphus-junior",
      "atlas",
      "hephaestus",
      "prometheus",
      "oracle",
      "explore",
      "librarian",
      "metis",
      "momus",
      "multimodal-looker",
    ]) {
      expect(personas[name]?.prompt.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("buildNativeOverrides", () => {
  test("build uses the Sisyphus persona and plan uses the Prometheus persona", () => {
    const base = loadPersonas(AGENTS_DIR);
    const overrides = buildNativeOverrides(base);

    expect(overrides.build.prompt).toBe(base.sisyphus.prompt);
    expect(overrides.plan.prompt).toBe(base.prometheus.prompt);
    expect(overrides.build.mode).toBe("primary");
    expect(overrides.plan.mode).toBe("primary");
    expect(overrides.plan.permission?.edit).toBe("deny");
    expect(overrides.build.color).toBe(DEFAULT_COLORS.build);
  });

  test("every default color is distinct except the native aliases", () => {
    const aliases = new Set(["build", "plan"]);
    const colors = Object.entries(DEFAULT_COLORS).filter(
      ([name]) => !aliases.has(name),
    );
    const unique = new Set(colors.map(([, color]) => color));
    expect(unique.size).toBe(colors.length);
  });
});