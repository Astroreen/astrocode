import { describe, expect, test } from "bun:test";
import astrocodePlugin from "../src/index";

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

    expect(output.system).toEqual(["BASE"]);
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
