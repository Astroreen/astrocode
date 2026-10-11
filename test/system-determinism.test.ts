// Plan T8 — system-layer determinism.
//
// The experimental.chat.system.transform hook must be byte-stable per
// session: the first assembled system prompt is frozen and every later
// transform for the same (session, model, pre-filled base) key returns
// exactly those bytes. Keys freeze independently — a different model or a
// different host pre-filled base (aux request like session-title generation)
// assembles its own variant — and a divergent re-assembly is recorded as a
// system_diff telemetry record while the frozen bytes still win.

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient, type Model } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";
import astrocodePlugin from "../src/index";
import {
  FREEZE_MAP_CAP,
  SystemPromptFreeze,
  sha256Hex,
  systemPromptKey,
} from "../src/prompts/freeze";
import type { TelemetryRecord } from "../src/telemetry/log";

function minimalModel(providerID: string, id: string): Model {
  return {
    id,
    providerID,
    api: { id, url: "https://example.invalid/v1", npm: "@ai-sdk/openai-compatible" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  };
}

// A real PluginInput-shaped object: the transform hook never calls the
// client, so the HTTP client pointing at a closed port is never exercised.
function pluginInput(directory: string): PluginInput {
  return {
    // Plugin init wires this client into the log facade (configureLogger).
    // Without a baseUrl the SDK's log route builds `new Request("/log")`,
    // whose async rejection surfaces as console.error noise in LATER test
    // files' windows (flaky log.test pollution). The hooks under test never
    // touch the client, so resolve every route in-process instead.
    client: createOpencodeClient({
      directory,
      baseUrl: "http://127.0.0.1:4096",
      fetch: () =>
        Promise.resolve(
          new Response("{}", { headers: { "content-type": "application/json" } }),
        ),
    }),
    project: { id: "t8-test", worktree: directory, time: { created: 0 } },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: Bun.$,
  };
}

const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    await dispose();
  }
});

// Plugin instance bound to a scratch project; telemetry (when enabled) writes
// into a temp dir that the caller can read back after dispose().
async function loadPlugin(options?: { telemetryDir?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "astrocode-determinism-"));
  if (options?.telemetryDir) {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const config = { telemetry: { enabled: true, dir: options.telemetryDir } };
    writeFileSync(
      join(dir, ".opencode", "astrocode.jsonc"),
      JSON.stringify(config),
    );
  }
  const hooks = await astrocodePlugin(pluginInput(dir));
  const dispose = hooks.dispose!;
  disposers.push(dispose);
  const transform = hooks["experimental.chat.system.transform"]!;
  return {
    dispose,
    transform,
    dir,
    async run(
      sessionID: string,
      providerID: string,
      modelID: string,
      base: string[] = ["BASE"],
    ) {
      const output = { system: [...base] };
      await transform(
        { sessionID, model: minimalModel(providerID, modelID) },
        output,
      );
      return output.system;
    },
  };
}

function readTelemetryRecords(dir: string): TelemetryRecord[] {
  const lines: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".jsonl")) {
      lines.push(
        ...readFileSync(join(dir, name), "utf8")
          .split("\n")
          .filter((line) => line.length > 0),
      );
    }
  }
  return lines.map((line) => JSON.parse(line) as TelemetryRecord);
}

