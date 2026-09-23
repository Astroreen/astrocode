import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import astrocodePlugin from "../src/index";
import {
  clearAllSessionModels,
  getSessionModelState,
  setSessionFallbackModel,
} from "../src/fallback/session-model";
import {
  maybeContinueIdle,
  resetIdleContinuationState,
} from "../src/idle/continue";
import { clearChildSessions, isChildSession } from "../src/fallback/subagent";

describe("astrocode plugin — experimental.chat.system.transform", () => {
  test("appends guards for cheap-openrouter model, preserves base", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = { system: ["BASE"] };
    const input = {
      sessionID: "s1",
      model: { id: "deepseek/deepseek-chat", providerID: "openrouter" } as any,
    };

    await hooks["experimental.chat.system.transform"]!(
      input as any,
      output as any,
    );

    expect(output.system[0]).toBe("BASE");
    expect(output.system.some((s) => s.includes("tool_loop_guard"))).toBe(
      true,
    );
  });

  test("claude model: no guard appended, base untouched", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = { system: ["BASE"] };
    const input = {
      sessionID: "s2",
      model: { id: "claude-sonnet-4-6", providerID: "anthropic" } as any,
    };

    await hooks["experimental.chat.system.transform"]!(
      input as any,
      output as any,
    );

    // No defensive guard for claude, and the base entry is still first/untouched.
    expect(output.system[0]).toBe("BASE");
    expect(output.system.some((s: string) => s.includes("tool_loop_guard"))).toBe(false);
    // Env/date context is appended for every agent.
    expect(output.system.some((s: string) => s.includes("<omo-env>"))).toBe(true);
  });

  test("malformed output (no system array) -> graceful no-op", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = {} as any;
    const input = {
      sessionID: "s3",
      model: { id: "x", providerID: "y" } as any,
    };

    await expect(
      hooks["experimental.chat.system.transform"]!(input as any, output),
    ).resolves.toBeUndefined();
  });

  test("idempotent re-invocation: guard block appears exactly once", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = { system: ["BASE"] };
    const input = {
      sessionID: "s4",
      model: { id: "deepseek/deepseek-chat", providerID: "openrouter" } as any,
    };

    await hooks["experimental.chat.system.transform"]!(
      input as any,
      output as any,
    );
    await hooks["experimental.chat.system.transform"]!(
      input as any,
      output as any,
    );

    const occurrences = output.system.filter((s) =>
      s.includes("tool_loop_guard"),
    ).length;
    expect(occurrences).toBe(1);
  });

  test("unknown model -> fallback guards applied", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = { system: ["BASE"] };
    const input = {
      sessionID: "s5",
      model: { id: "some-unknown-model", providerID: "unknown" } as any,
    };

    await hooks["experimental.chat.system.transform"]!(
      input as any,
      output as any,
    );

    expect(output.system.some((s) => s.includes("tool_loop_guard"))).toBe(
      true,
    );
  });
});

describe("astrocode plugin — chat.params", () => {
  test("cheap-openrouter model gets temperature + topP override", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = { temperature: 1, topP: 1, topK: 0, options: {} };
    const input = {
      sessionID: "s6",
      agent: "sisyphus",
      model: { id: "deepseek/deepseek-chat", providerID: "openrouter" } as any,
      provider: {} as any,
      message: {} as any,
    };

    await hooks["chat.params"]!(input as any, output as any);

    expect(output.temperature).toBe(0.3);
    expect(output.topP).toBe(0.9);
  });

  test("claude model leaves sampling defaults untouched", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = { temperature: 1, topP: 1, topK: 0, options: {} };
    const input = {
      sessionID: "s7",
      agent: "sisyphus",
      model: { id: "claude-sonnet-4-6", providerID: "anthropic" } as any,
      provider: {} as any,
      message: {} as any,
    };

    await hooks["chat.params"]!(input as any, output as any);

    expect(output.temperature).toBe(1);
    expect(output.topP).toBe(1);
  });

  test("malformed output (null) -> graceful no-op", async () => {
    const hooks = await astrocodePlugin({} as any);
    const input = {
      sessionID: "s8",
      agent: "sisyphus",
      model: { id: "x", providerID: "y" } as any,
      provider: {} as any,
      message: {} as any,
    };

    await expect(
      hooks["chat.params"]!(input as any, null as any),
    ).resolves.toBeUndefined();
  });
});

