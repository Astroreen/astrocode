// Compaction summarizer (plan T9.3).
//
// PRIMARY — opencode's native summarize route. SDK-verified signature
// (node_modules/@opencode-ai/sdk, SessionSummarizeData): options-object style,
// NOT positional —
//
//   client.session.summarize({ path: { id }, body: { providerID, modelID } })
//
// returning `{data: boolean}`. (Deviation from the plan's pseudo-signature
// `summarize(sessionID, {providerID, modelID})` is purely call-shape; the
// route and body are exactly as planned.) Before calling, the configured
// `summarizer_model` is probed against the provider list; an unknown or
// unavailable model falls through to FALLBACK (logged). The route returns a
// boolean — the summary text is produced asynchronously by opencode's own
// compaction flow and injected by the host, so a successful native attempt
// reports `text: ""` (host-managed; T10/T11 only inject scratch summaries).
//
// FALLBACK — scratch-session summarization: read the session transcript via
// `client.session.messages`, create a scratch session
// (`client.session.create`), prompt a cheap constant model with a fixed
// summary template (`client.session.prompt`), extract the reply text, delete
// the scratch session (best-effort).
//
// Telemetry: `recordCompaction` on EVERY attempt. Outcome values (stable,
// documented here; the helper accepts any non-empty string but producers must
// stick to this set):
//   "ok"      — the attempt produced a valid summary
//   "error"   — the attempt failed (transport) or the reply violated the
//               summary format (T11 validation)
//   "skipped" — the attempt was not made (probe failed / no model configured)
//   "fallback"— the deterministic stub became the summary (T11: the scratch
//               flow exhausted its attempt budget without valid text)
//
// Failure discipline (plan T11 doctrine, hard guarantee): at most 2
// summarizer MODEL calls per compaction. The scratch flow is the only path
// whose text this engine produces and validates, so it owns the retry budget:
//   - no native call was made (not configured / malformed / probe failed)
//       -> scratch gets 2 attempts: the plain template, then exactly ONE
//          retry with RETRY_FORMAT_ADDENDUM appended (MAX_SUMMARY_RETRIES = 1,
//          a doctrine constant, not config);
//   - a native call was made -> it already consumed one call of the budget,
//       so the scratch flow gets the remaining 1 attempt (no format retry).
// A reply that is invalid or empty/silent consumes the attempt; when the
// budget is exhausted the deterministic FALLBACK_SUMMARY_STUB becomes the
// summary (outcome "fallback") so the doctrine "a summary block exists" holds
// and T10's prune/injection proceeds. NO further attempts ever.
// Transport-level failures (the prompt call throws) are NOT format violations
// — the addendum cannot fix a dead route — so they do not consume the retry:
// they record "error" and fall through to the typed-error path (T9 behavior).
// If both paths fail without producing any text, a typed
// CompactionSummarizeError is thrown AFTER the records are written.
//
// Purity (cache-epoch rule): summarize() NEVER mutates session history — it
// produces a summary string + state only. Injection/pruning is T10's job.

import { parseModelString } from "../models/model-id";
import { log } from "../log";
import { stripForceMarkerText } from "./force";
import { markScratchSession } from "./state";
import { validateSummary } from "./format";
import {
  recordCompaction,
  type EventContext,
  type TelemetryLogger,
} from "../telemetry/log";

/**
 * The configured primary summarizer path (plan: one constant, not a runtime
 * switcher — changed by editing code when the probe picture clarifies).
 */
export const SUMMARIZER_PATH = "native" as const;

/** Cheap constant model for the scratch fallback path. */
export const SCRATCH_SUMMARIZER_MODEL = "openrouter/xiaomi/mimo-v2.6-pro";

/** Transcript digest bounds for the scratch prompt. */
export const SCRATCH_MAX_MESSAGES = 30;
export const SCRATCH_MAX_MESSAGE_CHARS = 400;

