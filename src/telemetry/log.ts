// Telemetry JSONL sink (plan T1) — the single sink every astrocode subsystem
// writes usage/diagnostic records into.
//
// Layout: one append-only JSONL file per day, one JSON object per line:
//
//   telemetry-YYYY-MM-DD.jsonl
//
// inside the telemetry dir root, resolved as (first match wins):
//
//   1. ASTROCODE_TELEMETRY_DIR env var  -> used as the dir root directly
//   2. telemetry.dir config option      -> used as the dir root directly
//   3. ${XDG_STATE_HOME ?? ~/.local/state}/astrocode/telemetry
//
// Every line is a TelemetryRecord (strict snake_case shape below). Payloads
// are validated before writing: unknown fields are dropped, invalid records
// are rejected with log.error and skipped — so every line of every file stays
// parseable JSON. Writes are batched (up to 50 records or 2 seconds, flushed
// by an unref'd setTimeout that never keeps the event loop alive); close()
// drains the remainder synchronously. Date rotation happens on record: when
// today's date differs from the open file's date, the pending batch is
// flushed to the old file and new records go to the new filename.

import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";

export const TELEMETRY_KINDS = [
  "usage",
  "fallback",
  "compaction",
  "tool_error",
  "budget_block",
  "schema_violation",
  "system_diff",
  "alias_hit",
  "cache_alarm",
] as const;

export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

export interface TelemetryTokens {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

export interface TelemetryPayload {
  session_id: string;
  message_id?: string;
  agent?: string;
  model?: { provider_id: string; model_id: string };
  tokens?: TelemetryTokens;
  cost_usd?: number;
  cache_ratio?: number;
  event?: Record<string, string | number | boolean | null>;
}

export type TelemetryRecord = TelemetryPayload & {
  ts: string;
  kind: TelemetryKind;
};

export interface TelemetryLogger {
  /** Validate + enqueue one record. Never throws; invalid input is logged. */
  record(kind: TelemetryKind, payload: unknown): void;
  /** Drain pending records synchronously and stop the flush timer. */
  close(): void;
}

export interface TelemetryLoggerOptions {
  /** `telemetry.dir` config override — used as the dir root directly. */
  dir?: string;
  /** `telemetry.enabled` config flag; false -> shared no-op, zero I/O. */
  enabled?: boolean;
  /** Injectable clock (tests). Defaults to the real clock. */
  now?: () => Date;
  /** Batch age limit in ms (default 2000). */
  flushIntervalMs?: number;
  /** Batch size limit in records (default 50). */
  maxBatchSize?: number;
}

// Cache alarm thresholds (plan T1): a large prompt whose cache hit ratio
// dropped below 0.95 signals something broke prefix-cache reuse.
export const CACHE_ALARM_RATIO = 0.95;
export const CACHE_ALARM_MIN_TOKENS = 10000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTelemetryKind(value: unknown): value is TelemetryKind {
  return (
    typeof value === "string" &&
    (TELEMETRY_KINDS as readonly string[]).includes(value)
  );
}

// cache_read / (cache_read + cache_write + input); a zero denominator (no
// billable context at all) counts as a perfect 1.0.
export function cacheRatio(tokens: TelemetryTokens): number {
  const denominator = tokens.cache_read + tokens.cache_write + tokens.input;
  if (denominator <= 0) return 1.0;
  return tokens.cache_read / denominator;
}

// Strict input validation: copies only the known snake_case fields, drops
// unknown ones, and rejects (returns undefined + log.error) when a present
// field has the wrong shape. Rejected records are never written, so the JSONL
// stream stays valid.
function parseTelemetryRecord(
  kind: unknown,
  payload: unknown,
): TelemetryRecord | undefined {
  if (!isTelemetryKind(kind)) {
    log.error("telemetry: rejected record with unknown kind", kind);
    return undefined;
  }
  if (!isPlainObject(payload)) {
    log.error("telemetry: rejected record, payload must be an object", kind);
    return undefined;
  }

  const session_id = asNonEmptyString(payload.session_id);
  if (!session_id) {
    log.error("telemetry: rejected record, missing session_id", kind);
    return undefined;
  }

  const record: TelemetryRecord = {
    ts: new Date().toISOString(),
    kind,
    session_id,
  };

  const message_id = asNonEmptyString(payload.message_id);
  if (message_id) record.message_id = message_id;
  const agent = asNonEmptyString(payload.agent);
  if (agent) record.agent = agent;

  if (payload.model !== undefined) {
    if (!isPlainObject(payload.model)) {
      log.error("telemetry: rejected record, bad model field", kind);
      return undefined;
    }
    const provider_id = asNonEmptyString(payload.model.provider_id);
    const model_id = asNonEmptyString(payload.model.model_id);
    if (!provider_id || !model_id) {
      log.error("telemetry: rejected record, incomplete model field", kind);
      return undefined;
    }
    record.model = { provider_id, model_id };
  }

  if (payload.tokens !== undefined) {
    if (!isPlainObject(payload.tokens)) {
      log.error("telemetry: rejected record, bad tokens field", kind);
      return undefined;
    }
    const input = asFiniteNumber(payload.tokens.input);
    const output = asFiniteNumber(payload.tokens.output);
    const reasoning = asFiniteNumber(payload.tokens.reasoning);
    const cache_read = asFiniteNumber(payload.tokens.cache_read);
    const cache_write = asFiniteNumber(payload.tokens.cache_write);
    if (
      input === undefined ||
      output === undefined ||
      reasoning === undefined ||
      cache_read === undefined ||
      cache_write === undefined
    ) {
      log.error("telemetry: rejected record, incomplete tokens field", kind);
      return undefined;
    }
    record.tokens = { input, output, reasoning, cache_read, cache_write };
  }

  const cost_usd = payload.cost_usd;
  if (cost_usd !== undefined) {
    const cost = asFiniteNumber(cost_usd);
    if (cost === undefined) {
      log.error("telemetry: rejected record, bad cost_usd field", kind);
      return undefined;
    }
    record.cost_usd = cost;
  }

  const cache_ratio = payload.cache_ratio;
  if (cache_ratio !== undefined) {
    const ratio = asFiniteNumber(cache_ratio);
    if (ratio === undefined) {
      log.error("telemetry: rejected record, bad cache_ratio field", kind);
      return undefined;
    }
    record.cache_ratio = ratio;
  }

  if (payload.event !== undefined) {
    if (!isPlainObject(payload.event)) {
      log.error("telemetry: rejected record, bad event field", kind);
      return undefined;
    }
    const event: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(payload.event)) {
      const scalar =
        typeof value === "string" ||
        value === null ||
        value === undefined ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean";
      if (scalar) event[key] = value === undefined ? null : value;
    }
    record.event = event;
  }