describe("system transform freeze (T8)", () => {
  test("two transforms on one session produce byte-identical output", async () => {
    const plugin = await loadPlugin();

    const first = await plugin.run("sess-a", "openrouter", "deepseek/deepseek-chat");
    const second = await plugin.run("sess-a", "openrouter", "deepseek/deepseek-chat");

    expect(first.length).toBeGreaterThan(1);
    expect(sha256Hex(systemPromptKey(first))).toBe(
      sha256Hex(systemPromptKey(second)),
    );
    expect(second).toEqual(first);
  });

  test("a third transform on a multi-request session still returns the frozen bytes", async () => {
    const plugin = await loadPlugin();

    const first = await plugin.run("sess-b", "openrouter", "deepseek/deepseek-chat");
    await plugin.run("sess-b", "openrouter", "deepseek/deepseek-chat");
    const third = await plugin.run("sess-b", "openrouter", "deepseek/deepseek-chat");

    expect(third).toEqual(first);
  });

  test("different sessionIDs freeze independently (no cross-contamination)", async () => {
    const plugin = await loadPlugin();

    const parent = await plugin.run("sess-parent", "openrouter", "deepseek/deepseek-chat");
    const child = await plugin.run("sess-child", "anthropic", "claude-sonnet-4-6");

    // The child session assembled its own prompt (different family guards),
    // not a copy of the parent's frozen bytes.
    expect(child).not.toEqual(parent);

    // Each session keeps returning its own frozen bytes.
    const parentAgain = await plugin.run("sess-parent", "openrouter", "deepseek/deepseek-chat");
    const childAgain = await plugin.run("sess-child", "anthropic", "claude-sonnet-4-6");
    expect(parentAgain).toEqual(parent);
    expect(childAgain).toEqual(child);
  });

  test("same session, different models freeze independently (aux request cannot poison chat)", async () => {
    const telemetryDir = mkdtempSync(join(tmpdir(), "astrocode-poison-"));
    const plugin = await loadPlugin({ telemetryDir });

    // Live audit 2026-10-10: opencode fires a session-title request for the
    // SAME sessionID with another model before/alongside the chat request.
    // With a sessionID-only freeze the title request froze first and the real
    // chat request was served the title-generator bytes. The freeze key
    // includes the model, so each assembles and freezes its own variant.
    // (The two models must be from different families — same-family models
    // assemble identical guards, which is fine and not a poisoning.)
    const deepseekFrozen = await plugin.run(
      "sess-mix",
      "openrouter",
      "deepseek/deepseek-chat",
    );
    const claudeFirst = await plugin.run(
      "sess-mix",
      "anthropic",
      "claude-sonnet-4-6",
    );

    // The claude assembly is NOT the deepseek frozen bytes...
    expect(claudeFirst).not.toEqual(deepseekFrozen);
    // ...and matches what claude assembles on a session with no prior freeze
    // (i.e. it was not replaced by the deepseek frozen prompt).
    const claudeReference = await plugin.run(
      "sess-mix-ref",
      "anthropic",
      "claude-sonnet-4-6",
    );
    expect(claudeFirst).toEqual(claudeReference);

    // Both variants keep returning their own frozen bytes.
    expect(await plugin.run("sess-mix", "openrouter", "deepseek/deepseek-chat")).toEqual(
      deepseekFrozen,
    );
    expect(await plugin.run("sess-mix", "anthropic", "claude-sonnet-4-6")).toEqual(
      claudeFirst,
    );

    await plugin.dispose();

    // Different models in one session are legitimate, not a divergence.
    const diffs = readTelemetryRecords(telemetryDir).filter(
      (record) => record.kind === "system_diff",
    );
    expect(diffs.length).toBe(0);
  });

  test("same session and model, different pre-filled base freezes independently", async () => {
    const plugin = await loadPlugin();

    // Chat request: host pre-fills the agent prompt.
    const chat = await plugin.run("sess-kinds", "openrouter", "deepseek/deepseek-chat");
    // Auxiliary request (e.g. title generation): host pre-fills a different
    // base for the same sessionID and model.
    const aux = await plugin.run("sess-kinds", "openrouter", "deepseek/deepseek-chat", [
      "You are a title generator.",
    ]);

    expect(aux).not.toEqual(chat);
    // Each kind keeps returning its own frozen bytes.
    expect(await plugin.run("sess-kinds", "openrouter", "deepseek/deepseek-chat")).toEqual(
      chat,
    );
    expect(
      await plugin.run("sess-kinds", "openrouter", "deepseek/deepseek-chat", [
        "You are a title generator.",
      ]),
    ).toEqual(aux);
  });

  test("divergent re-assembly records a system_diff and still returns the frozen bytes", async () => {
    const telemetryDir = mkdtempSync(join(tmpdir(), "astrocode-diff-"));
    const plugin = await loadPlugin({ telemetryDir });

    // First transform freezes the openrouter-family assembly (with guards).
    const frozen = await plugin.run("sess-diff", "openrouter", "deepseek/deepseek-chat");

    // The pre-filled base and the model stay identical, but the assembly
    // inputs change underneath: an AGENTS.md appears in the project, so the
    // next transform appends the directory-context block — a genuine
    // divergence against the frozen prompt.
    writeFileSync(join(plugin.dir, "AGENTS.md"), "# Test agents context\n");
    const reference = await plugin.run(
      "sess-diff-ref",
      "openrouter",
      "deepseek/deepseek-chat",
    );
    expect(reference).not.toEqual(frozen);

    // The divergent assembly is recorded and the frozen bytes still win: the
    // hook returns them despite the divergent re-assembly.
    const divergent = await plugin.run("sess-diff", "openrouter", "deepseek/deepseek-chat");
    expect(divergent).toEqual(frozen);

    await plugin.dispose();

    const diffs = readTelemetryRecords(telemetryDir).filter(
      (record) => record.kind === "system_diff",
    );
    expect(diffs.length).toBe(1);
    const event = diffs[0].event as Record<string, string>;
    expect(event.frozen_sha256).toBe(sha256Hex(systemPromptKey(frozen)));
    // The recorded incoming hash is the DIVERGENT assembly (with the AGENTS.md
    // block), not the frozen bytes that were returned.
    expect(event.incoming_sha256).toBe(sha256Hex(systemPromptKey(reference)));
    expect(event.incoming_sha256).not.toBe(event.frozen_sha256);
    expect(event.session_id).toBe("sess-diff");
    expect(diffs[0].session_id).toBe("sess-diff");
  });

  test("telemetry disabled: divergence still returns frozen bytes, no diff record", async () => {
    const plugin = await loadPlugin();

    const frozen = await plugin.run("sess-quiet", "openrouter", "deepseek/deepseek-chat");
    writeFileSync(join(plugin.dir, "AGENTS.md"), "# Test agents context\n");
    const divergent = await plugin.run("sess-quiet", "openrouter", "deepseek/deepseek-chat");

    // Frozen wins either way; the no-op logger simply drops the record.
    expect(divergent).toEqual(frozen);
  });
});

