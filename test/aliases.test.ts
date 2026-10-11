// Plan T5 — deprecated tool-alias registry + soft-redirect execute.
//
// The registry composition is a fixed constant (snapshot-tested here); every
// entry becomes a real plugin tool whose execute records one alias_hit record
// and returns a SUCCESS redirect text — never an error, never a side effect.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";
import { ALIAS_REGISTRY, type AliasDefinition, type AliasKind } from "../src/aliases/registry";
import {
  buildAliasTools,
  executeAlias,
  type AliasAbortResult,
  type AliasDelegateClient,
  type AliasGetResult,
  type AliasMessagesResult,
  type AliasTodoResult,
} from "../src/aliases";
import type { TelemetryLogger, TelemetryRecord } from "../src/telemetry/log";
import { loadAstrocodeConfig } from "../src/config/astrocode";
import { configureLogger } from "../src/log";
import astrocodePlugin from "../src/index";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

// Capturing telemetry sink: counts records and keeps their event payloads for
// assertions without re-parsing JSONL files.
class CapturingLogger implements TelemetryLogger {
  readonly records: TelemetryRecord[] = [];

  record(kind: TelemetryRecord["kind"], payload: unknown): void {
    const record: TelemetryRecord = {
      ts: "test",
      kind,
      session_id: "",
    };
    if (payload && typeof payload === "object") {
      const probe = payload as {
        session_id?: unknown;
        event?: Record<string, unknown>;
      };
      if (typeof probe.session_id === "string") record.session_id = probe.session_id;
      if (probe.event && typeof probe.event === "object") {
        record.event = probe.event as TelemetryRecord["event"];
      }
    }
    this.records.push(record);
  }

  close(): void {}
}

function stubContext(): ToolContext {
  return {
    sessionID: "ses_alias_test",
    messageID: "msg_alias_test",
    agent: "Sisyphus - ultraworker",
    directory: "/tmp/astrocode-aliases-test",
    worktree: "/tmp/astrocode-aliases-test",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

// A real PluginInput-shaped object; the alias builder never calls the client,
// so the HTTP client pointing at a closed port is never exercised.
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
    project: { id: "t5-test", worktree: directory, time: { created: 0 } },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: Bun.$,
  };
}

const disposers: (() => Promise<void>)[] = [];

// Guaranteed registry lookup for tests: throws (failing the test) if the
// composition ever drops the named entry.
function registryEntry(name: string): AliasDefinition {
  const def = ALIAS_REGISTRY.find((entry) => entry.name === name);
  if (!def) throw new Error(`missing registry entry: ${name}`);
  return def;
}

afterEach(async () => {
  // Instantiating the plugin wires the global logger to the test client;
  // reset it so later test files (log.test.ts) see the console fallback.
  configureLogger(undefined);
  for (const dispose of disposers.splice(0)) {
    await dispose();
  }
});

// The exact planned composition: [name, canonical, kind] in registry order.
const EXPECTED_COMPOSITION: [string, string, AliasKind][] = [
  ["Task_Create", "todowrite", "redirect"],
  ["TaskCreate", "todowrite", "redirect"],
  ["Task_Update", "todowrite", "redirect"],
  ["TaskUpdate", "todowrite", "redirect"],
  ["Task_Get", "session-todos", "delegate"],
  ["TaskGet", "session-todos", "delegate"],
  ["Task_List", "session-todos", "delegate"],
  ["TaskList", "session-todos", "delegate"],
  ["TodoWrite", "todowrite", "redirect"],
  ["TodoRead", "session-todos", "delegate"],
  ["TaskOutput", "child-output", "delegate"],
  ["TaskStop", "child-abort", "delegate"],
  ["Agent", "task", "redirect"],
  ["EnterPlanMode", "task", "redirect"],
  ["ExitPlanMode", "task", "redirect"],
];

// ---------------------------------------------------------------------------
// Registry composition
// ---------------------------------------------------------------------------

