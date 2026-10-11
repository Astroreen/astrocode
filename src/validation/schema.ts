// Tool-schema hygiene validator (plan T15, workstream F).
//
// Pure, synchronous, IO-free: `validateToolSchema(name, parameters)` inspects
// one tool definition (the same `{description, parameters}` shape the
// `tool.definition` hook carries) and returns every hygiene violation it can
// detect WITHOUT ever mutating the input. The `tool.definition` hook in
// src/index.ts runs it on every outgoing schema; findings are recorded to
// telemetry (kind "schema_violation") and logged.
//
// Why: MCP servers commonly expose tools whose root schema is a bare
// anyOf/oneOf/allOf combinator (or omits `type` entirely). Such schemas break
// the Anthropic tool protocol (input_schema must be a typed object) and can
// degrade provider-side tool-schema caching. This validator surfaces those
// cases; it deliberately does NOT try to rewrite combinator semantics.
//
// Violation shape (documented contract, consumed by telemetry + tests):
//
//   { code: ViolationCode, severity: "error" | "warning", path?: string, message: string }
//
// `path` is a JSON-pointer-like location ("$", "$.properties.foo.items") into
// the parameters schema; it is omitted for whole-schema findings (name checks).
//
// Cycle safety: a nested `$ref` loop can make a schema graph cyclic. The walk
// tracks visited object nodes by identity and caps depth, so a cyclic schema
// terminates instead of hanging the hook.

/** Machine-readable violation codes (stable contract — telemetry consumers). */
export type ViolationCode =
  /** Tool name is not a string, or fails ^[a-zA-Z0-9_-]{1,64}$. */
  | "invalid_name"
  /** parameters is not a JSON object at all. */
  | "parameters_not_object"
  /** Root-level anyOf/oneOf/allOf combinator (the MCP protocol-breaker). */
  | "root_combinator"
  /** Root `type` present but not "object". */
  | "root_not_object"
  /** Root `type` absent (no combinator either); repairable when properties exist. */
  | "root_type_missing"
  /** A `required` array references a key absent from the same node's `properties`. */
  | "required_not_in_properties"
  /** A sub-field carries an empty/whitespace description (advisory). */
  | "empty_description";

export type ViolationSeverity = "error" | "warning";

export interface Violation {
  code: ViolationCode;
  severity: ViolationSeverity;
  /** JSON-pointer-like location inside the parameters schema; "$" is the root. */
  path?: string;
  message: string;
}

/** opencode/Anthropic-compatible tool-name charset and length bound. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Root combinators treated as protocol-breaking (plan T15 rule b). */
const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

/** Depth cap for the nested walk (defensive; real schemas are shallow). */
const MAX_WALK_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/** Rule (a): name must match ^[a-zA-Z0-9_-]{1,64}$. */
function checkName(name: unknown, out: Violation[]): void {
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    out.push({
      code: "invalid_name",
      severity: "error",
      message:
        `tool name ${JSON.stringify(name)} must match ^[a-zA-Z0-9_-]{1,64}$ ` +
        `(1..64 chars of letters, digits, underscore, hyphen)`,
    });
  }
}

/**
 * Rule (b): the root must be a typed object schema.
 *  - anyOf/oneOf/allOf at root -> root_combinator (primary MCP signal; also
 *    the minimal stand-in for a full nested $ref-loop analysis: absence of
 *    `type` + presence of a root combinator is the loop-prone shape);
 *  - `type` present but !== "object" -> root_not_object;
 *  - `type` absent entirely (no combinator) -> root_type_missing (the only
 *    root finding with a safe repair: add "type": "object" when properties
 *    exist — see repairToolSchema).
 */
function checkRoot(schema: Record<string, unknown>, out: Violation[]): void {
  let hasCombinator = false;
  for (const combinator of ROOT_COMBINATORS) {
    if (schema[combinator] !== undefined) {
      hasCombinator = true;
      out.push({
        code: "root_combinator",
        severity: "error",
        path: "$",
        message:
          `root-level "${combinator}" combinator breaks the typed-object tool ` +
          `protocol; mitigation: disable the tool per-agent ` +
          `(astrocode.jsonc tools: {"<name>": false}) or fix it upstream`,
      });
    }
  }
  // A root combinator subsumes the missing-type finding (the combinator IS
  // the problem; "type" is meaningless next to it) — report one or the other,
  // never both.
  if (hasCombinator) return;
  if (schema.type === undefined) {
    out.push({
      code: "root_type_missing",
      severity: "error",
      path: "$",
      message:
        'root "type" is missing; if the schema describes an object ' +
        '(has "properties"), it can be safely repaired to {"type": "object"}',
    });
    return;
  }
  if (schema.type !== "object") {
    out.push({
      code: "root_not_object",
      severity: "error",
      path: "$",
      message: `root "type" is ${JSON.stringify(schema.type)}, expected "object"`,
    });
  }
}