describe("astrocode plugin — AGENTS.md directory context", () => {
  test("injects [Directory Context: once and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-agents-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Project Rules\nbe nice\n");
      const hooks = await astrocodePlugin({ directory: dir } as any);
      const output = { system: ["BASE"] };
      const input = {
        sessionID: "agents-1",
        model: { id: "claude-sonnet-4-6", providerID: "anthropic" } as any,
      };

      await hooks["experimental.chat.system.transform"]!(
        input as any,
        output as any,
      );
      const first = output.system.filter((s) =>
        s.includes("[Directory Context:"),
      ).length;
      expect(first).toBe(1);

      await hooks["experimental.chat.system.transform"]!(
        input as any,
        output as any,
      );
      const second = output.system.filter((s) =>
        s.includes("[Directory Context:"),
      ).length;
      expect(second).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no directory -> no AGENTS.md injection", async () => {
    const hooks = await astrocodePlugin({} as any);
    const output = { system: ["BASE"] };
    const input = {
      sessionID: "agents-2",
      model: { id: "claude-sonnet-4-6", providerID: "anthropic" } as any,
    };

    await hooks["experimental.chat.system.transform"]!(
      input as any,
      output as any,
    );

    expect(
      output.system.some((s) => s.includes("[Directory Context:")),
    ).toBe(false);
  });
});

describe("astrocode plugin — abort detection", () => {
  test("session.error MessageAbortedError records the abort window", async () => {
    resetIdleContinuationState();
    const client = {
      session: {
        todo: async () => ({
          data: [{ status: "pending", content: "task" }],
        }),
        prompt: async () => ({ data: {} }),
      },
    } as any;

    const hooks = await astrocodePlugin({ client } as any);
    await hooks.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID: "abort-s1",
          error: { name: "MessageAbortedError" },
        },
      },
    } as any);

    const result = await maybeContinueIdle(client, "abort-s1");
    expect(result.continued).toBe(false);
    expect(result.reason).toBe("abort-window");
  });
});

describe("astrocode plugin — chat.message fallback pin", () => {
  const ORIGINAL = "anthropic/claude-sonnet-4-6";
  const FALLBACK = "openrouter/~deepseek/deepseek-flash-latest";
  const parsedFallback = {
    providerID: "openrouter",
    modelID: "~deepseek/deepseek-flash-latest",
  };
  const claude = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };

  function messageOutput(model: { providerID: string; modelID: string }) {
    return { message: { model: { ...model } }, parts: [] } as any;
  }

  test("no pinned session -> message untouched", async () => {
    clearAllSessionModels();
    const hooks = await astrocodePlugin({} as any);
    const output = messageOutput(claude);

    await hooks["chat.message"]!(
      { sessionID: "cm-none", model: { ...claude } } as any,
      output,
    );

    expect(output.message.model).toEqual(claude);
  });

  test("fresh pin overrides a stale primary-model request", async () => {
    clearAllSessionModels();
    setSessionFallbackModel("cm-fresh", ORIGINAL, FALLBACK);
    const hooks = await astrocodePlugin({} as any);
    const output = messageOutput(claude);

    await hooks["chat.message"]!(
      { sessionID: "cm-fresh", model: { ...claude } } as any,
      output,
    );

    expect(output.message.model).toEqual(parsedFallback);
  });

  test("stale pin restores the primary and drops the state", async () => {
    clearAllSessionModels();
    setSessionFallbackModel("cm-stale", ORIGINAL, FALLBACK, Date.now() - 120_000);
    const hooks = await astrocodePlugin({} as any);
    const output = messageOutput(claude);

    await hooks["chat.message"]!(
      { sessionID: "cm-stale", model: { ...claude } } as any,
      output,
    );

    expect(output.message.model).toEqual(claude);
    expect(getSessionModelState("cm-stale")).toBeUndefined();
  });

  test("manual switch to a third model clears the pin", async () => {
    clearAllSessionModels();
    setSessionFallbackModel("cm-manual", ORIGINAL, FALLBACK);
    const hooks = await astrocodePlugin({} as any);
    const third = { providerID: "openai", modelID: "gpt-4o" };
    const output = messageOutput(third);

    await hooks["chat.message"]!(
      { sessionID: "cm-manual", model: { ...third } } as any,
      output,
    );

    expect(output.message.model).toEqual(third);
    expect(getSessionModelState("cm-manual")).toBeUndefined();
  });

  test("request already on the fallback -> no rewrite, pin refreshed", async () => {
    clearAllSessionModels();
    setSessionFallbackModel("cm-same", ORIGINAL, FALLBACK, Date.now() - 120_000);
    const hooks = await astrocodePlugin({} as any);
    const output = messageOutput(parsedFallback);

    await hooks["chat.message"]!(
      { sessionID: "cm-same", model: { ...parsedFallback } } as any,
      output,
    );

    expect(getSessionModelState("cm-same")).toBeDefined();
    expect(output.message.model).toEqual(parsedFallback);
  });

  test("no requested model -> forces the fallback", async () => {
    clearAllSessionModels();
    setSessionFallbackModel("cm-nomodel", ORIGINAL, FALLBACK);
    const hooks = await astrocodePlugin({} as any);
    const output = messageOutput(claude);

    await hooks["chat.message"]!({ sessionID: "cm-nomodel" } as any, output);

    expect(output.message.model).toEqual(parsedFallback);
  });
});