describe("ALIAS_REGISTRY composition (T5)", () => {
  test("matches the planned alias -> canonical -> kind mapping exactly", () => {
    expect(
      ALIAS_REGISTRY.map((def) => [def.name, def.canonical, def.kind]),
    ).toEqual(EXPECTED_COMPOSITION);
  });

  test("names are unique and none shadows the `task` builtin", () => {
    const names = ALIAS_REGISTRY.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("task");
    expect(names).not.toContain("todowrite");
    expect(names).not.toContain("todoread");
    expect(names).not.toContain("skill");
  });

  test("every description is a one-sentence static DEPRECATED notice", () => {
    for (const def of ALIAS_REGISTRY) {
      expect(def.description).toContain("DEPRECATED ALIAS");
      expect(def.description).not.toMatch(/\n/);
      if (def.kind === "redirect") {
        expect(def.description).toContain(`\`${def.canonical}\``);
        expect(def.description).toContain("exactly once");
      }
    }
  });

  test("plan-mode aliases carry the prometheus subagent_type hint", () => {
    for (const def of ALIAS_REGISTRY) {
      if (def.name === "EnterPlanMode" || def.name === "ExitPlanMode") {
        expect(def.hint).toContain('subagent_type: "Prometheus - Plan Builder"');
      } else {
        expect(def.hint).toBeUndefined();
      }
    }
  });

  // Regression (Claude path, 2026-10-11): the Claude-path proxy normalizes
  // tool names by capitalizing the first letter, so an alias whose capitalized
  // name equals a builtin's capitalized name is sent twice (`Tool mcp_X is
  // already registered` -> HTTP 500). The removed `Skill` alias collided with
  // the native `skill` tool this way. Assert the rule holds for every entry.
  test("no alias name collides with a builtin after first-letter capitalization", () => {
    const BUILTIN_TOOLS = [
      "invalid",
      "question",
      "bash",
      "read",
      "glob",
      "grep",
      "edit",
      "write",
      "task",
      "webfetch",
      "todowrite",
      "websearch",
      "skill",
      "apply_patch",
    ];
    const capitalize = (value: string) =>
      value.charAt(0).toUpperCase() + value.slice(1);
    const normalizedBuiltins = new Set(BUILTIN_TOOLS.map(capitalize));
    for (const def of ALIAS_REGISTRY) {
      expect(normalizedBuiltins.has(capitalize(def.name))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildAliasTools
// ---------------------------------------------------------------------------

describe("buildAliasTools (T5)", () => {
  test("registers one tool per registry entry, keyed by bare name", () => {
    const tools = buildAliasTools(pluginInput(tmpdir()).client);
    expect(Object.keys(tools).sort()).toEqual(
      EXPECTED_COMPOSITION.map((entry) => entry[0]).sort(),
    );
    for (const def of ALIAS_REGISTRY) {
      const defn = tools[def.name];
      expect(defn.description).toBe(def.description);
      // Empty raw shape: opencode wraps it with z.object({}) which accepts
      // any object args and forwards them raw to execute.
      expect(Object.keys(defn.args)).toHaveLength(0);
    }
  });

  test("redirect descriptions name the canonical tool; delegate ones do not", () => {
    const tools = buildAliasTools(pluginInput(tmpdir()).client);
    for (const def of ALIAS_REGISTRY) {
      if (def.kind === "delegate") {
        // Delegate targets are action tags, not callable tools — the
        // description must not advertise them as one.
        expect(def.description).not.toContain(`\`${def.canonical}\``);
      } else {
        expect(tools[def.name].description).toContain(`\`${def.canonical}\``);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Soft-redirect execute
// ---------------------------------------------------------------------------

describe("alias execute — soft redirect (T5)", () => {
  test("redirect: success text names the canonical tool exactly once + JSON echo, one alias_hit", async () => {
    const logger = new CapturingLogger();
    const args = { description: "probe", nested: { list: [1, "x", null] } };
    const result = await executeAlias(ALIAS_REGISTRY[0], args, stubContext(), logger);

    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("call `todowrite` exactly once");
    expect(text).toContain("Do not retry this alias");
    expect(text).toContain(JSON.stringify(args));

    expect(logger.records).toHaveLength(1);
    const record = logger.records[0];
    expect(record.kind).toBe("alias_hit");
    expect(record.session_id).toBe("ses_alias_test");
    expect(record.event).toEqual({
      alias: "Task_Create",
      canonical: "todowrite",
      kind: "redirect",
    });
  });

  test("redirect: plan-mode alias appends the prometheus subagent_type hint", async () => {
    const logger = new CapturingLogger();
    const result = await executeAlias(registryEntry("ExitPlanMode"), {}, stubContext(), logger);
    expect(result as string).toContain("call `task` exactly once");
    expect(result as string).toContain('subagent_type: "Prometheus - Plan Builder"');
    expect(logger.records[0].event).toEqual({
      alias: "ExitPlanMode",
      canonical: "task",
      kind: "redirect",
    });
  });

  test("delegate: alias_hit carries kind delegate; text gives no tool instruction", async () => {
    const logger = new CapturingLogger();
    const result = await executeAlias(registryEntry("TaskStop"), { task_id: "ses_child" }, stubContext(), logger);

    const text = result as string;
    expect(text).toContain("Do not retry this alias");
    expect(text).not.toContain("exactly once");
    expect(text).toContain(JSON.stringify({ task_id: "ses_child" }));

    expect(logger.records).toHaveLength(1);
    expect(logger.records[0].event).toEqual({
      alias: "TaskStop",
      canonical: "child-abort",
      kind: "delegate",
    });
  });

  test("execute always succeeds with hostile args (never throws)", async () => {
    const logger = new CapturingLogger();
    const hostile: unknown[] = [
      undefined,
      null,
      "garbage string",
      42,
      {},
      { a: null, b: [1, { c: true }], d: { e: { f: { g: "deep" } } } },
      { todos: [{ content: "x", status: "pending" }], extra: undefined },
    ];
    for (const def of ALIAS_REGISTRY) {
      for (const args of hostile) {
        const result = await executeAlias(def, args, stubContext(), logger);
        expect(typeof result).toBe("string");
        expect((result as string).length).toBeGreaterThan(0);
      }
    }
    // One alias_hit per executed alias (7 hostile args x 16 aliases).
    expect(logger.records).toHaveLength(ALIAS_REGISTRY.length * hostile.length);
  });

  test("tool() execute path accepts arbitrary legacy-shaped args", async () => {
    const logger = new CapturingLogger();
    const tools = buildAliasTools(pluginInput(tmpdir()).client, logger);
    const result = await tools["Task_Create"].execute(
      { description: "probe", todos: [{ status: "pending" }] },
      stubContext(),
    );
    expect(result as string).toContain("call `todowrite` exactly once");
    expect(logger.records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Delegate mocks (T6)
// ---------------------------------------------------------------------------

// Structural mock of the T6 delegate seam — no casts: AliasDelegateClient is
// a minimal interface the real SDK client also satisfies.
function mockDelegateClient(
  handlers: {
    get?: (options: { path: { id: string } }) => Promise<AliasGetResult>;
    abort?: (options: { path: { id: string } }) => Promise<AliasAbortResult>;
    messages?: (options: { path: { id: string } }) => Promise<AliasMessagesResult>;
    todo?: (options: { path: { id: string } }) => Promise<AliasTodoResult>;
  } = {},
): AliasDelegateClient {
  return {
    session: {
      get: handlers.get ?? (async () => ({ data: { id: "known" } })),
      abort: handlers.abort ?? (async () => ({ data: true })),
      messages: handlers.messages ?? (async () => ({ data: [] })),
      todo: handlers.todo ?? (async () => ({ data: [] })),
    },
  };
}

const notFoundError = () => ({
  name: "NotFoundError",
  data: { message: "session not found" },
});

// ---------------------------------------------------------------------------
// Delegate execute — real side effects (T6)
// ---------------------------------------------------------------------------

describe("delegate execute — TaskStop child-abort (T6)", () => {
  test("valid child id: existence probe then abort called exactly once, output confirms", async () => {
    const logger = new CapturingLogger();
    const getCalls: Array<{ path: { id: string } }> = [];
    const abortCalls: Array<{ path: { id: string } }> = [];
    const client = mockDelegateClient({
      get: async (options) => {
        getCalls.push(options);
        return { data: { id: "ses_child_valid" } };
      },
      abort: async (options) => {
        abortCalls.push(options);
        return { data: true };
      },
    });

    const result = await executeAlias(
      registryEntry("TaskStop"),
      { sessionID: "ses_child_valid" },
      stubContext(),
      logger,
      client,
    );

    expect(getCalls).toHaveLength(1);
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0]).toEqual({ path: { id: "ses_child_valid" } });
    expect(result as string).toContain("Stopped session ses_child_valid");
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0].kind).toBe("alias_hit");
    expect(logger.records[0].event).toEqual({
      alias: "TaskStop",
      canonical: "child-abort",
      kind: "delegate",
    });
  });

  test("loose arg shapes resolve: session_id and id both reach abort", async () => {
    const logger = new CapturingLogger();
    const abortCalls: Array<{ path: { id: string } }> = [];
    const client = mockDelegateClient({
      abort: async (options) => {
        abortCalls.push(options);
        return { data: true };
      },
    });

    await executeAlias(registryEntry("TaskStop"), { session_id: "ses_a" }, stubContext(), logger, client);
    await executeAlias(registryEntry("TaskStop"), { id: "ses_b" }, stubContext(), logger, client);

    expect(abortCalls.map((call) => call.path.id)).toEqual(["ses_a", "ses_b"]);
    expect(logger.records).toHaveLength(2);
  });

  test("unknown session id (404): reports no such child session, abort NOT called", async () => {
    const logger = new CapturingLogger();
    const getCalls: Array<{ path: { id: string } }> = [];
    let abortCalls = 0;
    const client = mockDelegateClient({
      get: async (options) => {
        getCalls.push(options);
        return { error: notFoundError() };
      },
      abort: async () => {
        abortCalls += 1;
        return { data: true };
      },
    });

    const result = await executeAlias(
      registryEntry("TaskStop"),
      { sessionID: "ses_gone" },
      stubContext(),
      logger,
      client,
    );

    // Existence probe ran; the fire-and-forget abort route was NOT called.
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]).toEqual({ path: { id: "ses_gone" } });
    expect(abortCalls).toBe(0);
    expect(result as string).toContain("no such child session");
    expect(result as string).toContain("ses_gone");
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0].event).toEqual({
      alias: "TaskStop",
      canonical: "child-abort",
      kind: "delegate",
    });
  });

  test("missing resolvable id: fallback text, abort NOT called", async () => {
    const logger = new CapturingLogger();
    let abortCalls = 0;
    const client = mockDelegateClient({
      abort: async () => {
        abortCalls += 1;
        return { data: true };
      },
    });

    const result = await executeAlias(
      registryEntry("TaskStop"),
      { task_id: "ses_child" },
      stubContext(),
      logger,
      client,
    );

    expect(abortCalls).toBe(0);
    expect(result as string).toContain("no such child session");
    expect(result as string).toContain(JSON.stringify({ task_id: "ses_child" }));
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0].event).toEqual({
      alias: "TaskStop",
      canonical: "child-abort",
      kind: "delegate",
    });
  });

  test("client rejection: informative text, never throws", async () => {
    const logger = new CapturingLogger();
    const client = mockDelegateClient({
      abort: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await executeAlias(
      registryEntry("TaskStop"),
      { sessionID: "ses_x" },
      stubContext(),
      logger,
      client,
    );

    expect(typeof result).toBe("string");
    expect(result as string).toContain("could not abort session");
    expect(logger.records).toHaveLength(1);
  });
});

describe("delegate execute — TaskOutput child-output (T6)", () => {
  test("valid child id: messages called once, digest contains child text", async () => {
    const logger = new CapturingLogger();
    const messageCalls: Array<{ path: { id: string } }> = [];
    const client = mockDelegateClient({
      messages: async (options) => {
        messageCalls.push(options);
        return {
          data: [
            {
              info: { role: "user" },
              parts: [{ type: "text", text: "explore the repo" }],
            },
            {
              info: { role: "assistant" },
              parts: [
                { type: "reasoning", text: "thinking" },
                { type: "text", text: "child explored the repo" },
              ],
            },
          ],
        };
      },
    });

    const result = await executeAlias(
      registryEntry("TaskOutput"),
      { session_id: "ses_child_out" },
      stubContext(),
      logger,
      client,
    );

    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]).toEqual({ path: { id: "ses_child_out" } });
    const text = result as string;
    expect(text).toContain("ses_child_out");
    expect(text).toContain("child explored the repo");
    // Non-text parts are not leaked into the digest.
    expect(text).not.toContain("thinking");
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0].event).toEqual({
      alias: "TaskOutput",
      canonical: "child-output",
      kind: "delegate",
    });
  });

  test("digest is capped at 2000 chars with a truncation marker", async () => {
    const logger = new CapturingLogger();
    const longText = "x".repeat(5000);
    const client = mockDelegateClient({
      messages: async () => ({
        data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: longText }] }],
      }),
    });

    const result = await executeAlias(
      registryEntry("TaskOutput"),
      { sessionID: "ses_long" },
      stubContext(),
      logger,
      client,
    );

    const text = result as string;
    expect(text).toContain("[truncated");
    // Header + marker + 2000-char digest tail.
    expect(text.length).toBeLessThanOrEqual(2100);
    expect(text.length).toBeGreaterThan(2000);
  });

  test("missing id: fallback redirect text, messages NOT called", async () => {
    const logger = new CapturingLogger();
    let messageCalls = 0;
    const client = mockDelegateClient({
      messages: async () => {
        messageCalls += 1;
        return { data: [] };
      },
    });

    const result = await executeAlias(
      registryEntry("TaskOutput"),
      { task_id: "ses_child" },
      stubContext(),
      logger,
      client,
    );

    expect(messageCalls).toBe(0);
    expect(result as string).toContain("no resolvable child session id");
    expect(result as string).toContain("Do not retry this alias");
    expect(logger.records).toHaveLength(1);
  });

  test("unknown session id (404): reports no such child session", async () => {
    const logger = new CapturingLogger();
    const client = mockDelegateClient({
      messages: async () => ({ error: notFoundError() }),
    });

    const result = await executeAlias(
      registryEntry("TaskOutput"),
      { id: "ses_gone" },
      stubContext(),
      logger,
      client,
    );

    expect(result as string).toContain("no such child session");
    expect(logger.records).toHaveLength(1);
  });

  test("child with no assistant text yet: informative no-output text", async () => {
    const logger = new CapturingLogger();
    const client = mockDelegateClient({
      messages: async () => ({
        data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
      }),
    });

    const result = await executeAlias(
      registryEntry("TaskOutput"),
      { sessionID: "ses_empty" },
      stubContext(),
      logger,
      client,
    );

    expect(result as string).toContain("no assistant text output yet");
    expect(logger.records).toHaveLength(1);
  });
});

describe("delegate execute — session-todos group (T6)", () => {
  const SESSION_TODO_ALIASES = ["Task_Get", "TaskGet", "Task_List", "TaskList", "TodoRead"];

  test("each alias reads the current session todos once and renders the list", async () => {
    for (const name of SESSION_TODO_ALIASES) {
      const logger = new CapturingLogger();
      const todoCalls: Array<{ path: { id: string } }> = [];
      const client = mockDelegateClient({
        todo: async (options) => {
          todoCalls.push(options);
          return {
            data: [
              { status: "completed", content: "write tests", priority: "high" },
              { status: "pending", content: "ship it", priority: "medium" },
            ],
          };
        },
      });

      const result = await executeAlias(registryEntry(name), {}, stubContext(), logger, client);

      expect(todoCalls).toHaveLength(1);
      expect(todoCalls[0]).toEqual({ path: { id: "ses_alias_test" } });
      const text = result as string;
      expect(text).toContain("Session todo list");
      expect(text).toContain("- [completed] write tests");
      expect(text).toContain("- [pending] ship it");
      expect(text).toContain("Do not retry this alias");
      expect(logger.records).toHaveLength(1);
      expect(logger.records[0].kind).toBe("alias_hit");
      expect(logger.records[0].event).toEqual({
        alias: name,
        canonical: "session-todos",
        kind: "delegate",
      });
    }
  });

  test("empty todo list says so without a list body", async () => {
    const logger = new CapturingLogger();
    const client = mockDelegateClient({ todo: async () => ({ data: [] }) });

    const result = await executeAlias(registryEntry("TodoRead"), {}, stubContext(), logger, client);

    expect(result as string).toContain("Session todo list is empty");
    expect(logger.records).toHaveLength(1);
  });

  test("todo route error: informative text, never throws", async () => {
    const logger = new CapturingLogger();
    const client = mockDelegateClient({
      todo: async () => ({ error: notFoundError() }),
    });

    const result = await executeAlias(registryEntry("Task_List"), {}, stubContext(), logger, client);

    expect(typeof result).toBe("string");
    expect(result as string).toContain("could not read this session's todos");
    expect(logger.records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Config + wiring
// ---------------------------------------------------------------------------

describe("aliases config (T5)", () => {
  test("enabled defaults to true; garbage falls back to the default", () => {
    expect(loadAstrocodeConfig([]).aliases.enabled).toBe(true);
    expect(
      loadAstrocodeConfig([], { aliases: { enabled: "yes" } }).aliases.enabled,
    ).toBe(true);
    expect(loadAstrocodeConfig([], { aliases: "garbage" }).aliases.enabled).toBe(true);
  });

  test("enabled: false parses through file and inline layers", () => {
    expect(
      loadAstrocodeConfig([], { aliases: { enabled: false } }).aliases.enabled,
    ).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "astrocode-aliases-cfg-"));
    try {
      writeFileSync(
        join(dir, "astrocode.jsonc"),
        `{ "aliases": { "enabled": false }, "telemetry": { "enabled": false } }`,
      );
      expect(loadAstrocodeConfig([dir]).aliases.enabled).toBe(false);
      // Inline override wins over the file layer.
      expect(
        loadAstrocodeConfig([dir], { aliases: { enabled: true } }).aliases.enabled,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugin wiring (T5)", () => {
  test("default config registers all alias tools on the plugin hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-aliases-on-"));
    try {
      const hooks = await astrocodePlugin(pluginInput(dir), {
        telemetry: { enabled: false },
      });
      const dispose = hooks.dispose;
      if (dispose) disposers.push(dispose);
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(
        EXPECTED_COMPOSITION.map((entry) => entry[0]).sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aliases.enabled: false registers no alias tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrocode-aliases-off-"));
    try {
      const hooks = await astrocodePlugin(pluginInput(dir), {
        telemetry: { enabled: false },
        aliases: { enabled: false },
      });
      const dispose = hooks.dispose;
      if (dispose) disposers.push(dispose);
      expect(hooks.tool).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});