/** Rule (c): every `required` entry must exist among the node's `properties`. */
function checkRequired(schema: Record<string, unknown>, path: string, out: Violation[]): void {
  const required = asStringArray(schema.required);
  if (!required || !isPlainObject(schema.properties)) return;
  const propertyKeys = new Set(Object.keys(schema.properties));
  const missing = required.filter((key) => !propertyKeys.has(key));
  if (missing.length > 0) {
    out.push({
      code: "required_not_in_properties",
      severity: "error",
      path,
      message: `required references missing propert${missing.length === 1 ? "y" : "ies"}: ` +
        missing.map((key) => JSON.stringify(key)).join(", "),
    });
  }
}

/** Rule (d): a PRESENT but empty/whitespace description is advisory noise. */
function checkDescription(schema: Record<string, unknown>, path: string, out: Violation[]): void {
  const description = schema.description;
  if (typeof description === "string" && description.trim().length === 0) {
    out.push({
      code: "empty_description",
      severity: "warning",
      path,
      message: "empty description on a sub-field (advisory: describe the field for the model)",
    });
  }
}

/**
 * Bounded recursive walk over properties/items/anyOf-style branches. `seen`
 * breaks reference cycles (a $ref loop can make child === ancestor); the depth
 * cap is a second belt-and-suspenders bound.
 */
function walkNode(
  node: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  out: Violation[],
): void {
  if (!isPlainObject(node)) return;
  if (seen.has(node) || depth > MAX_WALK_DEPTH) return;
  seen.add(node);

  checkRequired(node, path, out);
  checkDescription(node, path, out);

  const properties = isPlainObject(node.properties) ? node.properties : undefined;
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      walkNode(child, `${path}.properties.${key}`, depth + 1, seen, out);
    }
  }

  // Branching keywords: walk each branch with the same node identity set so a
  // combinator that loops back to an ancestor terminates.
  for (const combinator of ROOT_COMBINATORS) {
    const branches = node[combinator];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => {
        walkNode(branch, `${path}.${combinator}[${index}]`, depth + 1, seen, out);
      });
    }
  }

  const items = node.items;
  if (items !== undefined) {
    if (Array.isArray(items)) {
      items.forEach((item, index) => {
        walkNode(item, `${path}.items[${index}]`, depth + 1, seen, out);
      });
    } else {
      walkNode(items, `${path}.items`, depth + 1, seen, out);
    }
  }

  const additionalProperties = node.additionalProperties;
  if (isPlainObject(additionalProperties)) {
    walkNode(additionalProperties, `${path}.additionalProperties`, depth + 1, seen, out);
  }
}

/**
 * Validate one tool definition. Pure: never mutates `parameters`, never
 * touches the filesystem, never throws (garbage in -> violations out).
 *
 * Returns ALL violations found (errors and warnings together); callers filter
 * by severity if needed. An empty array means the schema passed every check.
 */
export function validateToolSchema(name: unknown, parameters: unknown): Violation[] {
  const out: Violation[] = [];
  checkName(name, out);
  if (!isPlainObject(parameters)) {
    out.push({
      code: "parameters_not_object",
      severity: "error",
      path: "$",
      message: "parameters must be a JSON schema object",
    });
    return out;
  }
  checkRoot(parameters, out);
  walkNode(parameters, "$", 0, new Set(), out);
  return out;
}

/**
 * The ONLY repair the hook may apply (plan T15 boundary): when the root has
 * `properties` but no `type`, add `"type": "object"` in place. Root-level
 * anyOf/oneOf/allOf semantics are NEVER rewritten — collapsing a combinator
 * into an object schema changes which inputs the tool accepts, so those cases
 * get a log + mitigation recommendation only. Returns true when repaired.
 *
 * Mutates the passed schema object in place (the hook's output.parameters is
 * host-owned and mutated in place, same pattern as the system-transform hook).
 */
export function repairToolSchema(parameters: unknown): boolean {
  if (!isPlainObject(parameters)) return false;
  // Boundary (documented per plan): type-addition is the single safe repair.
  // anyOf/oneOf/allOf roots are left untouched — see the module docstring.
  if (parameters.type === undefined && isPlainObject(parameters.properties)) {
    parameters.type = "object";
    return true;
  }
  return false;
}