/**
 * Fixed summary template requested from the summarizer. T11 validates the
 * reply against the same three sections; keeping the template here means T9
 * already produces T11-shaped summaries.
 */
export const SUMMARY_PROMPT_TEMPLATE =
  "Summarize the session transcript below for a coding agent that will " +
  "continue the work with the earlier details pruned. Output EXACTLY three " +
  "markdown sections, 200-4000 characters total, no other text:\n" +
  "## Goal\n" +
  "## State\n" +
  "## Next\n" +
  "\nTranscript:\n";

// ---------------------------------------------------------------------------
// T11 retry/fallback doctrine constants (NOT config — changed by editing code).
// ---------------------------------------------------------------------------

/**
 * Exactly ONE format retry per scratch summarizer flow (plan T11.2). The
 * scratch attempt budget is therefore MAX_SUMMARY_RETRIES + 1 prompts, further
 * capped by the hard per-compaction model-call budget of 2 (see module doc).
 */
export const MAX_SUMMARY_RETRIES = 1;

/**
 * Corrective addendum appended to the retry prompt (plan T11.2 constant).
 */
export const RETRY_FORMAT_ADDENDUM =
  "The previous response violated the required format. Output exactly the " +
  "three markdown sections ## Goal / ## State / ## Next, 200-4000 chars.";

/**
 * Deterministic fallback summary (plan T11.2): when the attempt budget is
 * exhausted without a valid reply, THIS text becomes the summary so the
 * doctrine "a summary block exists" holds and T10's prune/injection proceeds.
 * Deliberately below SUMMARY_MIN_CHARS — it is the post-validation terminal
 * answer, never re-validated (validating it would demand a longer stub and
 * the doctrine fixes these exact bytes).
 */
export const FALLBACK_SUMMARY_STUB =
  "## Goal\n(compacted without summary)\n## State\nsee pruned tool outputs\n## Next\ncontinue from user request";

// ---------------------------------------------------------------------------
// Minimal structural view of the SDK client (AliasDelegateClient pattern from
// src/aliases/index.ts): the real PluginInput["client"] satisfies this
// structurally (verified at compile time), tests implement it without casts.
// ---------------------------------------------------------------------------

/** RequestResult-shaped outcome: data on success, error on failure. */
export interface SummarizeCallResult {
  data?: boolean;
  error?: unknown;
}
export interface SessionCreateResult {
  data?: { id?: string };
  error?: unknown;
}
export interface PromptResult {
  data?: { info?: unknown; parts?: unknown[] };
  error?: unknown;
}
export interface MessageEntry {
  info?: unknown;
  parts?: unknown[];
}
export interface MessagesResult {
  data?: MessageEntry[];
  error?: unknown;
}
export interface ProviderEntry {
  id?: string;
  models?: Record<string, unknown>;
}
export interface ProviderListResult {
  data?: { all?: ProviderEntry[] };
  error?: unknown;
}

export interface SummarizerClient {
  session: {
    summarize(options: {
      path: { id: string };
      body?: { providerID: string; modelID: string };
    }): Promise<SummarizeCallResult>;
    create(options?: {
      body?: { parentID?: string; title?: string };
    }): Promise<SessionCreateResult>;
    prompt(options: {
      path: { id: string };
      body: {
        parts: { type: "text"; text: string; synthetic?: boolean }[];
        model?: { providerID: string; modelID: string };
      };
    }): Promise<PromptResult>;
    messages(options: {
      path: { id: string };
      query?: { limit?: number };
    }): Promise<MessagesResult>;
    delete(options: { path: { id: string } }): Promise<unknown>;
  };
  provider: {
    list(options?: { query?: { directory?: string } }): Promise<ProviderListResult>;
  };
}

// ---------------------------------------------------------------------------
// Typed error (the seam: summarize() returns {text, path} or throws this
// AFTER recording).
// ---------------------------------------------------------------------------

export class CompactionSummarizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionSummarizeError";
  }
}

