// Compaction trigger (plan T9.2).
//
// Pure rule evaluation — NO side effects, no model-visible tool, no history
// mutation. The engine is rule-triggered (Planner Decisions #6): the ratio of
// the last assistant message's billable context
// (input + cache_read + cache_write) against the model's context window is
// checked at the turn boundary (finished assistant message — the same seam as
// the T1 usage capture) and on the `session.idle` event.
//
// Gates, in order: enabled -> usage known -> not in_flight -> cooldown elapsed
// -> ratio >= trigger_ratio. Every gate has a stable reason string so tests
// and logs can assert exactly why a turn did or did not compact.

import {
  COMPACTION_CONTEXT_WINDOW_DEFAULT,
  type CompactionConfig,
} from "../config/astrocode";

/** Billable-context snapshot of the last finished assistant message. */
export interface CompactionUsage {
  /** Full "provider/model" id of the message (window-map lookup key). */
  model?: string;
  input: number;
  cache_read: number;
  cache_write: number;
}

/** The config fields the trigger needs (CompactionConfig satisfies this). */
export interface CompactionTriggerConfig {
  enabled: boolean;
  trigger_ratio: number;
  context_window: number;
  context_windows?: Record<string, number>;
  cooldown_seconds: number;
}

export type CompactionTriggerReason =
  | "disabled"
  | "no-usage"
  | "in-flight"
  | "cooldown"
  | "below-threshold"
  | "triggered"
  | "forced";

export interface CompactionDecision {
  compact: boolean;
  reason: CompactionTriggerReason;
  /** Billable/window ratio at check time (when usage was evaluable). */
  ratio?: number;
  /** Effective context window used for the ratio. */
  window?: number;
}

function asPositiveWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Effective context window for a model: `context_windows[model]` (full
 * "provider/model" id) wins, then the bare model id (the part after the first
 * "/") as the map key, then the global `context_window`. Defensive: a garbage
 * configured value falls through to the next layer, and a garbage global
 * falls back to the documented default — the divisor is never <= 0.
 */
export function contextWindowForModel(
  cfg: Pick<CompactionTriggerConfig, "context_window" | "context_windows">,
  model: string | undefined,
): number {
  if (model) {
    const windows = cfg.context_windows ?? {};
    const direct = asPositiveWindow(windows[model]);
    if (direct !== undefined) return direct;
    const slash = model.indexOf("/");
    const bare = slash >= 0 ? model.slice(slash + 1) : model;
    if (bare !== model) {
      const byBare = asPositiveWindow(windows[bare]);
      if (byBare !== undefined) return byBare;
    }
  }
  const global = asPositiveWindow(cfg.context_window);
  return global ?? COMPACTION_CONTEXT_WINDOW_DEFAULT;
}

/**
 * Pure query: should this session compact now? Never throws, never mutates
 * (in_flight is NOT set here — the runner sets it synchronously right before
 * dispatching, so two event seams racing on the same turn cannot both run).
 *
 * Ratio = (input + cache_read + cache_write) / context_window_for_model.
 *
 * `force` (plan T12.2): the /astrocode:compact command semantics — bypasses
 * the no-usage, cooldown and ratio gates (the user explicitly asked for a
 * compaction NOW). The enabled and in_flight gates still apply: a disabled
 * engine never runs, and in_flight remains the double-run guard so a forced
 * request racing an active compaction cannot start a second one.
 */
export function shouldCompact(
  state: { last_compaction_ts?: number; in_flight: boolean } | undefined,
  cfg: CompactionTriggerConfig,
  usage: CompactionUsage | undefined,
  now: number,
  force = false,
): CompactionDecision {
  if (!cfg.enabled) return { compact: false, reason: "disabled" };
  if (state?.in_flight) return { compact: false, reason: "in-flight" };
  if (force) return { compact: true, reason: "forced" };
  if (
    !usage ||
    !Number.isFinite(usage.input) ||
    !Number.isFinite(usage.cache_read) ||
    !Number.isFinite(usage.cache_write)
  ) {
    return { compact: false, reason: "no-usage" };
  }
  if (state?.in_flight) return { compact: false, reason: "in-flight" };
  const cooldownMs = Math.max(0, cfg.cooldown_seconds) * 1000;
  if (
    cooldownMs > 0 &&
    state?.last_compaction_ts !== undefined &&
    now - state.last_compaction_ts < cooldownMs
  ) {
    return { compact: false, reason: "cooldown" };
  }

  const window = contextWindowForModel(cfg, usage.model);
  const billable = usage.input + usage.cache_read + usage.cache_write;
  const ratio = window > 0 ? billable / window : 0;
  if (ratio < cfg.trigger_ratio) {
    return { compact: false, reason: "below-threshold", ratio, window };
  }
  return { compact: true, reason: "triggered", ratio, window };
}
