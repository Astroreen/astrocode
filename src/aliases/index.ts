// Deprecated tool-alias tools (plan T5/T6, workstream B).
//
// buildAliasTools turns the static ALIAS_REGISTRY into real opencode plugin
// tools: one `tool()` per entry, registered under the bare legacy name.
//
// Redirect-kind entries soft-redirect: they record one `alias_hit` telemetry
// record and return a SUCCESS result telling the model to call the canonical
// tool exactly once. They never throw and never perform side effects, so a
// hallucinated legacy name costs one cheap hop instead of an error loop.
//
// Delegate-kind entries (T6) perform a real side effect through the plugin SDK
// client, keyed by the registry's `canonical` action tag:
//   child-abort   — TaskStop  -> client.session.abort on the child session
//   child-output  — TaskOutput -> client.session.messages digest (<=2000 chars)
//   session-todos — Task_Get/TaskGet/Task_List/TaskList/TodoRead ->
//                   client.session.todo for the current session
// Business failures (missing session id, unknown session, route error) are
// returned as informative SUCCESS text — never thrown, never an error part.
//
// Args: an empty Zod raw shape. opencode wraps plugin-tool args with
// `z.object(args)`, which accepts ANY object (unknown keys are ignored) and
// forwards the raw call args to execute — exactly the loose legacy-shape
// acceptance we need. (`z.object({}).passthrough()` cannot be used here: the
// plugin SDK types require `args` to be a ZodRawShape, not a ZodObject.)

import {
  tool,
  type PluginInput,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@opencode-ai/plugin";
import type { z } from "zod";
import { log } from "../log";
import {
  createTelemetryLogger,
  recordAliasHit,
  type TelemetryLogger,
} from "../telemetry/log";
import { ALIAS_REGISTRY, type AliasDefinition } from "./registry";

/** Empty Zod raw shape: accepts any object args, forwards them raw. */
function legacyArgsShape(): z.ZodRawShape {
  return {};
}

// No-op sink for standalone use (tests, disabled telemetry) — reuses the
// telemetry factory's shared no-op instead of a parallel implementation.
function fallbackSink(): TelemetryLogger {
  return createTelemetryLogger({ enabled: false });
}

// JSON echo of whatever the model actually sent. Defensive: serialization of
// hostile input must never break the redirect.
function echoArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {});
  } catch (err) {
    log.error("aliases: failed to serialize received args for echo", err);
    return "unserializable";
  }
}

// ---------------------------------------------------------------------------
// T6 delegate seam
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the SDK client the delegate bodies need. The real
 * `PluginInput["client"]` satisfies this structurally (verified at compile
 * time: buildAliasTools passes it straight into executeAlias), and tests can
 * implement it without casts.
 */
export interface AliasDelegateClient {
  session: {
    get(options: { path: { id: string } }): Promise<AliasGetResult>;
    abort(options: { path: { id: string } }): Promise<AliasAbortResult>;
    messages(options: { path: { id: string } }): Promise<AliasMessagesResult>;
    todo(options: { path: { id: string } }): Promise<AliasTodoResult>;
  };
}

/** RequestResult-shaped outcomes: data on success, error on failure. */
export interface AliasGetResult {
  data?: unknown;
  error?: unknown;
}
export interface AliasAbortResult {
  data?: boolean;
  error?: unknown;
}
export interface AliasTodoResult {
  data?: unknown;
  error?: unknown;
}
export interface AliasMessagesResult {
  data?: AliasMessageEntry[];
  error?: unknown;
}
export interface AliasMessageEntry {
  info: { role?: string };
  parts: unknown[];
}

/** Cap for the TaskOutput child-output digest (plan T6). */
const CHILD_OUTPUT_LIMIT = 2000;

/**
 * Resolve a child session id from loose legacy args. Accepts the shapes Claude
 * Code models actually emit: `sessionID` / `session_id` / `id`.
 */
function resolveSessionID(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["sessionID", "session_id", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "NotFoundError"
  );
}

/** Best-effort human-readable reason from a RequestResult error object. */
function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const record = err as { data?: { message?: unknown }; message?: unknown };
    const message = record.data?.message ?? record.message;
    if (typeof message === "string" && message.length > 0) {
      return message.slice(0, 200);
    }
  }
  return "unknown error";
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

/**
 * Digest of a child session's assistant text output: the last assistant text
 * parts joined, truncated to the tail with an explicit marker when over the
 * cap. Empty string when the child has no assistant text yet.
 */
function digestChildOutput(entries: AliasMessageEntry[]): string {
  const texts: string[] = [];
  for (const entry of entries) {
    if (!entry || entry.info?.role !== "assistant") continue;
    for (const part of entry.parts ?? []) {
      if (isTextPart(part)) texts.push(part.text);
    }
  }
  if (texts.length === 0) return "";
  const joined = texts.join("\n\n");
  if (joined.length <= CHILD_OUTPUT_LIMIT) return joined;
  const marker = `[truncated — showing the last ${CHILD_OUTPUT_LIMIT} characters]\n`;
  return marker + joined.slice(joined.length - CHILD_OUTPUT_LIMIT);
}