// ---------------------------------------------------------------------------
// Inputs/outputs
// ---------------------------------------------------------------------------

export interface SummarizeArgs {
  sessionID: string;
  /** Configured summarizer model "provider/model"; undefined -> scratch only. */
  summarizer_model?: string;
  /** Telemetry record context (session/message/agent/model attribution). */
  ctx: EventContext;
  /** Why compaction started: "turn_boundary" | "session_idle" | "manual". */
  source: string;
  /** Billable tokens at trigger time (for the record). */
  tokens_before?: number;
  /** Context fill ratio at trigger time (for the record). */
  ratio?: number;
}

export interface SummarizeOutcome {
  /** Summary text; "" for the native path (host-managed, see header). */
  text: string;
  path: "native" | "scratch";
}

// ---------------------------------------------------------------------------
// Helpers (defensive, no casts)
// ---------------------------------------------------------------------------

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Probe: does "provider/model" resolve in the provider list? */
export async function probeModel(
  client: SummarizerClient,
  providerID: string,
  modelID: string,
): Promise<boolean> {
  try {
    const result = await client.provider.list();
    if (result.error || !result.data) return false;
    const all = result.data.all;
    if (!Array.isArray(all)) return false;
    for (const provider of all) {
      if (!isPlainObject(provider)) continue;
      if (asNonEmptyString(provider.id) !== providerID) continue;
      const models = isPlainObject(provider.models) ? provider.models : {};
      return isPlainObject(models[modelID]);
    }
    return false;
  } catch (err) {
    log.warn("compaction: provider list probe failed", err);
    return false;
  }
}

/** Extract the joined text of an SDK part array (defensive). */
function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    if (part.type !== "text") continue;
    const text = asNonEmptyString(part.text);
    if (text) {
      // The force-compact marker (plan T12.2) must not reach ANY model — the
      // scratch summarizer is a model too, and the transcript digest is built
      // from stored text parts. Replace with the neutral text (no-op when the
      // marker is absent).
      chunks.push(stripForceMarkerText(text));
    }
  }
  return chunks.join("\n").trim();
}

/** Build the transcript digest for the scratch prompt (last N messages). */
export function transcriptDigest(entries: unknown): string {
  if (!Array.isArray(entries)) return "";
  const lines: string[] = [];
  for (const entry of entries.slice(-SCRATCH_MAX_MESSAGES)) {
    if (!isPlainObject(entry)) continue;
    const info = isPlainObject(entry.info) ? entry.info : {};
    const role = asNonEmptyString(info.role) ?? "unknown";
    const text = textFromParts(entry.parts);
    if (!text) continue;
    const clipped =
      text.length > SCRATCH_MAX_MESSAGE_CHARS
        ? `${text.slice(0, SCRATCH_MAX_MESSAGE_CHARS)}…`
        : text;
    lines.push(`${role}: ${clipped}`);
  }
  return lines.join("\n");
}

