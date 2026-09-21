import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import astrocodePlugin from "../src/index";
import {
  maybeContinueIdle,
  resetIdleContinuationState,
} from "../src/idle/continue";

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
