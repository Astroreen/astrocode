// Plan T15 tests: tool-schema hygiene validator, the tool.definition hook
// wiring (log_only vs repair), and the recordSchemaViolation telemetry sink.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpencodeClient, type Project } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";
import astrocodePlugin from "../src/index";
import { configureLogger } from "../src/log";
import {
  repairToolSchema,
  validateToolSchema,
  type Violation,
} from "../src/validation/schema";
import {
  createTelemetryLogger,
  recordSchemaViolation,
  type TelemetryRecord,
} from "../src/telemetry/log";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readRecords(dir: string): TelemetryRecord[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const out: TelemetryRecord[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.length > 0) out.push(JSON.parse(line) as TelemetryRecord);
    }
  }
  return out;
}

function codesOf(violations: Violation[]): string[] {
  return violations.map((violation) => violation.code);
}

// Typed event sinks take typed payloads, but the invalid-payload cases below
// simulate untyped upstream data with a single honest cast (no `as any`) —
// same pattern as test/telemetry.test.ts.
function malformed<T>(value: unknown): T {
  return value as T;
}

/** A clean, protocol-valid tool schema: 0 violations expected. */
function validSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      count: { type: "number", description: "How many" },
    },
    required: ["path"],
  };
}

// Typed PluginInput stub (no casts): a real SDK client against a dead local
// port (nothing in these tests performs a network call), minimal Project, and
// the Bun shell.
function pluginInput(directory: string): PluginInput {
  const project: Project = {
    id: "test-project",
    worktree: directory,
    time: { created: 0 },
  };
  return {
    client: createOpencodeClient({ baseUrl: "http://127.0.0.1:1", directory }),
    project,
    directory,
    worktree: directory,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://127.0.0.1:1"),
    $: Bun.$,
  };
}

// ---------------------------------------------------------------------------
// validateToolSchema (pure validator)
// ---------------------------------------------------------------------------