  return record;
}

function dateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Precedence: env var (ops override) > config dir > XDG state default. The
// env/config overrides become the dir root directly; the default nests under
// astrocode/telemetry inside the state base.
function resolveTelemetryDir(configDir: string | undefined): string {
  const envDir = process.env.ASTROCODE_TELEMETRY_DIR?.trim();
  if (envDir) return envDir;
  const configured = configDir?.trim();
  if (configured) return configured;
  const stateBase =
    process.env.XDG_STATE_HOME?.trim() ||
    join(homedir(), ".local", "state");
  return join(stateBase, "astrocode", "telemetry");
}

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH_SIZE = 50;

class JsonlTelemetryLogger implements TelemetryLogger {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentDate: string;
  private dirEnsured = false;
  private closed = false;

  constructor(options: TelemetryLoggerOptions) {
    this.dir = resolveTelemetryDir(options.dir);
    this.now = options.now ?? (() => new Date());
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.currentDate = dateStamp(this.now());
  }

  record(kind: TelemetryKind, payload: unknown): void {
    if (this.closed) return;
    try {
      const parsed = parseTelemetryRecord(kind, payload);
      if (!parsed) return;
      const stamp = dateStamp(this.now());
      if (stamp !== this.currentDate) {
        // Day rolled over: drain the pending batch into the old file first.
        this.flush();
        this.currentDate = stamp;
      }
      this.pending.push(JSON.stringify(parsed));
      if (this.pending.length >= this.maxBatchSize) {
        this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch (err) {
      log.error("telemetry: record failed", err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const file = join(this.dir, `telemetry-${this.currentDate}.jsonl`);
    const body = this.pending.join("\n") + "\n";
    this.pending = [];
    // Final drain is synchronous so data survives an immediate process exit.
    try {
      if (!this.dirEnsured) {
        mkdirSync(this.dir, { recursive: true });
        this.dirEnsured = true;
      }
      appendFileSync(file, body, "utf8");
    } catch (err) {
      this.dirEnsured = false;
      log.error(`telemetry: close flush failed (${file})`, err);
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    // Never keep the host event loop alive for telemetry.
    timer.unref();
    this.timer = timer;
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const file = join(this.dir, `telemetry-${this.currentDate}.jsonl`);
    const body = this.pending.join("\n") + "\n";
    this.pending = [];
    void this.write(file, body);
  }

  private async write(file: string, body: string): Promise<void> {
    try {
      if (!this.dirEnsured) {
        await mkdir(this.dir, { recursive: true });
        this.dirEnsured = true;
      }
      await appendFile(file, body, "utf8");
    } catch (err) {
      // Retry mkdir on the next flush (the dir may reappear); the dropped
      // batch is reported, never silently swallowed, and never rethrown.
      this.dirEnsured = false;
      log.error(`telemetry: write failed (${file})`, err);
    }
  }
}

const NOOP_LOGGER: TelemetryLogger = {
  record: () => undefined,
  close: () => undefined,
};

// Factory short-circuit: `enabled: false` returns the shared no-op before any
// filesystem work happens — zero I/O, not even directory creation.
export function createTelemetryLogger(
  options: TelemetryLoggerOptions = {},
): TelemetryLogger {
  if (options.enabled === false) return NOOP_LOGGER;
  return new JsonlTelemetryLogger(options);
}

// message.updated can fire several times per assistant message (creation,
// completion, error re-emission). Exactly one usage record per message id;
// bounded so a long-lived session cannot grow the set forever.
const RECORDED_MESSAGE_LIMIT = 4096;
const recordedMessageIds = new Set<string>();

// Defensive extraction of an SDK AssistantMessage-like object
// ({id, sessionID, providerID, modelID, cost, tokens: {input, output,
// reasoning, cache: {read, write}}, time: {created, completed?}, error?}).
// Nullish fields fall back sensibly: the record keeps whatever is known.
export function assistantUsagePayload(
  info: unknown,
): TelemetryPayload | undefined {
  if (!isPlainObject(info)) return undefined;
  const sessionID = asNonEmptyString(info.sessionID);
  if (!sessionID) return undefined;

  const payload: TelemetryPayload = { session_id: sessionID };

  const messageID = asNonEmptyString(info.id);
  if (messageID) payload.message_id = messageID;

  const providerID = asNonEmptyString(info.providerID);
  const modelID = asNonEmptyString(info.modelID);
  if (providerID && modelID) {
    payload.model = { provider_id: providerID, model_id: modelID };
  }

  if (isPlainObject(info.tokens)) {
    const cache = isPlainObject(info.tokens.cache) ? info.tokens.cache : {};
    const tokens: TelemetryTokens = {
      input: asFiniteNumber(info.tokens.input) ?? 0,
      output: asFiniteNumber(info.tokens.output) ?? 0,
      reasoning: asFiniteNumber(info.tokens.reasoning) ?? 0,
      cache_read: asFiniteNumber(cache.read) ?? 0,
      cache_write: asFiniteNumber(cache.write) ?? 0,
    };
    payload.tokens = tokens;
    payload.cache_ratio = cacheRatio(tokens);
  }

  const cost = asFiniteNumber(info.cost);
  if (cost !== undefined) payload.cost_usd = cost;

  return payload;
}

// ---------------------------------------------------------------------------
// Typed event sinks (plan T3) — one helper per kind with a fixed `event`
// sub-object schema. Values usually arrive from untyped hook data, so every
// helper re-validates its payload at runtime (type-guard style, no casts):
// an invalid payload is reported via log.error and NOT written, keeping the
// JSONL stream one-parseable-JSON-object-per-line.
// ---------------------------------------------------------------------------

/** Shared top-level context fields every event record carries. */
export interface EventContext {
  session_id: string;
  message_id?: string;
  agent?: string;
  model?: { provider_id: string; model_id: string };
}

/** kind "fallback" — one record per fallback chain rotation (wired by T14). */
export interface FallbackEvent {
  chain_index: number;
  from_model: string;
  to_model: string;
  error_name: string;
  error_class: "terminal" | "transient";
  cooldown_until: string | null;
  reason: string;
}

const FALLBACK_EVENT_KEYS: ReadonlySet<string> = new Set([
  "chain_index",
  "from_model",
  "to_model",
  "error_name",
  "error_class",
  "cooldown_until",
  "reason",
]);

/** kind "compaction" — one record per context compaction (wired by T11). */
export interface CompactionEvent {
  path?: "native" | "scratch";
  outcome?: string;
  source?: string;
  tokens_before?: number;
  tokens_after?: number;
  ratio?: number;
  duration_ms?: number;
  summarizer_model?: string;
}

/** kind "tool_error" — one record per failed tool call (wired live below). */
export interface ToolErrorEvent {
  tool_name: string;
  error: string;
}

/** kind "alias_hit" — one record per deprecated-alias execution (wired by T5). */
export interface AliasHitEvent {
  alias: string;
  canonical: string;
  kind: "redirect" | "delegate";
}

/**
 * kind "system_diff" — one record per detected system-prompt drift (wired by
 * T8). `session_id` is duplicated inside the event on purpose: the top-level
 * field is the record's primary attribution, while the event copy keeps the
 * diff self-contained for consumers that read only the event sub-object.
 */
export interface SystemDiffEvent {
  frozen_sha256: string;
  incoming_sha256: string;
  session_id: string;
}

/**
 * kind "schema_violation" — one record per tool-schema hygiene finding
 * (wired by T15's tool.definition hook). One violation = one record, so
 * per-code counts aggregate directly in the JSONL.
 */
export interface SchemaViolationEvent {
  tool_name: string;
  /** ViolationCode from src/validation/schema.ts (kept as string here so the
   * telemetry module does not import the validator — one-way dependency). */
  code: string;
  severity: string;
  path?: string;
  message: string;
}

const SCHEMA_VIOLATION_EVENT_KEYS: ReadonlySet<string> = new Set([
  "tool_name",
  "code",
  "severity",
  "path",
  "message",
]);

/** Tool error text is truncated to this many characters at the helper. */
export const TOOL_ERROR_MAX_CHARS = 500;

function validateEventContext(
  ctx: EventContext,
  helper: string,
): TelemetryPayload | undefined {
  const session_id = asNonEmptyString(ctx?.session_id);
  if (!session_id) {
    log.error(`telemetry: ${helper} rejected, missing ctx.session_id`);
    return undefined;
  }
  const payload: TelemetryPayload = { session_id };
  const message_id = asNonEmptyString(ctx?.message_id);
  if (message_id) payload.message_id = message_id;
  const agent = asNonEmptyString(ctx?.agent);
  if (agent) payload.agent = agent;
  if (ctx?.model !== undefined) {
    const model = isPlainObject(ctx.model) ? ctx.model : undefined;
    const provider_id = model ? asNonEmptyString(model.provider_id) : undefined;
    const model_id = model ? asNonEmptyString(model.model_id) : undefined;
    if (!provider_id || !model_id) {
      log.error(`telemetry: ${helper} rejected, bad ctx.model`);
      return undefined;
    }
    payload.model = { provider_id, model_id };
  }
  return payload;
}

function isFallbackEvent(value: unknown): value is FallbackEvent {
  if (!isPlainObject(value)) return false;
  // Unknown keys are rejected outright (not silently dropped) so a typo'd
  // producer learns about it via log.error instead of writing lossy records —
  // same discipline as the compaction event schema below.
  for (const key of Object.keys(value)) {
    if (!FALLBACK_EVENT_KEYS.has(key)) return false;
  }
  if (asFiniteNumber(value.chain_index) === undefined) return false;
  if (!asNonEmptyString(value.from_model)) return false;
  if (!asNonEmptyString(value.to_model)) return false;
  if (!asNonEmptyString(value.error_name)) return false;
  if (!asNonEmptyString(value.reason)) return false;
  if (value.error_class !== "terminal" && value.error_class !== "transient")
    return false;
  if (
    value.cooldown_until !== null &&
    asNonEmptyString(value.cooldown_until) === undefined
  )
    return false;
  return true;
}

const COMPACTION_EVENT_KEYS: ReadonlySet<string> = new Set([
  "path",
  "outcome",
  "source",
  "tokens_before",
  "tokens_after",
  "ratio",
  "duration_ms",
  "summarizer_model",
]);

function isCompactionEvent(value: unknown): value is CompactionEvent {
  if (!isPlainObject(value)) return false;
  // Unknown keys are rejected outright (not silently dropped) so a typo'd
  // producer learns about it via log.error instead of writing lossy records.
  for (const key of Object.keys(value)) {
    if (!COMPACTION_EVENT_KEYS.has(key)) return false;
  }
  if (value.path !== undefined && value.path !== "native" && value.path !== "scratch")
    return false;
  if (value.outcome !== undefined && asNonEmptyString(value.outcome) === undefined)
    return false;
  if (value.source !== undefined && asNonEmptyString(value.source) === undefined)
    return false;
  if (value.tokens_before !== undefined && asFiniteNumber(value.tokens_before) === undefined)
    return false;
  if (value.tokens_after !== undefined && asFiniteNumber(value.tokens_after) === undefined)
    return false;
  if (value.ratio !== undefined && asFiniteNumber(value.ratio) === undefined) return false;
  if (value.duration_ms !== undefined && asFiniteNumber(value.duration_ms) === undefined)
    return false;
  if (
    value.summarizer_model !== undefined &&
    asNonEmptyString(value.summarizer_model) === undefined
  )
    return false;
  return true;
}

function isToolErrorEvent(value: unknown): value is ToolErrorEvent {
  if (!isPlainObject(value)) return false;
  if (!asNonEmptyString(value.tool_name)) return false;
  return typeof value.error === "string";
}

function isAliasHitEvent(value: unknown): value is AliasHitEvent {
  if (!isPlainObject(value)) return false;
  if (!asNonEmptyString(value.alias)) return false;
  if (!asNonEmptyString(value.canonical)) return false;
  return value.kind === "redirect" || value.kind === "delegate";
}

function isSystemDiffEvent(value: unknown): value is SystemDiffEvent {
  if (!isPlainObject(value)) return false;
  if (!asNonEmptyString(value.frozen_sha256)) return false;
  if (!asNonEmptyString(value.incoming_sha256)) return false;
  return !!asNonEmptyString(value.session_id);
}

function isSchemaViolationEvent(value: unknown): value is SchemaViolationEvent {
  if (!isPlainObject(value)) return false;
  // Unknown keys are rejected outright (not silently dropped) so a typo'd
  // producer learns about it via log.error instead of writing lossy records —
  // same discipline as the fallback/compaction event schemas above.
  for (const key of Object.keys(value)) {
    if (!SCHEMA_VIOLATION_EVENT_KEYS.has(key)) return false;
  }
  if (!asNonEmptyString(value.tool_name)) return false;
  if (!asNonEmptyString(value.code)) return false;
  if (!asNonEmptyString(value.severity)) return false;
  if (typeof value.message !== "string") return false;
  if (value.path !== undefined && asNonEmptyString(value.path) === undefined) return false;
  return true;
}

export function recordFallback(
  logger: TelemetryLogger,
  ctx: EventContext,
  event: FallbackEvent,
): void {
  if (!isFallbackEvent(event)) {
    log.error("telemetry: recordFallback rejected invalid event payload", event);
    return;
  }
  const payload = validateEventContext(ctx, "recordFallback");
  if (!payload) return;
  payload.event = {
    chain_index: event.chain_index,
    from_model: event.from_model,
    to_model: event.to_model,
    error_name: event.error_name,
    error_class: event.error_class,
    cooldown_until: event.cooldown_until,
    reason: event.reason,
  };
  logger.record("fallback", payload);
}

export function recordCompaction(
  logger: TelemetryLogger,
  ctx: EventContext,
  event: CompactionEvent,
): void {
  if (!isCompactionEvent(event)) {
    log.error("telemetry: recordCompaction rejected invalid event payload", event);
    return;
  }
  const payload = validateEventContext(ctx, "recordCompaction");
  if (!payload) return;
  const out: Record<string, string | number | boolean | null> = {};
  if (event.path !== undefined) out.path = event.path;
  if (event.outcome !== undefined) out.outcome = event.outcome;
  if (event.source !== undefined) out.source = event.source;
  if (event.tokens_before !== undefined) out.tokens_before = event.tokens_before;
  if (event.tokens_after !== undefined) out.tokens_after = event.tokens_after;
  if (event.ratio !== undefined) out.ratio = event.ratio;
  if (event.duration_ms !== undefined) out.duration_ms = event.duration_ms;
  if (event.summarizer_model !== undefined)
    out.summarizer_model = event.summarizer_model;
  payload.event = out;
  logger.record("compaction", payload);
}

export function recordToolError(
  logger: TelemetryLogger,
  ctx: EventContext,
  event: ToolErrorEvent,
): void {
  if (!isToolErrorEvent(event)) {
    log.error("telemetry: recordToolError rejected invalid event payload", event);
    return;
  }
  const payload = validateEventContext(ctx, "recordToolError");
  if (!payload) return;
  payload.event = {
    tool_name: event.tool_name,
    error: event.error.slice(0, TOOL_ERROR_MAX_CHARS),
  };
  logger.record("tool_error", payload);
}

export function recordAliasHit(
  logger: TelemetryLogger,
  ctx: EventContext,
  event: AliasHitEvent,
): void {
  if (!isAliasHitEvent(event)) {
    log.error("telemetry: recordAliasHit rejected invalid event payload", event);
    return;
  }
  const payload = validateEventContext(ctx, "recordAliasHit");
  if (!payload) return;
  payload.event = {
    alias: event.alias,
    canonical: event.canonical,
    kind: event.kind,
  };
  logger.record("alias_hit", payload);
}

export function recordSystemDiff(
  logger: TelemetryLogger,
  ctx: EventContext,
  event: SystemDiffEvent,
): void {
  if (!isSystemDiffEvent(event)) {
    log.error("telemetry: recordSystemDiff rejected invalid event payload", event);
    return;
  }
  const payload = validateEventContext(ctx, "recordSystemDiff");
  if (!payload) return;
  payload.event = {
    frozen_sha256: event.frozen_sha256,
    incoming_sha256: event.incoming_sha256,
    session_id: event.session_id,
  };
  logger.record("system_diff", payload);
}

/**
 * kind "schema_violation" (plan T15): one record per tool-schema hygiene
 * finding from the tool.definition hook. The hook input carries no session
 * context, so the caller attributes the record with the tool id as
 * ctx.session_id (documented at the call site). Invalid payloads are reported
 * via log.error and NOT written — same discipline as the other T3 sinks.
 */
export function recordSchemaViolation(
  logger: TelemetryLogger,
  ctx: EventContext,
  event: SchemaViolationEvent,
): void {
  if (!isSchemaViolationEvent(event)) {
    log.error("telemetry: recordSchemaViolation rejected invalid event payload", event);
    return;
  }
  const payload = validateEventContext(ctx, "recordSchemaViolation");
  if (!payload) return;
  const out: Record<string, string | number | boolean | null> = {
    tool_name: event.tool_name,
    code: event.code,
    severity: event.severity,
    message: event.message,
  };
  if (event.path !== undefined) out.path = event.path;
  payload.event = out;
  logger.record("schema_violation", payload);
}

// Defensive extraction of an SDK ToolPart-like object
// ({type: "tool", tool, sessionID, messageID, state: {status, error?}}) for
// the live tool_error capture point. Returns undefined for anything else —
// non-tool parts, non-error states, malformed shapes — so callers skip
// without throwing.
export interface ToolErrorCapture {
  ctx: EventContext;
  event: ToolErrorEvent;
}

export function toolErrorCaptureFromPart(
  part: unknown,
): ToolErrorCapture | undefined {
  if (!isPlainObject(part) || part.type !== "tool") return undefined;
  const tool_name = asNonEmptyString(part.tool);
  if (!tool_name) return undefined;
  const state = isPlainObject(part.state) ? part.state : undefined;
  if (state?.status !== "error") return undefined;
  if (typeof state.error !== "string") return undefined;
  const session_id = asNonEmptyString(part.sessionID);
  if (!session_id) return undefined;
  const ctx: EventContext = { session_id };
  const message_id = asNonEmptyString(part.messageID);
  if (message_id) ctx.message_id = message_id;
  return {
    ctx,
    event: { tool_name, error: state.error.slice(0, TOOL_ERROR_MAX_CHARS) },
  };
}

// message.part.updated can re-emit the same errored tool part (message saves,
// compaction re-emissions). Exactly one tool_error record per part id; bounded
// so a long-lived session cannot grow the set forever (same pattern as the
// usage capture above).
const RECORDED_TOOL_PART_LIMIT = 4096;
const recordedToolPartIds = new Set<string>();

// Capture path wired into the message.part.updated hook: one "tool_error"
// record per errored tool part. Returns the recorded event (if any) so tests
// can assert on it without re-parsing the JSONL.
export function captureToolError(
  logger: TelemetryLogger,
  part: unknown,
): ToolErrorEvent | undefined {
  if (!isPlainObject(part)) return undefined;
  const capture = toolErrorCaptureFromPart(part);
  if (!capture) return undefined;
  const partId = asNonEmptyString(part.id);
  if (partId) {
    if (recordedToolPartIds.has(partId)) return undefined;
    recordedToolPartIds.add(partId);
    if (recordedToolPartIds.size > RECORDED_TOOL_PART_LIMIT) {
      recordedToolPartIds.clear();
    }
  }
  recordToolError(logger, capture.ctx, capture.event);
  return capture.event;
}

/** Finished + no error: the observable "clean generation" signal (see captureAssistantUsage). */
export function isCleanAssistantCompletion(info: unknown): boolean {
  if (!isPlainObject(info)) return false;
  const time = isPlainObject(info.time) ? info.time : {};
  return (
    asFiniteNumber(time.completed) !== undefined && info.error == null
  );
}

// Capture path wired into the message.updated hook: one "usage" record per
// finished assistant message, plus a "cache_alarm" record when a large prompt
// shows a degraded cache hit ratio. Returns the recorded payload (if any) so
// the caller can feed the budget aggregates (plan T2) without re-parsing.
export function captureAssistantUsage(
  logger: TelemetryLogger,
  info: unknown,
): TelemetryPayload | undefined {
  if (!isPlainObject(info)) return undefined;
  const time = isPlainObject(info.time) ? info.time : {};
  // Only finished messages carry final usage: completion time set, or the
  // message already carries an error (failed attempts keep partial usage).
  const finished =
    asFiniteNumber(time.completed) !== undefined || info.error != null;
  if (!finished) return;

  const messageID = asNonEmptyString(info.id);
  if (messageID) {
    if (recordedMessageIds.has(messageID)) return undefined;
    recordedMessageIds.add(messageID);
    if (recordedMessageIds.size > RECORDED_MESSAGE_LIMIT) {
      recordedMessageIds.clear();
    }
  }

  const payload = assistantUsagePayload(info);
  if (!payload) return undefined;
  logger.record("usage", payload);

  const tokens = payload.tokens;
  const ratio = payload.cache_ratio;
  if (!tokens || ratio === undefined) return payload;
  const total = tokens.input + tokens.cache_read + tokens.cache_write;
  if (ratio < CACHE_ALARM_RATIO && total > CACHE_ALARM_MIN_TOKENS) {
    logger.record("cache_alarm", {
      session_id: payload.session_id,
      message_id: payload.message_id,
      model: payload.model,
      tokens,
      cache_ratio: ratio,
      event: { cache_ratio: ratio, total_tokens: total },
    });
  }
  return payload;
}