/** One recordCompaction emission with the shared fields filled in. */
function record(
  logger: TelemetryLogger,
  args: SummarizeArgs,
  startedAt: number,
  event: {
    path: "native" | "scratch";
    outcome: string;
  },
): void {
  // Native attempts always carry the configured model (the path only runs
  // when one is set); the scratch path carries the constant. An empty value
  // is omitted entirely — the helper rejects empty strings.
  const summarizer =
    event.path === "native" ? args.summarizer_model : SCRATCH_SUMMARIZER_MODEL;
  recordCompaction(logger, args.ctx, {
    path: event.path,
    outcome: event.outcome,
    source: args.source,
    ...(args.tokens_before !== undefined ? { tokens_before: args.tokens_before } : {}),
    ...(args.ratio !== undefined ? { ratio: args.ratio } : {}),
    duration_ms: Date.now() - startedAt,
    ...(summarizer ? { summarizer_model: summarizer } : {}),
  });
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** PRIMARY: native summarize route, one attempt. */
async function nativeSummarize(
  client: SummarizerClient,
  logger: TelemetryLogger,
  args: SummarizeArgs,
  startedAt: number,
  providerID: string,
  modelID: string,
): Promise<SummarizeOutcome | undefined> {
  try {
    const result = await client.session.summarize({
      path: { id: args.sessionID },
      body: { providerID, modelID },
    });
    const ok = result.error === undefined && result.data === true;
    record(logger, args, startedAt, {
      path: "native",
      outcome: ok ? "ok" : "error",
    });
    if (!ok) {
      log.warn(
        `compaction: native summarize did not confirm ` +
          `(model ${providerID}/${modelID}); falling back to scratch`,
      );
      return undefined;
    }
    return { text: "", path: "native" };
  } catch (err) {
    record(logger, args, startedAt, { path: "native", outcome: "error" });
    log.warn("compaction: native summarize threw; falling back to scratch", err);
    return undefined;
  }
}

/**
 * FALLBACK: scratch-session summarization with the T11 bounded retry.
 *
 * Up to `maxAttempts` prompt calls (1 = no retry budget left, 2 = initial +
 * the single format retry). Each reply is validated against the summary
 * format; a valid reply wins immediately. An invalid or empty/silent reply
 * consumes the attempt. When the budget is exhausted the deterministic
 * FALLBACK_SUMMARY_STUB becomes the summary with outcome "fallback".
 * A thrown prompt call is a transport failure, not a format violation: it
 * records "error" and returns undefined (no retry, T9 typed-error path).
 */
async function scratchSummarize(
  client: SummarizerClient,
  logger: TelemetryLogger,
  args: SummarizeArgs,
  startedAt: number,
  maxAttempts: number,
): Promise<SummarizeOutcome | undefined> {
  const parsed = parseModelString(SCRATCH_SUMMARIZER_MODEL);
  if (!parsed) {
    // Unreachable: SCRATCH_SUMMARIZER_MODEL is a valid constant; guarded so
    // a future edit to the constant cannot break the flow silently.
    record(logger, args, startedAt, { path: "scratch", outcome: "error" });
    log.error("compaction: SCRATCH_SUMMARIZER_MODEL is not a provider/model id");
    return undefined;
  }
  let scratchID: string | undefined;
  try {
    const history = await client.session.messages({
      path: { id: args.sessionID },
    });
    const digest = transcriptDigest(history.data);
    if (!digest) {
      record(logger, args, startedAt, { path: "scratch", outcome: "error" });
      log.warn("compaction: scratch path found no transcript to summarize");
      return undefined;
    }

    const created = await client.session.create({
      body: { title: "astrocode scratch summarizer" },
    });
    scratchID = asNonEmptyString(created.data?.id);
    if (!scratchID) {
      record(logger, args, startedAt, { path: "scratch", outcome: "error" });
      log.warn("compaction: scratch session create returned no id");
      return undefined;
    }
    // The scratch session is engine infrastructure: register it so the
    // trigger seams never compact the compactor (its own system prompt +
    // tool schema bill ~12k tokens, which trips small context windows).
    markScratchSession(scratchID);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Attempt 1 uses the plain template; a retry appends the corrective
      // addendum AFTER the transcript — the last thing the model reads is
      // the format correction.
      const promptText =
        attempt === 1
          ? `${SUMMARY_PROMPT_TEMPLATE}${digest}`
          : `${SUMMARY_PROMPT_TEMPLATE}${digest}\n\n${RETRY_FORMAT_ADDENDUM}`;
      try {
        const prompted = await client.session.prompt({
          path: { id: scratchID },
          body: {
            parts: [{ type: "text", text: promptText }],
            model: { providerID: parsed.providerID, modelID: parsed.modelID },
          },
        });
        const text = textFromParts(prompted.data?.parts);
        if (text) {
          const validation = validateSummary(text);
          if (validation.valid) {
            record(logger, args, startedAt, { path: "scratch", outcome: "ok" });
            return { text, path: "scratch" };
          }
          record(logger, args, startedAt, { path: "scratch", outcome: "error" });
          log.warn(
            `compaction: scratch summary rejected (${validation.reason}); ` +
              `attempt ${attempt}/${maxAttempts}`,
          );
          continue;
        }
        record(logger, args, startedAt, { path: "scratch", outcome: "error" });
        log.warn(
          `compaction: scratch summarizer returned no text; ` +
            `attempt ${attempt}/${maxAttempts}`,
        );
      } catch (err) {
        record(logger, args, startedAt, { path: "scratch", outcome: "error" });
        log.warn("compaction: scratch summarization failed", err);
        return undefined;
      }
    }

    // Attempt budget exhausted without a valid reply -> deterministic
    // fallback (plan T11.2). NO further attempts ever.
    record(logger, args, startedAt, { path: "scratch", outcome: "fallback" });
    log.warn(
      `compaction: no valid summary after ${maxAttempts} attempt(s); ` +
        `using the deterministic fallback stub`,
    );
    return { text: FALLBACK_SUMMARY_STUB, path: "scratch" };
  } catch (err) {
    record(logger, args, startedAt, { path: "scratch", outcome: "error" });
    log.warn("compaction: scratch summarization failed", err);
    return undefined;
  } finally {
    if (scratchID) {
      try {
        await client.session.delete({ path: { id: scratchID } });
      } catch (err) {
        log.warn("compaction: scratch session cleanup failed", err);
      }
    }
  }
}

