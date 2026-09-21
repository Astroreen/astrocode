import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_DISPLAY_NAMES,
  DEFAULT_AGENT,
  DEFAULT_COLORS,
  DEMOTED_NATIVE_AGENTS,
  getAgentDisplayName,
  loadPersonas,
  parsePersonaMarkdown,
  toAgentConfigs,
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

describe("oh-my display names", () => {
  test("maps agent keys to the exact oh-my-openagent display names", () => {
    expect(getAgentDisplayName("sisyphus")).toBe("Sisyphus - ultraworker");
    expect(getAgentDisplayName("hephaestus")).toBe("Hephaestus - Deep Agent");
    expect(getAgentDisplayName("prometheus")).toBe("Prometheus - Plan Builder");
    expect(getAgentDisplayName("atlas")).toBe("Atlas - Plan Executor");
    expect(getAgentDisplayName("sisyphus-junior")).toBe("Sisyphus-Junior");
    expect(getAgentDisplayName("metis")).toBe("Metis - Plan Consultant");
    expect(getAgentDisplayName("momus")).toBe("Momus - Plan Critic");
    expect(getAgentDisplayName("oracle")).toBe("oracle");
    expect(getAgentDisplayName("explore")).toBe("explore");
    expect(getAgentDisplayName("unknown-agent")).toBe("unknown-agent");
  });

  test("default agent is the Sisyphus display name (replaces build)", () => {
    expect(DEFAULT_AGENT).toBe(AGENT_DISPLAY_NAMES.sisyphus);
    expect(DEFAULT_AGENT).toBe("Sisyphus - ultraworker");
  });

  test("build and plan are demoted native agents", () => {
    expect([...DEMOTED_NATIVE_AGENTS]).toEqual(["build", "plan"]);
  });
});

describe("toAgentConfigs", () => {
  test("keys agents by display name and applies per-agent settings", () => {
    const base = loadPersonas(AGENTS_DIR);
    const configs = toAgentConfigs(base, (key) =>
      key === "sisyphus"
        ? { model: "anthropic/claude-sonnet-4-6", color: "#000000" }
        : undefined,
    );
    expect(Object.keys(configs)).toContain("Sisyphus - ultraworker");
    expect(Object.keys(configs)).toContain("Prometheus - Plan Builder");
    expect(configs["Sisyphus - ultraworker"].model).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(configs["Sisyphus - ultraworker"].color).toBe("#000000");
    expect(configs["Sisyphus - ultraworker"].prompt).toBe(base.sisyphus.prompt);
    expect(configs.oracle.color).toBe(DEFAULT_COLORS.oracle);
  });
});

describe("DEFAULT_COLORS", () => {
  test("every default color is distinct", () => {
    const colors = Object.entries(DEFAULT_COLORS);
    const unique = new Set(colors.map(([, color]) => color));
    expect(unique.size).toBe(colors.length);
  });
});