describe("validateToolSchema", () => {
  test("valid schema -> 0 violations, input not mutated", () => {
    const schema = validSchema();
    const before = JSON.stringify(schema);
    expect(validateToolSchema("bash", schema)).toEqual([]);
    expect(JSON.stringify(schema)).toBe(before);
  });

  test("root anyOf/oneOf/allOf -> root_combinator error at $", () => {
    for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
      const schema = { [combinator]: [{ type: "object", properties: {} }] };
      const violations = validateToolSchema("mcp_tool", schema);
      expect(codesOf(violations)).toEqual(["root_combinator"]);
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.path).toBe("$");
    }
  });

  test("root type present but not object -> root_not_object", () => {
    const violations = validateToolSchema("weird", { type: "string" });
    expect(codesOf(violations)).toEqual(["root_not_object"]);
    expect(violations[0]?.severity).toBe("error");
  });

  test("root type missing (no combinator) -> root_type_missing", () => {
    const violations = validateToolSchema("loose", { properties: {} });
    expect(codesOf(violations)).toEqual(["root_type_missing"]);
    expect(violations[0]?.severity).toBe("error");
  });

  test("name regex: valid names pass", () => {
    for (const name of ["bash", "Task_Create", "mcp__oc__read", "a", "A-b_c9"]) {
      expect(validateToolSchema(name, validSchema()), name).toEqual([]);
    }
    expect(validateToolSchema("x".repeat(64), validSchema())).toEqual([]);
  });

  test("name regex: invalid names and length bounds fail", () => {
    expect(codesOf(validateToolSchema("", validSchema()))).toContain("invalid_name");
    expect(codesOf(validateToolSchema("x".repeat(65), validSchema()))).toContain("invalid_name");
    expect(codesOf(validateToolSchema("bad name", validSchema()))).toContain("invalid_name");
    expect(codesOf(validateToolSchema("bad.dot", validSchema()))).toContain("invalid_name");
    expect(codesOf(validateToolSchema(undefined, validSchema()))).toContain("invalid_name");
    const violation = validateToolSchema("x".repeat(65), validSchema()).find(
      (entry) => entry.code === "invalid_name",
    );
    expect(violation?.severity).toBe("error");
  });

  test("required referencing a missing property -> required_not_in_properties", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "missing"],
    };
    const violations = validateToolSchema("tool", schema);
    expect(codesOf(violations)).toEqual(["required_not_in_properties"]);
    expect(violations[0]?.path).toBe("$");
    expect(violations[0]?.message).toContain("missing");
  });

  test("required check runs on nested nodes too", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { inner: { type: "string" } },
          required: ["absent"],
        },
      },
    };
    const violations = validateToolSchema("tool", schema);
    expect(codesOf(violations)).toEqual(["required_not_in_properties"]);
    expect(violations[0]?.path).toBe("$.properties.nested");
  });

  test("empty sub-field description -> warning severity", () => {
    const schema = {
      type: "object",
      properties: {
        blank: { type: "string", description: "" },
        spaces: { type: "string", description: "   " },
        described: { type: "string", description: "ok" },
        undescribed: { type: "string" },
      },
    };
    const violations = validateToolSchema("tool", schema);
    expect(codesOf(violations)).toEqual(["empty_description", "empty_description"]);
    for (const violation of violations) {
      expect(violation.severity).toBe("warning");
    }
    expect(violations[0]?.path).toBe("$.properties.blank");
    expect(violations[1]?.path).toBe("$.properties.spaces");
  });

  test("parameters not an object -> parameters_not_object", () => {
    expect(codesOf(validateToolSchema("tool", "nope"))).toEqual(["parameters_not_object"]);
    expect(codesOf(validateToolSchema("tool", null))).toEqual(["parameters_not_object"]);
    expect(codesOf(validateToolSchema("tool", []))).toEqual(["parameters_not_object"]);
  });

  test("cyclic $ref-style schema terminates (bounded walk)", () => {
    const child: Record<string, unknown> = {};
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { self: child },
    };
    child.properties = schema; // reference cycle
    const violations = validateToolSchema("loopy", schema);
    expect(codesOf(violations)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// repairToolSchema (the single safe repair)
// ---------------------------------------------------------------------------

describe("repairToolSchema", () => {
  test("adds type object only when properties present and type missing", () => {
    const schema: Record<string, unknown> = { properties: { a: { type: "string" } } };
    expect(repairToolSchema(schema)).toBe(true);
    expect(schema.type).toBe("object");
  });

  test("no repair when type already present", () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    expect(repairToolSchema(schema)).toBe(false);
  });

  test("no repair without properties", () => {
    expect(repairToolSchema({})).toBe(false);
    expect(repairToolSchema({ description: "empty schema" })).toBe(false);
  });

  test("anyOf root is never rewritten", () => {
    const schema: Record<string, unknown> = {
      anyOf: [{ type: "object", properties: {} }],
    };
    expect(repairToolSchema(schema)).toBe(false);
    expect(schema.anyOf).toBeDefined();
    expect(schema.type).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordSchemaViolation (telemetry sink)
// ---------------------------------------------------------------------------

describe("recordSchemaViolation", () => {
  test("payload roundtrip into the JSONL stream", () => {
    const dir = tempDir("astrocode-t15-telemetry-");
    try {
      const logger = createTelemetryLogger({ dir });
      recordSchemaViolation(
        logger,
        { session_id: "tool-registry", agent: "sisyphus" },
        {
          tool_name: "mcp_tool",
          code: "root_combinator",
          severity: "error",
          path: "$",
          message: "root-level anyOf",
        },
      );
      logger.close();

      const records = readRecords(dir);
      expect(records).toHaveLength(1);
      const record = records[0] as TelemetryRecord;
      expect(record.kind).toBe("schema_violation");
      expect(record.session_id).toBe("tool-registry");
      expect(record.agent).toBe("sisyphus");
      expect(record.event).toEqual({
        tool_name: "mcp_tool",
        code: "root_combinator",
        severity: "error",
        path: "$",
        message: "root-level anyOf",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown event keys are rejected (log.error, no record)", () => {
    const dir = tempDir("astrocode-t15-telemetry-");
    const errorSpy = spyOn(console, "error");
    try {
      const logger = createTelemetryLogger({ dir });
      recordSchemaViolation(
        logger,
        { session_id: "tool-registry" },
        malformed({
          tool_name: "mcp_tool",
          code: "root_combinator",
          severity: "error",
          message: "root-level anyOf",
          bogus_unknown_field: "must be rejected",
        }),
      );
      logger.close();
      expect(readRecords(dir)).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing ctx.session_id -> no record", () => {
    const dir = tempDir("astrocode-t15-telemetry-");
    const errorSpy = spyOn(console, "error");
    try {
      const logger = createTelemetryLogger({ dir });
      recordSchemaViolation(logger, { session_id: "" }, {
        tool_name: "mcp_tool",
        code: "root_combinator",
        severity: "error",
        message: "root-level anyOf",
      });
      logger.close();
      expect(readRecords(dir)).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// tool.definition hook wiring (log_only vs repair, through the real plugin)
// ---------------------------------------------------------------------------

describe("tool.definition hook", () => {
  const ORIGINAL_TELEMETRY_DIR = process.env.ASTROCODE_TELEMETRY_DIR;

  beforeEach(() => {
    // The plugin resolves the telemetry dir from the env first; tests pin it
    // via the config file instead, so the ambient env must stay out of the way.
    delete process.env.ASTROCODE_TELEMETRY_DIR;
  });

  afterEach(() => {
    configureLogger(undefined);
    if (ORIGINAL_TELEMETRY_DIR === undefined) {
      delete process.env.ASTROCODE_TELEMETRY_DIR;
    } else {
      process.env.ASTROCODE_TELEMETRY_DIR = ORIGINAL_TELEMETRY_DIR;
    }
  });

  interface Harness {
    telemetryDir: string;
    projectDir: string;
    run: (toolID: string, parameters: unknown) => Promise<unknown>;
    dispose: () => Promise<void>;
  }

  /** Load the plugin against a temp project; returns the raw hook runner. */
  async function harness(config: Record<string, unknown>): Promise<Harness> {
    const projectDir = tempDir("astrocode-t15-project-");
    const telemetryDir = tempDir("astrocode-t15-telemetry-");
    writeFileSync(
      join(projectDir, "astrocode.jsonc"),
      JSON.stringify({ ...config, telemetry: { dir: telemetryDir } }),
      "utf8",
    );
    const hooks = await astrocodePlugin(pluginInput(projectDir));
    const hook = hooks["tool.definition"];
    if (!hook) throw new Error("tool.definition hook not registered");
    // Narrowed capture: the element-access narrowing above does not survive
    // inside the closures below, so re-bind the (now defined) hook first.
    const definitionHook = hook;
    // Unwire the plugin's SDK log client (it points at a dead port in tests)
    // so log.warn takes the console fallback the spies below observe.
    configureLogger(undefined);
    return {
      telemetryDir,
      projectDir,
      run: (toolID, parameters) => definitionHook({ toolID }, { description: "d", parameters }),
      dispose: async () => {
        await hooks.dispose?.();
      },
    };
  }

  test("log_only (default): oneOf root -> violation recorded, schema untouched, warn logged", async () => {
    const warnSpy = spyOn(console, "warn");
    const instance = await harness({});
    try {
      const schema = {
        oneOf: [{ type: "object", properties: { a: { type: "string" } } }],
      };
      const before = JSON.stringify(schema);
      await instance.run("mcp_oneof_tool", schema);

      // The schema passed through the hook byte-identical (log_only).
      expect(JSON.stringify(schema)).toBe(before);

      // The warning reached the log channel (call[0] is the [astrocode]
      // prefix; the message follows in the remaining args).
      expect(
        warnSpy.mock.calls.some((call) =>
          call.map(String).join(" ").includes("mcp_oneof_tool"),
        ),
      ).toBe(true);

      // Telemetry batches writes: dispose drains synchronously before reading.
      await instance.dispose();
      const records = readRecords(instance.telemetryDir).filter(
        (record) => record.kind === "schema_violation",
      );
      expect(records).toHaveLength(1);
      const event = records[0]?.event as Record<string, unknown>;
      expect(event.tool_name).toBe("mcp_oneof_tool");
      expect(event.code).toBe("root_combinator");
      expect(event.severity).toBe("error");
    } finally {
      warnSpy.mockRestore();
      await instance.dispose();
      rmSync(instance.telemetryDir, { recursive: true, force: true });
      rmSync(instance.projectDir, { recursive: true, force: true });
    }
  });

  test("log_only (default): valid schema -> no records, no mutation", async () => {
    const instance = await harness({});
    try {
      const schema = validSchema();
      const before = JSON.stringify(schema);
      await instance.run("bash", schema);
      expect(JSON.stringify(schema)).toBe(before);
      await instance.dispose();
      expect(readRecords(instance.telemetryDir)).toHaveLength(0);
    } finally {
      await instance.dispose();
      rmSync(instance.telemetryDir, { recursive: true, force: true });
      rmSync(instance.projectDir, { recursive: true, force: true });
    }
  });

  test("repair mode: missing root type repaired when properties present", async () => {
    const instance = await harness({
      schema_validator: { enabled: true, log_only: false },
    });
    try {
      const schema: Record<string, unknown> = { properties: { a: { type: "string" } } };
      await instance.run("loose_tool", schema);
      expect(schema.type).toBe("object");
    } finally {
      await instance.dispose();
      rmSync(instance.telemetryDir, { recursive: true, force: true });
      rmSync(instance.projectDir, { recursive: true, force: true });
    }
  });

  test("repair mode: anyOf root is never rewritten (log + recommendation only)", async () => {
    const instance = await harness({
      schema_validator: { enabled: true, log_only: false },
    });
    try {
      const schema = {
        anyOf: [{ type: "object", properties: { a: { type: "string" } } }],
      };
      const before = JSON.stringify(schema);
      await instance.run("mcp_anyof_tool", schema);
      expect(JSON.stringify(schema)).toBe(before);
      expect(schema.anyOf).toBeDefined();
    } finally {
      await instance.dispose();
      rmSync(instance.telemetryDir, { recursive: true, force: true });
      rmSync(instance.projectDir, { recursive: true, force: true });
    }
  });

  test("enabled: false -> no validation, no records", async () => {
    const instance = await harness({
      schema_validator: { enabled: false },
    });
    try {
      const schema = { oneOf: [{ type: "object" }] };
      await instance.run("mcp_tool", schema);
      await instance.dispose();
      expect(readRecords(instance.telemetryDir)).toHaveLength(0);
    } finally {
      await instance.dispose();
      rmSync(instance.telemetryDir, { recursive: true, force: true });
      rmSync(instance.projectDir, { recursive: true, force: true });
    }
  });

  test("config defaults: enabled true, log_only true (parse discipline)", async () => {
    // No astrocode.jsonc at all -> defaults. Verified through the hook: a
    // violating schema is recorded but NOT repaired.
    const projectDir = tempDir("astrocode-t15-project-");
    const telemetryDir = tempDir("astrocode-t15-telemetry-");
    process.env.ASTROCODE_TELEMETRY_DIR = telemetryDir;
    try {
      const hooks = await astrocodePlugin(pluginInput(projectDir));
      const hook = hooks["tool.definition"];
      if (!hook) throw new Error("tool.definition hook not registered");
      configureLogger(undefined);
      const schema: Record<string, unknown> = { properties: { a: { type: "string" } } };
      await hook({ toolID: "loose" }, { description: "d", parameters: schema });
      expect(schema.type).toBeUndefined(); // log_only default: not repaired
      await hooks.dispose?.();
      const records = readRecords(telemetryDir).filter(
        (record) => record.kind === "schema_violation",
      );
      expect(records).toHaveLength(1); // but validated + recorded
    } finally {
      delete process.env.ASTROCODE_TELEMETRY_DIR;
      rmSync(telemetryDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("telemetry dir was created by the plugin run (sanity)", async () => {
    const instance = await harness({});
    try {
      expect(existsSync(instance.telemetryDir)).toBe(true);
    } finally {
      await instance.dispose();
      rmSync(instance.telemetryDir, { recursive: true, force: true });
      rmSync(instance.projectDir, { recursive: true, force: true });
    }
  });
});