describe("astrocode plugin — skill slash commands (oh-my parity)", () => {
  test("config injects skill command with full body + <user-request>", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-skillcmd-"));
    try {
      const skillDir = join(dir, ".opencode", "skills", "demo-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: demo-skill\ndescription: demo\ndemo body line\n---\nDo the demo thing.\n",
      );

      const hooks = await astrocodePlugin({ directory: dir } as any);
      const cfg = { command: {} } as any;
      await hooks.config!(cfg);

      const def = cfg.command["demo-skill"];
      expect(def).toBeDefined();
      expect(def.template).toContain("<skill-instruction>");
      expect(def.template).toContain("Do the demo thing.");
      expect(def.template).toContain("<user-request>\n$ARGUMENTS\n</user-request>");
      expect(def.template.indexOf("</skill-instruction>")).toBeLessThan(
        def.template.indexOf("<user-request>"),
      );
      expect(def.description).toContain("Skill:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing command with the same name is not clobbered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-skillcmd2-"));
    try {
      const skillDir = join(dir, ".opencode", "skills", "refactor");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: refactor\ndescription: skill version\n---\nskill body\n",
      );

      const hooks = await astrocodePlugin({ directory: dir } as any);
      const cfg = { command: { refactor: { template: "USER COMMAND" } } } as any;
      await hooks.config!(cfg);

      expect(cfg.command.refactor.template).toBe("USER COMMAND");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("astrocode plugin — subagent session tracking", () => {
  const enabledOptions = {
    fallback: { enabled: true, models: ["openrouter/x/y"] },
  };

  test("session.created with parentID registers the child; deleted removes it", async () => {
    clearChildSessions();
    const hooks = await astrocodePlugin({} as any, enabledOptions as any);

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "child-1", parentID: "root-1", agent: "explore" } },
      },
    } as any);
    expect(isChildSession("child-1")).toBe(true);

    await hooks.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: "child-1", parentID: "root-1" } },
      },
    } as any);
    expect(isChildSession("child-1")).toBe(false);
  });

  test("session.created without parentID is not tracked", async () => {
    clearChildSessions();
    const hooks = await astrocodePlugin({} as any, enabledOptions as any);

    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: "root-2" } } },
    } as any);

    expect(isChildSession("root-2")).toBe(false);
  });

  test("fallback disabled -> children are not tracked", async () => {
    clearChildSessions();
    const hooks = await astrocodePlugin({} as any);

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "child-3", parentID: "root-3", agent: "explore" } },
      },
    } as any);

    expect(isChildSession("child-3")).toBe(false);
  });
});