describe("SystemPromptFreeze LRU", () => {
  test("evicts the least-recently-used session beyond the cap", () => {
    const freeze = new SystemPromptFreeze(FREEZE_MAP_CAP);
    for (let i = 0; i < FREEZE_MAP_CAP; i++) {
      freeze.set(`s${i}`, [`prompt-${i}`]);
    }
    expect(freeze.size).toBe(FREEZE_MAP_CAP);

    // Touch the oldest entry so it becomes most-recent...
    expect(freeze.get("s0")).toEqual(["prompt-0"]);
    // ...then push one more, evicting s1 (now the least-recent), not s0.
    freeze.set("s-new", ["prompt-new"]);
    expect(freeze.size).toBe(FREEZE_MAP_CAP);
    expect(freeze.has("s0")).toBe(true);
    expect(freeze.has("s1")).toBe(false);
    expect(freeze.has("s-new")).toBe(true);
  });

  test("re-freezing a session replaces its entry without growing the map", () => {
    const freeze = new SystemPromptFreeze(2);
    freeze.set("a", ["one"]);
    freeze.set("b", ["two"]);
    freeze.set("a", ["one-v2"]);
    expect(freeze.size).toBe(2);
    expect(freeze.get("a")).toEqual(["one-v2"]);
    expect(freeze.get("b")).toEqual(["two"]);
  });

  test("stored arrays are slice copies — later mutation cannot leak in", () => {
    const freeze = new SystemPromptFreeze();
    const system = ["BASE", "GUARD"];
    freeze.set("s", system);
    system.push("MUTATED");
    expect(freeze.get("s")).toEqual(["BASE", "GUARD"]);
  });
});