/**
 * Run the summarizer for one compaction: PRIMARY (native, probe-gated) then
 * FALLBACK (scratch with the T11 bounded retry + deterministic stub).
 * Records telemetry on every attempt; throws CompactionSummarizeError only
 * when no path produced any summary text (all attempts failed at the
 * transport level) AND every failure was recorded.
 */
export async function summarize(
  client: SummarizerClient,
  logger: TelemetryLogger,
  args: SummarizeArgs,
): Promise<SummarizeOutcome> {
  const startedAt = Date.now();
  // Whether the native route actually consumed one call of the hard
  // per-compaction model-call budget (2). Probe/skip paths do not count.
  let nativeAttempted = false;

  // PRIMARY — only with a configured model that the probe resolves.
  if (args.summarizer_model) {
    const parsed = parseModelString(args.summarizer_model);
    if (!parsed) {
      record(logger, args, startedAt, { path: "native", outcome: "skipped" });
      log.warn(
        `compaction: summarizer_model "${args.summarizer_model}" is not a ` +
          `provider/model id; falling back to scratch`,
      );
    } else {
      const probed = await probeModel(client, parsed.providerID, parsed.modelID);
      if (!probed) {
        record(logger, args, startedAt, { path: "native", outcome: "skipped" });
        log.warn(
          `compaction: summarizer model ${parsed.providerID}/${parsed.modelID} ` +
            `did not resolve in the provider list; falling back to scratch`,
        );
      } else {
        nativeAttempted = true;
        const native = await nativeSummarize(
          client,
          logger,
          args,
          startedAt,
          parsed.providerID,
          parsed.modelID,
        );
        if (native) return native;
      }
    }
  }

  // FALLBACK — scratch session on the constant cheap model, with the T11
  // bounded retry. Hard call budget (doctrine): at most 2 summarizer model
  // calls per compaction; a native attempt already consumed one, so the
  // scratch flow gets the remainder (2 attempts when no native call was
  // made, 1 when it was).
  const maxAttempts = nativeAttempted ? 1 : MAX_SUMMARY_RETRIES + 1;
  const scratch = await scratchSummarize(
    client,
    logger,
    args,
    startedAt,
    maxAttempts,
  );
  if (scratch) return scratch;

  throw new CompactionSummarizeError(
    `compaction: both summarizer paths failed for session ${args.sessionID}`,
  );
}
