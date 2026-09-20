import { test, expect, describe } from "bun:test";
import { buildBuiltinCommands } from "../src/commands";

describe("buildBuiltinCommands", () => {
  test("returns all 7 ported builtin commands", () => {
    const commands = buildBuiltinCommands();
    expect(Object.keys(commands).sort()).toEqual([
      "goal",
      "handoff",
      "hyperplan",
      "refactor",
      "remove-ai-slops",
      "start-work",
      "stop-continuation",
    ]);
  });

  test("every command has a non-empty template and description", () => {
    const commands = buildBuiltinCommands();
    for (const [name, def] of Object.entries(commands)) {
      expect(def.template.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect((def.description ?? "").length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("refactor command interpolates $ARGUMENTS", () => {
    const commands = buildBuiltinCommands();
    expect(commands.refactor.template).toContain("$ARGUMENTS");
  });

  test("start-work runs in the atlas agent", () => {
    const commands = buildBuiltinCommands();
    expect(commands["start-work"].agent).toBe("atlas");
  });

  test("no oh-my-openagent-only tool syntax leaked into executable template text", () => {
    const commands = buildBuiltinCommands();
    const forbidden = [
      "call_omo_agent",
      "background_output",
      "background_cancel",
      "load_skills=",
      "run_in_background=true",
      "category=",
    ];
    // HTML comments intentionally document the omitted oh-my machinery
    // (see docs/porting-plan.md decision #2), so strip them before checking.
    const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
    for (const [name, def] of Object.entries(commands)) {
      const body = stripComments(def.template);
      for (const needle of forbidden) {
        expect(body.includes(needle)).toBe(false);
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });
});