/**
 * TaskStop delegate: abort the child session resolved from args. The child is
 * resolved via GET /session/{id} first (opencode's abort route is
 * fire-and-forget and never 404s); abort runs only when the session exists.
 * Always returns informative success text; never throws on business errors.
 */
async function executeChildAbort(
  client: AliasDelegateClient,
  alias: string,
  args: unknown,
  echo: string,
): Promise<ToolResult> {
  const childID = resolveSessionID(args);
  if (!childID) {
    return (
      `TaskStop via deprecated alias \`${alias}\`: no such child session — ` +
      `arguments carry no resolvable session id (accepts sessionID / ` +
      `session_id / id). Nothing was stopped. Execute now: continue without ` +
      `it. Do not retry this alias.` +
      `\n\nReceived arguments: ${echo}`
    );
  }
  try {
    // Existence probe first: opencode's abort route is fire-and-forget (200
    // `true` even for unknown ids), so "no such child session" can only be
    // detected via GET /session/{id} (404). Abort is called only when the
    // child session actually resolves.
    const probe = await client.session.get({ path: { id: childID } });
    if (probe.error) {
      if (isNotFoundError(probe.error)) {
        return (
          `TaskStop: no such child session \`${childID}\`. Nothing was ` +
          `stopped. Execute now: continue without it. Do not retry this alias.`
        );
      }
      return (
        `TaskStop: could not resolve session \`${childID}\` ` +
        `(${describeError(probe.error)}). Nothing was stopped. Execute now: ` +
        `continue without it. Do not retry this alias.`
      );
    }
    const result = await client.session.abort({ path: { id: childID } });
    if (result.error) {
      return (
        `TaskStop: could not abort session \`${childID}\` ` +
        `(${describeError(result.error)}). Execute now: continue without it. ` +
        `Do not retry this alias.`
      );
    }
    return `Stopped session ${childID}.`;
  } catch (err) {
    log.error(`aliases: ${alias} abort call threw for ${childID}`, err);
    return (
      `TaskStop: could not abort session \`${childID}\` (internal error). ` +
      `Execute now: continue without it. Do not retry this alias.`
    );
  }
}

/**
 * TaskOutput delegate: read the child session's messages and return a digest
 * of its assistant text output (<= 2000 chars). Never throws on business
 * errors.
 */
async function executeChildOutput(
  client: AliasDelegateClient,
  alias: string,
  args: unknown,
  echo: string,
): Promise<ToolResult> {
  const childID = resolveSessionID(args);
  if (!childID) {
    return (
      `TaskOutput via deprecated alias \`${alias}\`: no resolvable child ` +
      `session id in arguments (accepts sessionID / session_id / id). ` +
      `Execute now: continue without it — nothing to read. Do not retry ` +
      `this alias.` +
      `\n\nReceived arguments: ${echo}`
    );
  }
  try {
    const result = await client.session.messages({ path: { id: childID } });
    if (result.error) {
      if (isNotFoundError(result.error)) {
        return (
          `TaskOutput: no such child session \`${childID}\`. Execute now: ` +
          `continue without it. Do not retry this alias.`
        );
      }
      return (
        `TaskOutput: could not read session \`${childID}\` ` +
        `(${describeError(result.error)}). Execute now: continue without it. ` +
        `Do not retry this alias.`
      );
    }
    const digest = digestChildOutput(result.data ?? []);
    if (!digest) {
      return (
        `TaskOutput: child session \`${childID}\` has no assistant text ` +
        `output yet. Execute now: continue without it. Do not retry this alias.`
      );
    }
    return `TaskOutput for session \`${childID}\`:\n${digest}`;
  } catch (err) {
    log.error(`aliases: ${alias} messages call threw for ${childID}`, err);
    return (
      `TaskOutput: could not read session \`${childID}\` (internal error). ` +
      `Execute now: continue without it. Do not retry this alias.`
    );
  }
}

/**
 * session-todos delegate (Task_Get/TaskGet/Task_List/TaskList/TodoRead):
 * read the CURRENT session's todo list via the same route as the idle
 * continuation (client.session.todo) and render it as text.
 */
