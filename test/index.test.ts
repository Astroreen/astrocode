import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import astrocodePlugin from "../src/index";
import {
  clearAllSessionModels,
  getSessionModelState,
  setSessionFallbackModel,
} from "../src/fallback/session-model";
import { clearAll as clearFallbackState } from "../src/fallback/state";
import {
  maybeContinueIdle,
  resetIdleContinuationState,
} from "../src/idle/continue";
import { clearChildSessions, isChildSession } from "../src/fallback/subagent";
import { AGENT_DISPLAY_NAMES } from "../src/agents/personas";

describe("subagent model cascade", () => {
  const PERSONA_NAMES = Object.values(AGENT_DISPLAY_NAMES);

  async function buildAgentRoster(
    fixture: Record<string, unknown>,
    root: Record<string, unknown> = {},
  ): Promise<Record<string, Record<string, unknown>>> {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-cascade-"));
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(
        join(dir, ".opencode", "astrocode.jsonc"),
        JSON.stringify(fixture),
      );
      const hooks = await astrocodePlugin({ directory: dir } as any);
      const cfg = root as any;
      await hooks.config!(cfg);
      return cfg.agent as Record<string, Record<string, unknown>>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("explicit per-agent model wins; global model cascades to every other persona", async () => {
    const agents = await buildAgentRoster({
      model: "openrouter/deepseek-chat",
      subagents: { inherit_parent_model: false },
      agents: { explore: { model: "moonshotai/kimi-k2" } },
    });

    expect(agents["explore"].model).toBe("moonshotai/kimi-k2");
    for (const name of PERSONA_NAMES) {
      if (name === "explore") continue;
      expect(agents[name].model).toBe("openrouter/deepseek-chat");
    }
  });

  test("inherit_parent_model: true restores parent inheritance for non-explicit personas", async () => {
    const agents = await buildAgentRoster({
      model: "openrouter/deepseek-chat",
      subagents: { inherit_parent_model: true },
      agents: { explore: { model: "moonshotai/kimi-k2" } },
    });

    expect(agents["explore"].model).toBe("moonshotai/kimi-k2");
    for (const name of PERSONA_NAMES) {
      if (name === "explore") continue;
      expect("model" in agents[name]).toBe(false);
    }
  });

  test("opencode root model cascades when the astrocode model is absent", async () => {
    const agents = await buildAgentRoster({}, { model: "opencode/gpt-5.5" });

    for (const name of PERSONA_NAMES) {
      expect(agents[name].model).toBe("opencode/gpt-5.5");
    }
  });

  test("no model anywhere leaves entries without a model key", async () => {
    const agents = await buildAgentRoster({});

    for (const name of PERSONA_NAMES) {
      expect("model" in agents[name]).toBe(false);
    }
  });
});

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
        promptAsync: async () => ({ data: {} }),
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

  test("existing user command with the same name is not clobbered", async () => {
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

  test("self-heals a prior thin skill stub from a duplicate plugin load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-skillcmd3-"));
    try {
      const skillDir = join(dir, ".opencode", "skills", "demo-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: demo-skill\ndescription: demo\n---\nDo the demo thing.\n",
      );

      // Simulates the stale HM-deployed copy claiming the name first with the
      // old thin template (double-load race).
      const thin =
        `Load the "demo-skill" skill by calling the skill tool ` +
        `(name: "demo-skill"), then follow its instructions.\n\n$ARGUMENTS`;
      const hooks = await astrocodePlugin({ directory: dir } as any);
      const cfg = {
        command: {
          "demo-skill": { description: "Skill: demo", template: thin },
        },
      } as any;
      await hooks.config!(cfg);

      expect(cfg.command["demo-skill"].template).toContain("<skill-instruction>");
      expect(cfg.command["demo-skill"].template).toContain("Do the demo thing.");
      expect(cfg.command["demo-skill"].template).not.toBe(thin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("user command without Skill: description and non-skill template stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-skillcmd4-"));
    try {
      const skillDir = join(dir, ".opencode", "skills", "commit");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: commit\ndescription: skill commit\n---\nbody\n",
      );

      const hooks = await astrocodePlugin({ directory: dir } as any);
      const cfg = {
        command: {
          commit: { description: "my custom commit helper", template: "CUSTOM" },
        },
      } as any;
      await hooks.config!(cfg);

      expect(cfg.command.commit.template).toBe("CUSTOM");
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

describe("astrocode plugin — RetryPart and status.next surfaces", () => {
  const CHAIN = [
    "anthropic/claude-sonnet-4-6",
    "openrouter/one/a",
    "openrouter/two/b",
  ];

  const userMessage = {
    info: {
      role: "user",
      agent: "Atlas - Plan Executor",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    },
    parts: [{ type: "text", text: "do the thing" }],
  };

  const enabledOptions = {
    fallback: {
      enabled: true,
      models: CHAIN,
      cooldown_seconds: 0,
    },
  };

  function clientWith(
    messages: unknown[],
    opts: { failResubmit?: boolean } = {},
  ) {
    const calls = {
      promptAsync: 0,
      lastBody: undefined as Record<string, unknown> | undefined,
    };
    const client = {
      session: {
        messages: async () => ({ data: messages }),
        abort: async () => ({}),
        promptAsync: async (options: { body: Record<string, unknown> }) => {
          calls.promptAsync += 1;
          calls.lastBody = options.body;
          return opts.failResubmit
            ? { error: { name: "BadRequestError", data: {} } }
            : { data: {} };
        },
      },
    };
    return { client, calls };
  }

  function retryPartEvent(sessionID: string, attempt: number) {
    return {
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: `part-${sessionID}-${attempt}`,
            sessionID,
            messageID: "msg-1",
            type: "retry",
            attempt,
            error: {
              name: "APIError",
              data: {
                message: "usage limit reached",
                isRetryable: false,
                responseBody:
                  '{"error":{"type":"FreeUsageLimitError","message":"free usage limit"}}',
              },
            },
            time: { created: 1 },
          },
        },
      },
    } as any;
  }

  beforeEach(() => {
    clearAllSessionModels();
    clearFallbackState();
    clearChildSessions();
  });

  test("RetryPart with a terminal FreeUsageLimitError resubmits on chain model #2", async () => {
    const { client, calls } = clientWith([userMessage]);
    const hooks = await astrocodePlugin({ client } as any, enabledOptions as any);

    await hooks.event!(retryPartEvent("rp-1", 1));

    // Chain #1 is the primary that just failed (terminal quota skips it), so
    // the rotation lands on #2.
    expect(calls.promptAsync).toBe(1);
    expect(calls.lastBody?.model).toEqual({
      providerID: "openrouter",
      modelID: "one/a",
    });
    expect(getSessionModelState("rp-1")?.currentModel).toBe("openrouter/one/a");
  });

  test("identical RetryPart (same attempt + message) dispatches only once", async () => {
    const { client, calls } = clientWith([userMessage], { failResubmit: true });
    // failResubmit on purpose: a successful resubmit clears the retry keys (T9
    // success path), so a later identical event would be treated as a NEW
    // failure by design. The dedup itself is what is under test here — the
    // second event must not reach dispatchFallback at all.
    const hooks = await astrocodePlugin({ client } as any, enabledOptions as any);

    await hooks.event!(retryPartEvent("rp-2", 1));
    await hooks.event!(retryPartEvent("rp-2", 1));

    expect(calls.promptAsync).toBe(1);
  });

  test("session.status retry with a far-future next rotates instead of same-model retry", async () => {
    const { client, calls } = clientWith([userMessage]);
    const hooks = await astrocodePlugin({ client } as any, enabledOptions as any);

    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "st-1",
          status: {
            type: "retry",
            attempt: 1,
            message: "overloaded",
            next: Date.now() + 9_000_000,
          },
        },
      },
    } as any);

    // A same-model retry never resubmits (promptAsync would stay 0); the
    // 9000s wait exceeds same_model_max_wait_seconds (300s), so the decision
    // is a rotation onto chain model #2.
    expect(calls.promptAsync).toBe(1);
    expect(calls.lastBody?.model).toEqual({
      providerID: "openrouter",
      modelID: "one/a",
    });
    expect(getSessionModelState("st-1")?.currentModel).toBe("openrouter/one/a");
  });
});