async function executeSessionTodos(
  client: AliasDelegateClient,
  alias: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await client.session.todo({ path: { id: ctx.sessionID } });
    if (result.error) {
      return (
        `Todo list via deprecated alias \`${alias}\`: could not read this ` +
        `session's todos (${describeError(result.error)}). Execute now: ` +
        `continue without it. Do not retry this alias.`
      );
    }
    const todos = Array.isArray(result.data) ? result.data : [];
    if (todos.length === 0) {
      return (
        `Session todo list is empty. Execute now: continue without it. ` +
        `Do not retry this alias.`
      );
    }
    const lines = todos
      .map((todo) => {
        const item = todo as { status?: unknown; content?: unknown };
        const status =
          typeof item.status === "string" ? item.status : "unknown";
        const content =
          typeof item.content === "string" ? item.content : "(no content)";
        return `- [${status}] ${content}`;
      })
      .join("\n");
    return (
      `Session todo list:\n${lines}\n\nExecute now: continue with the ` +
      `incomplete items. Do not retry this alias.`
    );
  } catch (err) {
    log.error(`aliases: ${alias} todo call threw`, err);
    return (
      `Todo list via deprecated alias \`${alias}\`: could not read this ` +
      `session's todos (internal error). Execute now: continue without it. ` +
      `Do not retry this alias.`
    );
  }
}

/**
 * Delegate dispatcher keyed by the registry's `canonical` action tag. Every
 * branch returns informative success text — business errors never throw.
 */
async function executeDelegate(
  def: AliasDefinition,
  args: unknown,
  ctx: ToolContext,
  client: AliasDelegateClient,
): Promise<ToolResult> {
  const echo = echoArgs(args);
  switch (def.canonical) {
    case "child-abort":
      return executeChildAbort(client, def.name, args, echo);
    case "child-output":
      return executeChildOutput(client, def.name, args, echo);
    case "session-todos":
      return executeSessionTodos(client, def.name, ctx);
    default:
      // Registry extended without a delegate body: static no-effect text.
      return (
        `Called via deprecated alias \`${def.name}\`. This harness has no ` +
        `such tool. Execute now: continue without it — this alias has no ` +
        `effect in this session. Do not retry this alias.` +
        `\n\nReceived arguments: ${echo}`
      );
  }
}

// Soft-redirect/delegate body shared by every alias. ALWAYS succeeds.
// Exported for direct testing with hostile (non-object) args — the tool()
// wrapper types execute's args as an object, but the body itself tolerates
// any JSON value.
//
// `client` is the T6 delegate seam: delegate-kind entries route through it
// (executeDelegate). Without a client (standalone/test use) delegates fall
// back to the static no-effect text.
export async function executeAlias(
  def: AliasDefinition,
  args: unknown,
  ctx: ToolContext,
  telemetry: TelemetryLogger,
  client?: AliasDelegateClient,
): Promise<ToolResult> {
  try {
    recordAliasHit(
      telemetry,
      {
        session_id: ctx.sessionID,
        message_id: ctx.messageID,
        agent: ctx.agent,
      },
      { alias: def.name, canonical: def.canonical, kind: def.kind },
    );

    if (def.kind === "delegate") {
      if (!client) {
        // No client seam in scope: static no-effect text, no side effect.
        const echo = echoArgs(args);
        return (
          `Called via deprecated alias \`${def.name}\`. This harness has no ` +
          `such tool. Execute now: continue without it — this alias has no ` +
          `effect in this session. Do not retry this alias.` +
          `\n\nReceived arguments: ${echo}`
        );
      }
      return await executeDelegate(def, args, ctx, client);
    }
    const echo = echoArgs(args);
    const hint = def.hint ? ` (${def.hint})` : "";
    return (
      `Called via deprecated alias \`${def.name}\`. This harness has no ` +
      `such tool. Execute now: call \`${def.canonical}\` exactly once with ` +
      `your intended arguments${hint}. Do not retry this alias.` +
      `\n\nReceived arguments: ${echo}`
    );
  } catch (err) {
    // The alias body must never surface an error part to the model.
    log.error(`aliases: execute for ${def.name} threw; static fallback`, err);
    if (def.kind === "delegate") {
      return (
        `Called via deprecated alias \`${def.name}\`. Execute now: continue ` +
        `without it. Do not retry this alias.`
      );
    }
    return (
      `Called via deprecated alias \`${def.name}\`. Execute now: call ` +
      `\`${def.canonical}\` exactly once. Do not retry this alias.`
    );
  }
}

/**
 * Build the plugin tool map for every registry entry.
 *
 * @param client the plugin SDK client — the T6 delegate seam. Delegate-kind
 *   entries issue real side effects through it (TaskStop abort, TaskOutput
 *   messages digest, session-todos read).
 * @param telemetry the shared JSONL sink; defaults to a no-op logger so the
 *   builder stays usable in isolation (tests, disabled telemetry).
 */
export function buildAliasTools(
  client: PluginInput["client"],
  telemetry?: TelemetryLogger,
): Record<string, ToolDefinition> {
  const sink = telemetry ?? fallbackSink();
  const tools: Record<string, ToolDefinition> = {};
  for (const def of ALIAS_REGISTRY) {
    tools[def.name] = tool({
      description: def.description,
      args: legacyArgsShape(),
      execute: (args, ctx) => executeAlias(def, args, ctx, sink, client),
    });
  }
  return tools;
}