// astrocode plugin entry point.
//
// Thin, model-aware layer: appends model-family guard text, the dynamic Sisyphus
// prompt and env/date context via `experimental.chat.system.transform`; tunes
// sampling via `chat.params`; injects personas/commands via `config`; performs
// real mid-task model fallback via `event`; bridges extra skill directories.
//
// Personas are owned by the plugin (read from the shipped `agents/*.md`), so a
// project only needs the plugin entry — no copying personas into
// `.opencode/agents/`. astrocode's own settings (per-agent model, fallback chain,
// colors, sampling, skills, idle continuation) live in a dedicated
// `astrocode.jsonc` file, not in opencode.jsonc.
//
// Defensive by design: every hook is wrapped so an unexpected/changed API shape
// logs a warning and no-ops instead of crashing the host session.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";
import { resolveFamily, type ModelFamily } from "./models/resolveFamily";
import {
  reasoningConfigForFamily,
  resolveSampling,
  splitReasoningSuffix,
  isReasoningLevel,
  createReasoningDecider,
} from "./models/tuning";
import { getGuards } from "./prompts/guards";
import { dumpPrompt } from "./prompts/dump";
import {
  SystemPromptFreeze,
  sha256Hex,
  systemFreezeKey,
  systemPromptKey,
} from "./prompts/freeze";
import {
  recordCompaction,
  recordSchemaViolation,
  recordSystemDiff,
} from "./telemetry/log";
import {
  repairToolSchema,
  validateToolSchema,
  type Violation,
} from "./validation/schema";
import {
  isSisyphusSession,
  buildDynamicSisyphusPrompt,
} from "./prompts/sisyphus/dispatch";
import { dispatchFallback, parseModelString } from "./fallback";
import { areModelsEquivalent } from "./fallback/canonicalize";
import { clearAllModelCooldowns } from "./fallback/cooldown";
import { clearAll as clearFallbackState, clearRetryKeys, markRetryKey } from "./fallback/state";
import {
  clearAllSessionModels,
  clearSessionModelState,
  getSessionModelState,
  isFallbackPinActive,
  touchSessionFallbackModel,
} from "./fallback/session-model";
import {
  clearChildSessions,
  registerChildSessionFromInfo,
  unregisterChildSession,
} from "./fallback/subagent";
import { buildBuiltinCommands } from "./commands";
import { buildAliasTools } from "./aliases";
import { loadAstrocodeConfig } from "./config/astrocode";
import {
  captureAssistantUsage,
  captureToolError,
  createTelemetryLogger,
  type TelemetryLogger,
} from "./telemetry/log";
import {
  configureBudget,
  enforceBudget,
  recordUsageSpend,
  resetBudgetState,
  setCurrentAgent,
} from "./telemetry/budget";
import { buildEnvContext, hasEnvContext } from "./env/context";
import {
  EXTRA_SKILL_PRIORITY,
  linkExtraSkillDirs,
  discoverSkillsWithPriority,
  skillCommandTemplate,
  thinSkillCommandTemplate,
  standardSkillSources,
} from "./skills/extra";
import {
  maybeContinueIdle,
  resetIdleContinuationState,
  recordAbort,
} from "./idle/continue";
import {
  maybeCompact,
  maybeCompactAtIdle,
  maybeCompactAtTurnBoundary,
  nativeCompactionCapture,
} from "./compaction/run";
import { applyCompactionTransform } from "./compaction/transform";
import {
  forceCompactRequest,
  stripForceMarkers,
} from "./compaction/force";
import { COMPACTING_PROMPT } from "./compaction/prompt";
import {
  lastUsage,
  resetCompactionState,
  setForceCompact,
} from "./compaction/state";
import {
  findAgentsMdFiles,
  buildAgentsMdContext,
  hasAgentsMdContext,
} from "./context/agentsmd";
import { getErrorMessage, getErrorName } from "./fallback/classify";
import {
  DEFAULT_AGENT,
  DEMOTED_NATIVE_AGENTS,
  loadPersonas,
  toAgentConfigs,
  type PersonaDefinition,
} from "./agents/personas";

import { log, configureLogger } from "./log";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = join(PLUGIN_ROOT, "agents");
const BUNDLED_SKILLS_DIR = join(PLUGIN_ROOT, "skills", "builtin");

interface AgentConfigLike {
  description?: string;
  mode?: "primary" | "subagent" | "all";
  temperature?: number;
  color?: string;
  model?: string;
  prompt?: string;
  tools?: Record<string, boolean>;
  permission?: Record<string, unknown>;
  [key: string]: unknown;
}

function personaToAgentConfig(
  persona: PersonaDefinition,
  model?: string,
  colorOverride?: string,
): AgentConfigLike {
  const config: AgentConfigLike = {
    description: persona.description,
    mode: persona.mode,
    prompt: persona.prompt,
  };
  if (persona.temperature !== undefined) config.temperature = persona.temperature;
  if (persona.color || colorOverride) config.color = colorOverride ?? persona.color;
  if (persona.tools) config.tools = persona.tools;
  if (persona.permission) config.permission = persona.permission;
  if (model) config.model = model;
  return config;
}

// Resolve a model string ("provider/model") to its family, tolerating garbage.
function familyForModel(model: string | undefined): ModelFamily | undefined {
  if (!model) return undefined;
  const parsed = parseModelString(model);
  if (!parsed) return undefined;
  return resolveFamily({ providerID: parsed.providerID, modelID: parsed.modelID });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

// One-line summary of validator findings for the log: counts per
// code[severity], e.g. 'root_combinator[error]x1 empty_description[warning]x2'.
function summarizeViolations(violations: Violation[]): string {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const key = `${violation.code}[${violation.severity}]`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key}x${count}`).join(" ");
}

// Is this command definition one that a prior astrocode load registered for
// this skill (thin stub or full-body wrap)? Used to self-heal when the same
// plugin loads twice (project path + HM-deployed plugins/ auto-discovery) so
// an older copy's thin stub cannot pin the name. User/builtin commands return
// false and are never overwritten.
function isOwnSkillCommand(
  definition: unknown,
  skillName: string,
): boolean {
  if (!definition || typeof definition !== "object") return false;
  const def = definition as { template?: unknown; description?: unknown };
  const template = typeof def.template === "string" ? def.template : "";
  const description = typeof def.description === "string" ? def.description : "";
  if (template === thinSkillCommandTemplate(skillName)) return true;
  if (description.startsWith("Skill:")) return true;
  if (template.startsWith("<skill-instruction>")) return true;
  return false;
}

const astrocodePlugin: Plugin = async (input, options) => {
  // Route info/warn/debug to opencode's server log (not the TUI) before any
  // hook runs. Errors keep going to stderr and stay visible in the TUI.
  configureLogger(input.client);

  // Plugin SDK client, captured before any hook parameter can shadow the
  // outer `input` (the chat.message hook needs it for the T12 manual
  // compaction trigger; its own hook input carries no client).
  const pluginClient = input.client;

  const projectDir = input?.directory;
  const searchDirs = [input?.directory, input?.worktree].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  const astrocodeConfig = loadAstrocodeConfig(searchDirs, options);
  const fallbackConfig = astrocodeConfig.fallback;

  // Telemetry JSONL sink (plan T1). Independent of fallback enablement:
  // every finished assistant message records usage. `enabled: false` yields
  // the shared no-op logger — zero I/O, not even directory creation.
  const telemetry: TelemetryLogger = createTelemetryLogger({
    enabled: astrocodeConfig.telemetry.enabled,
    dir: astrocodeConfig.telemetry.dir,
  });

  // Budget enforcement (plan T2). Opt-in (`budget.enabled`, default false —
  // blocking tool calls on spend is destructive). The in-memory aggregates
  // are fed unconditionally below so enabling sees spend since plugin load.
  configureBudget(astrocodeConfig.budget);

  // Deprecated tool-alias shims (plan T5). Registered once at bootstrap under
  // bare legacy names (Task_Create, TodoWrite, Agent, ...); the set is static
  // for the whole session so the tool-schema cache prefix stays stable.
  // `aliases.enabled: false` registers nothing. The plugin SDK client is kept
  // in scope as the T6 delegation seam (TaskStop/TaskOutput side effects).
  let aliasTools: Record<string, ToolDefinition> | undefined;
  if (astrocodeConfig.aliases.enabled) {
    aliasTools = buildAliasTools(input.client, telemetry);
    log.info(`aliases: registered ${Object.keys(aliasTools).length} deprecated tool aliases`);
  }

  // System-prompt freeze (plan T8). The first assembled system prompt for a
  // sessionID is remembered and every later transform for that session
  // returns exactly those bytes, so the provider prompt cache stays valid.
  // Capped LRU (200 sessions) so long-lived hosts cannot grow without bound.
  const systemFreeze = new SystemPromptFreeze();

  // Per-model reasoning overrides (plan T13). The decider owns the
  // suffix-beats-override precedence and warns at most once per uncovered
  // model id (and only while overrides are configured at all).
  const decideReasoning = createReasoningDecider(
    astrocodeConfig.reasoning_overrides,
    (message) => log.warn(message),
  );

  // Personas are read once at plugin init. They are registered under oh-my
  // display names (see AGENT_DISPLAY_NAMES) so the UI matches oh-my-openagent;
  // `build`/`plan` are demoted to hidden subagents and Sisyphus becomes the
  // default primary agent.
  const personas = loadPersonas(AGENTS_DIR);

  // Bridge extra skill directories (e.g. a legacy oh-my skill cache) into the
  // native opencode skills dir so they are discoverable again. Best-effort.
  if (astrocodeConfig.skills.extraDirs.length > 0) {
    try {
      const report = linkExtraSkillDirs(astrocodeConfig.skills.extraDirs);
      log.info(
        `skills: linked ${report.linked.length}` +
          (report.linked.length ? ` (${report.linked.join(", ")})` : "") +
          `, skipped ${report.skipped.length}`,
      );
    } catch (err) {
      log.error("skills: link step failed; no-op", err);
    }
  }

  return {
    dispose: async () => {
      telemetry.close();
      systemFreeze.clear();
      resetBudgetState();
      clearFallbackState();
      clearAllSessionModels();
      clearAllModelCooldowns();
      clearChildSessions();
      resetIdleContinuationState();
      resetCompactionState();
    },

    // Deprecated tool-alias shims (plan T5): soft-redirect tools under legacy
    // Claude-harness names. Plugin tools win name collisions in opencode's
    // registry, but none of these names collide with a builtin id.
    ...(aliasTools ? { tool: aliasTools } : {}),

    // Own the agent roster + builtin commands. Agents are keyed by their oh-my
    // display name, so the TAB switcher/`@` menu/session header read identically
    // to oh-my-openagent (e.g. "Sisyphus - ultraworker").
    config: async (cfg) => {
      try {
        const root = cfg as unknown as Record<string, unknown>;
        const agents =
          root.agent && typeof root.agent === "object"
            ? (root.agent as Record<string, AgentConfigLike>)
            : {};
        const defaultModel =
          typeof root.model === "string" ? (root.model as string) : undefined;

        const displayPersonas = toAgentConfigs(personas, (key, displayName) =>
          astrocodeConfig.agents[key] ?? astrocodeConfig.agents[displayName],
        );
        for (const [displayName, persona] of Object.entries(displayPersonas)) {
          const existing = agents[displayName] ?? {};
          // Model cascade (issue #2): explicit per-agent model wins; otherwise
          // the global model (astrocode `model` overrides the opencode root
          // model) is pinned UNLESS the user opts into opencode's parent-model
          // inheritance via subagents.inherit_parent_model (escape hatch ->
          // resolvedModel stays undefined -> no `model` key -> task.ts keeps
          // next.model ?? parent). `persona.model` is exactly the per-agent
          // settings.model resolved by the toAgentConfigs lookup above.
          const explicitModel = persona.model;
          const globalModel = astrocodeConfig.model ?? defaultModel;
          const resolvedModel =
            explicitModel ??
            (astrocodeConfig.subagents.inherit_parent_model
              ? undefined
              : globalModel);
          const agentConfig = {
            ...personaToAgentConfig(persona, resolvedModel, undefined),
            ...existing,
            description: persona.description,
            mode: persona.mode,
            prompt: persona.prompt,
          };

          // Family reasoning/thinking options (claude extended thinking, gpt
          // reasoningEffort). Only when we know the effective model.
          if (astrocodeConfig.reasoning.enabled) {
            const agentModel = resolvedModel;
            const { base, level } = splitReasoningSuffix(agentModel ?? "");
            const family = familyForModel(base);
            if (family) {
              Object.assign(
                agentConfig,
                reasoningConfigForFamily(
                  family,
                  level && isReasoningLevel(level) ? level : undefined,
                ),
              );
            }
          }

          agents[displayName] = agentConfig;
        }

        // Demote opencode's builtin primaries to hidden subagents (oh-my does
        // exactly this so `build`/`plan` no longer appear in the TAB switcher).
        for (const demoted of DEMOTED_NATIVE_AGENTS) {
          agents[demoted] = { ...(agents[demoted] ?? {}), mode: "subagent", hidden: true };
        }

        root.agent = agents;
        root.default_agent = DEFAULT_AGENT;

        const commands =
          root.command && typeof root.command === "object"
            ? (root.command as Record<string, unknown>)
            : {};
        for (const [name, definition] of Object.entries(buildBuiltinCommands())) {
          if (!commands[name]) commands[name] = definition;
        }

        // Surface discovered skills as slash commands. opencode registers skills
        // for the model's `skill` tool but NOT as commands, so `/caveman` etc.
        // otherwise appear "missing" in the UI. Each command embeds the full
        // SKILL.md body (oh-my parity): `<skill-instruction>` + trailing user
        // args in `<user-request>$ARGUMENTS</user-request>` — one user message,
        // skill prompt first, user request last.
        //
        // The same plugin can load twice in one bootstrap (project path in
        // .opencode/opencode.jsonc + HM-deployed ~/.config/opencode/plugins/
        // auto-discovery). Whichever loads first claims skill names; a naive
        // `continue` would let an older copy's thin stub win. Self-heal: a
        // definition that is recognizably OUR skill entry (thin stub or prior
        // full-body wrap) is replaced; user/builtin commands are never touched.
        const sources = standardSkillSources(searchDirs, BUNDLED_SKILLS_DIR);
        for (const dir of astrocodeConfig.skills.extraDirs) {
          sources.push({ dir, priority: EXTRA_SKILL_PRIORITY, label: "extra" });
        }
        const skills = discoverSkillsWithPriority(sources);
        let skillCommands = 0;
        for (const skill of skills) {
          const existing = commands[skill.name];
          if (existing && !isOwnSkillCommand(existing, skill.name)) continue;
          const summary = skill.description.replace(/\s+/g, " ").trim();
          commands[skill.name] = {
            description: truncate(
              summary ? `Skill: ${summary}` : `Skill: ${skill.name}`,
              160,
            ),
            template: skillCommandTemplate(skill),
          };
          skillCommands++;
        }

        root.command = commands;

        log.info(
          `config: injected ${Object.keys(displayPersonas).length} agents, ` +
            `${Object.keys(commands).length} commands (${skillCommands} from skills), ` +
            `default_agent="${DEFAULT_AGENT}", ` +
            `fallback=${fallbackConfig.enabled ? "on" : "off"}`,
        );
      } catch (err) {
        log.error("config hook threw; no-op", err);
      }
    },

    // Real mid-task model fallback (docs/porting-plan.md "Fallback module
    // design"). opencode surfaces a failed model call either as `session.error`,
    // as a `message.updated` on an assistant message carrying `.error`, as a
    // `retry` part in `message.part.updated`, or (for retryable same-model
    // retries) as `session.status` with type "retry".
    event: async ({ event }) => {
      try {
        // A finished turn is the moment we learn a pinned fallback actually
        // worked. Refresh the pin here so a long turn (fallback models are
        // slower than the primary) cannot let the window expire mid-turn and
        // snap the next prompt back onto the still rate-limited primary — which
        // would make the following failure walk the chain past the model that
        // was working. A pin only exists while fallback is enabled, and
        // `touchSessionFallbackModel` no-ops without one.
        if (event.type === "session.idle") {
          const target = event.properties?.sessionID;
          if (target) {
            touchSessionFallbackModel(target);
            // Compaction trigger on session.idle (plan T9.2): evaluated
            // against the last usage snapshot remembered at the turn
            // boundary. Runs before idle continuation so a compaction that
            // fires lands before the next prompt is sent.
            if (astrocodeConfig.compaction.enabled) {
              maybeCompactAtIdle(
                input.client,
                telemetry,
                astrocodeConfig.compaction,
                target,
              );
            }
            // Idle continuation is independent of fallback enablement.
            if (astrocodeConfig.idleContinuation.enabled) {
              const result = await maybeContinueIdle(input.client, target, {
                max: astrocodeConfig.idleContinuation.max,
              });
              log.info(`idle-continuation: ${result.reason}`);
            }
          }
          return;
        }

        // Native compaction telemetry (plan T12.3): opencode's own compaction
        // flow fires `session.compacted` when it finishes — an additional
        // signal that may fire without our engine ever running. One record
        // per event, documented field set only (source: "native_event").
        if (event.type === "session.compacted") {
          const capture = nativeCompactionCapture(event.properties);
          if (capture) {
            recordCompaction(telemetry, capture.ctx, capture.event);
            log.info(
              `compaction: native session.compacted event for ${capture.ctx.session_id}`,
            );
          }
        }

        // Abort detection is independent of fallback enablement: a user
        // cancellation must suppress idle continuation.
        if (event.type === "session.error") {
          const errName = getErrorName(event.properties?.error);
          if (errName === "MessageAbortedError" || errName === "AbortError") {
            if (event.properties?.sessionID) {
              recordAbort(event.properties.sessionID);
            }
          }
        }

        // Telemetry capture is independent of fallback enablement: every
        // finished assistant message records one usage record (plus a
        // cache_alarm when a large prompt shows a degraded cache ratio).
        if (event.type === "message.updated") {
          const info = event.properties?.info;
          if (info?.role === "assistant") {
            const payload = captureAssistantUsage(telemetry, info);
            // Feed the budget ledger (plan T2). The agent name is unknown on
            // the assistant message; budget.ts falls back to the agent last
            // seen on this session via the chat.message hook.
            if (payload) recordUsageSpend(payload.session_id, payload.cost_usd);
            // Compaction trigger (plan T9.2): evaluated at the turn boundary
            // — the same finished-assistant-message seam as the usage
            // capture. The usage snapshot is remembered here for the
            // session.idle seam (which has no usage of its own).
            if (
              astrocodeConfig.compaction.enabled &&
              payload?.tokens &&
              payload.model
            ) {
              maybeCompactAtTurnBoundary(
                input.client,
                telemetry,
                astrocodeConfig.compaction,
                payload.session_id,
                {
                  model: `${payload.model.provider_id}/${payload.model.model_id}`,
                  input: payload.tokens.input,
                  cache_read: payload.tokens.cache_read,
                  cache_write: payload.tokens.cache_write,
                },
              );
            }
          }
        }

        // Tool-error capture (plan T3) is independent of fallback enablement:
        // a tool part that ends in state "error" records one tool_error record
        // (deduped per part id, bounded like the usage capture above).
        if (event.type === "message.part.updated") {
          captureToolError(telemetry, event.properties?.part);
        }

        if (!fallbackConfig.enabled) return;

        // Track child (subagent) sessions. opencode's built-in `task` tool
        // creates them with `parentID`, and children need different fallback
        // treatment (see src/fallback/subagent.ts). Registered before the
        // dispatch branches so a child's very first error is already classified.
        if (event.type === "session.created") {
          if (registerChildSessionFromInfo(event.properties?.info)) {
            log.info(`subagent: tracking child session ${event.properties.info.id}`);
          }
          return;
        }
        if (event.type === "session.deleted") {
          unregisterChildSession(event.properties.info.id);
          return;
        }

        const logDecision = (hook: string, decision: {
          reason: string;
          model?: string;
          detail?: string;
        }) => {
          const text =
            `fallback(${hook}): ${decision.reason}` +
            (decision.model ? ` -> ${decision.model}` : "") +
            (decision.detail ? ` (${decision.detail})` : "");
          // A successful switch is worth surfacing. Routine no-ops — user
          // aborts (`not-retryable`/`Aborted`), `disabled`, `in-flight`, retry
          // dedup, `same-model-retry` — go to debug so a healthy session is
          // quiet; run with ASTROCODE_LOG_LEVEL=debug to see them.
          if (decision.reason === "retry") {
            log.info(text);
            // Deliberate user-facing signal: the primary model hit a limit and
            // the session moved to a fallback. Everything else stays in the log.
            log.toast({ variant: "info", title: "astrocode fallback", message: text });
          } else if (
            decision.detail === "child-aborted" ||
            decision.reason === "resubmit-failed"
          )
            log.warn(text);
          else log.debug(text);
        };

        if (event.type === "session.error") {
          const target = event.properties?.sessionID;
          if (!target) return;
          logDecision(
            "session.error",
            await dispatchFallback(
              input.client,
              fallbackConfig,
              target,
              event.properties?.error,
              undefined,
              telemetry,
            ),
          );
          return;
        }

        if (event.type === "message.updated") {
          const info = event.properties?.info;
          if (info?.role !== "assistant") return;
          if (!info.error) return;
          // The assistant message carries the model that actually ran — i.e. the
          // model that just failed. That is authoritative even when the client's
          // last user message still names a different (stale) model, which is
          // exactly the snap-back case decideFallback needs to detect.
          const failedModel =
            info.providerID && info.modelID
              ? `${info.providerID}/${info.modelID}`
              : undefined;
          logDecision(
            "message.updated",
            await dispatchFallback(
              input.client,
              fallbackConfig,
              info.sessionID,
              info.error,
              failedModel,
              telemetry,
            ),
          );
          return;
        }

        if (event.type === "message.part.updated") {
          const part = event.properties?.part;
          if (part?.type === "retry" && part.error) {
            const target = part.sessionID;
            if (!target) return;
            const key = `retry:${part.attempt}:${getErrorMessage(part.error).trim().slice(0, 200)}`;
            if (markRetryKey(target, key)) {
              const decision = await dispatchFallback(
                input.client,
                fallbackConfig,
                target,
                part.error,
                undefined,
                telemetry,
              );
              logDecision("message.part.updated", decision);
            }
          }
          return;
        }

        // opencode retries the SAME model on rate limits before giving up. If the
        // retry message is retryable, switch models proactively instead of
        // waiting for the final failure.
        if (event.type === "session.status") {
          const status = event.properties?.status;
          if (!status || status.type !== "retry") return;
          const target = event.properties?.sessionID;
          if (!target) return;
          // opencode re-emits the same retry status on every backoff tick (and the
          // same failure may also arrive via session.error / message.updated), so
          // dedup per (attempt, message) before dispatching.
          const retryKey = `${status.attempt}:${status.message.trim().slice(0, 200)}`;
          if (!markRetryKey(target, retryKey)) return;
          logDecision(
            "session.status",
            await dispatchFallback(
              input.client,
              fallbackConfig,
              target,
              { message: status.message, next: status.next },
              undefined,
              telemetry,
            ),
          );
        }
      } catch (err) {
        log.error("event hook threw; no-op", err);
      }
    },

    // Keep a session that was switched to a fallback (after a terminal limit) on
    // that fallback for the next turns. opencode resolves the generation model
    // from the last user message, and mutating `output.message.model` here is
    // persisted — see oh-my's runtime-fallback chat-message-handler for the same
    // lever. Any explicit, different model request is treated as a manual switch.
    "chat.message": async (input, output) => {
      try {
        const sessionID = input?.sessionID;
        if (!sessionID) return;
        // Budget attribution (plan T2): remember which agent drives this
        // session so tool.execute.before (which carries no agent) can check
        // the per-agent limit.
        if (typeof input?.agent === "string") {
          setCurrentAgent(sessionID, input.agent);
        }

        // Manual compaction trigger (plan T12.2): the /astrocode:compact
        // command template carries the force marker. Detected here, the
        // engine fires IMMEDIATELY with force semantics (ratio and cooldown
        // are ignored; the frozen-summary skip still applies). With
        // `compaction.enabled: false` the command refuses via a toast and
        // nothing else happens. The marker itself never reaches the model —
        // the messages.transform seam strips it on every request build, and
        // persistent storage is never touched.
        const forceRequest = forceCompactRequest(
          output?.parts,
          astrocodeConfig.compaction.enabled,
        );
        if (forceRequest === "refuse") {
          log.toast({
            variant: "warning",
            title: "astrocode",
            message: "compaction disabled",
          });
          log.info("compaction: /astrocode:compact refused (compaction disabled)");
        } else if (forceRequest === "trigger") {
          setForceCompact(sessionID, true);
          const result = await maybeCompact(
            pluginClient,
            telemetry,
            astrocodeConfig.compaction,
            sessionID,
            lastUsage(sessionID),
            "manual",
          );
          log.info(
            `compaction: manual trigger -> ` +
              (result.ran
                ? `ran (${result.outcome?.path ?? "unknown path"})`
                : result.reason),
          );
        }

        const state = getSessionModelState(sessionID);
        if (!state) return;

        const requested = input?.model
          ? `${input.model.providerID}/${input.model.modelID}`
          : undefined;

        // Already on the fallback (our own resubmission, or a client that picked
        // it up): keep the pin fresh.
        if (requested && areModelsEquivalent(requested, state.currentModel)) {
          touchSessionFallbackModel(sessionID);
          return;
        }

        // Any other explicitly requested model is a deliberate user switch:
        // release the pin and let the user's choice through.
        if (requested && !areModelsEquivalent(requested, state.originalModel)) {
          clearSessionModelState(sessionID);
          clearRetryKeys(sessionID);
          return;
        }

        // The client still asks for the original model. The TUI keeps sending the
        // model it had selected before the switch, so while the pin is fresh we
        // treat this as stale and keep the session on the fallback; once the
        // window elapses we restore the primary.
        if (
          requested &&
          !isFallbackPinActive(sessionID, fallbackConfig.cooldown_seconds)
        ) {
          clearSessionModelState(sessionID);
          return;
        }

        const parsed = parseModelString(state.currentModel);
        if (parsed) {
          output.message.model = parsed;
          touchSessionFallbackModel(sessionID);
        }
      } catch (err) {
        log.error("chat.message hook threw; no-op", err);
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!output || !Array.isArray(output.system)) {
          log.warn(
            "experimental.chat.system.transform: output.system missing or not an array; no-op",
          );
          return;
        }

        // Hash the host pre-filled base BEFORE any append: it is part of the
        // freeze key (see below) and the dump side-channel.
        const baseSha256 = sha256Hex(systemPromptKey(output.system));
        const providerID = input?.model?.providerID ?? "";
        const modelID = input?.model?.id ?? "";

        const family = resolveFamily({
          providerID,
          // CALLER NOTE (see src/models/resolveFamily.ts): real Model uses
          // `.id`, not `.modelID`.
          modelID,
        });

        const guards = getGuards(family, modelID);
        for (const guard of guards) {
          if (!output.system.includes(guard)) {
            output.system.push(guard);
          }
        }

        // Sisyphus dynamic-prompt engine (Option C hybrid, see
        // docs/porting-plan.md). `agents/sisyphus.md` is the static baseline;
        // here we append family-aware, runtime-accurate delta content.
        if (isSisyphusSession(output.system)) {
          const dynamicPrompt = buildDynamicSisyphusPrompt(family, modelID);
          if (!output.system.includes(dynamicPrompt)) {
            output.system.push(dynamicPrompt);
          }
        }

        // Environment/date context (timezone, locale, today) for every agent,
        // mirroring oh-my's applyEnvironmentContext.
        if (!hasEnvContext(output.system)) {
          output.system.push(buildEnvContext());
        }

        // AGENTS.md walk-up context (nearest first), idempotent via its marker.
        if (projectDir && !hasAgentsMdContext(output.system)) {
          const files = findAgentsMdFiles(projectDir);
          if (files.length > 0) output.system.push(buildAgentsMdContext(files));
        }

        // Freeze (plan T8): the first assembled system for a
        // (session, model, pre-filled base) key is stored; every later
        // transform matching that key returns exactly the frozen bytes. A
        // divergent re-assembly is recorded as a system_diff telemetry record
        // (sha256 of both variants) and the frozen version still wins, so the
        // prompt cache never breaks. The key is NOT sessionID alone: opencode
        // fires auxiliary requests (session-title generation) for the same
        // sessionID with another model and another pre-filled base, and a
        // sessionID-only freeze served those frozen bytes to the real chat
        // request (live audit 2026-10-10). Different models — different guard
        // families — and the provider prompt cache is per-model anyway, so
        // each (session, model, base) freezes independently; a subagent
        // session gets its own entries, never the parent's.
        const sessionID = input?.sessionID;
        if (sessionID) {
          const freezeKey = systemFreezeKey(
            sessionID,
            providerID,
            modelID,
            baseSha256,
          );
          const frozen = systemFreeze.get(freezeKey);
          if (frozen === undefined) {
            systemFreeze.set(freezeKey, output.system);
          } else {
            if (systemPromptKey(output.system) !== systemPromptKey(frozen)) {
              recordSystemDiff(
                telemetry,
                {
                  session_id: sessionID,
                  model:
                    providerID && modelID
                      ? { provider_id: providerID, model_id: modelID }
                      : undefined,
                },
                {
                  frozen_sha256: sha256Hex(systemPromptKey(frozen)),
                  incoming_sha256: sha256Hex(systemPromptKey(output.system)),
                  session_id: sessionID,
                },
              );
            }
            // Mutate in place: the hook output is pre-filled by the host, so
            // replacement is length=0 + push of the frozen items.
            output.system.length = 0;
            for (const item of frozen) output.system.push(item);
          }
        }

        dumpPrompt({
          hook: "experimental.chat.system.transform",
          sessionID: input?.sessionID ?? null,
          providerID: providerID || null,
          modelID: modelID || null,
          base_sha256: baseSha256,
          family,
          system: output.system,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error(
          "experimental.chat.system.transform threw; no-op",
          err,
        );
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        if (!output || !Array.isArray(output.messages)) {
          log.warn(
            "experimental.chat.messages.transform: output.messages missing or not an array; no-op",
          );
          return;
        }
        // Force-compact marker hygiene (plan T12.2): the marker NEVER reaches
        // the model. Stripped from every text part on EVERY request build,
        // independent of compaction enablement and session state (the refusal
        // path must not leak the marker either). Persistent storage is not
        // touched: the view is rebuilt from storage each time, so the
        // neutral-replacement bytes are identical on every rebuild.
        const stripped = stripForceMarkers(output.messages);
        if (stripped > 0) {
          log.info(
            `compaction: stripped ${stripped} force-compact marker(s) from the request view`,
          );
        }
        // Compaction engine (plan T10): cache-epoch enforcement. Outside an
        // epoch break this is maintenance-only (deterministic re-stub of
        // already-covered parts + re-injection of the frozen summary at the
        // same anchor) or a strict pass-through; NEW byte mutations happen
        // only in the frame armed by a successful compaction run
        // (epoch_dirty, consumed inside applyCompactionTransform).
        applyCompactionTransform(output.messages, {
          cfg: astrocodeConfig.compaction,
          telemetry,
        });
      } catch (err) {
        log.error(
          "experimental.chat.messages.transform threw; no-op",
          err,
        );
      }
    },

    // Stable compaction prompt (plan T12.1): opencode's native compaction
    // flow gets a CONSTANT prompt built from the same T11 template sections
    // the summarizer validates against (## Goal / ## State / ## Next,
    // 200-4000 chars guidance). Byte-identical between calls — no
    // timestamps, counters or session ids — so tests can hash it and the
    // compaction request stays provider-cache-friendly.
    //
    // `out.context` decision (documented per plan): passed through AS-IS.
    // The host pre-fills it with the transcript reference; no probe has
    // shown a need to mutate it, so the default is no mutation. Revisit only
    // with probe evidence.
    "experimental.session.compacting": async (_input, output) => {
      try {
        if (!output || !Array.isArray(output.context)) {
          log.warn(
            "experimental.session.compacting: output.context missing or not an array; no-op",
          );
          return;
        }
        output.prompt = COMPACTING_PROMPT;
      } catch (err) {
        log.error("experimental.session.compacting threw; no-op", err);
      }
    },

    "chat.params": async (input, output) => {
      try {
        if (!output || typeof output !== "object") {
          log.warn("chat.params: output missing or not an object; no-op");
          return;
        }

        const providerID = input?.model?.providerID ?? "";
        const modelID = input?.model?.id ?? "";
        const family = resolveFamily({
          providerID,
          // CALLER NOTE (see src/models/resolveFamily.ts): real Model uses
          // `.id`, not `.modelID`.
          modelID,
        });

        const sampling = resolveSampling(family, astrocodeConfig.sampling);
        if (sampling) {
          if (sampling.temperature !== undefined) {
            output.temperature = sampling.temperature;
          }
          if (sampling.topP !== undefined) {
            output.topP = sampling.topP;
          }
        }

        // Per-model reasoning overrides (plan T13). Precedence: a `:level`
        // suffix in the model id (runtime id or the agent's configured model
        // string) beats the override; the override beats the family default.
        // `output.options` arrives pre-filled by the host (base + model +
        // agent options) and is mutated in place, so this decision wins over
        // the host defaults. claude entries also carry the explicit
        // clear_thinking passthrough; other families' options are untouched
        // (they take no reasoning params).
        if (astrocodeConfig.reasoning.enabled && output.options && typeof output.options === "object") {
          const decision = decideReasoning({
            family,
            modelId: providerID && modelID ? `${providerID}/${modelID}` : "",
            agentModel: input?.agent ? astrocodeConfig.agents[input.agent]?.model : undefined,
          });
          Object.assign(output.options, decision.options);
        }
      } catch (err) {
        log.error("chat.params threw; no-op", err);
      }
    },

    // Budget enforcement (plan T2). opencode can only reject a tool call
    // before it executes, so `tool.execute.before` is the ONLY enforcement
    // point: spend accumulated mid-generation is caught at the next tool
    // call, never between them. When blocked, enforceBudget has already
    // written the budget_block telemetry record and emitted the toast; the
    // Error thrown here is what opencode surfaces to the model.
    "tool.execute.before": async (input) => {
      let blocked: string | undefined;
      try {
        blocked = enforceBudget(input?.sessionID, telemetry);
      } catch (err) {
        log.error("tool.execute.before hook threw; no-op", err);
      }
      // Thrown outside the defensive catch: the rejection IS the enforcement.
      if (blocked) throw new Error(blocked);
    },

    // Tool-schema hygiene validator (plan T15). Runs on every outgoing tool
    // definition (in: {toolID}; out: {description, parameters} — the exact
    // schema the LLM will see). Findings are recorded (kind
    // "schema_violation") and warned; the hook NEVER breaks a valid schema:
    // log_only (default) mutates nothing, and even repair mode applies only
    // the single safe fix from src/validation/schema.ts (see the boundary
    // comment below). The hook input carries no session context, so the
    // schema_violation record is attributed with the toolID as its
    // session_id — the tool registry, not a chat session, is what a schema
    // finding belongs to.
    "tool.definition": async (input, output) => {
      try {
        if (!astrocodeConfig.schema_validator.enabled) return;
        if (!output || typeof output !== "object") {
          log.warn("tool.definition: output missing or not an object; no-op");
          return;
        }
        const toolName = input?.toolID ?? "";
        const violations = validateToolSchema(toolName, output.parameters);
        if (violations.length === 0) return;

        for (const violation of violations) {
          recordSchemaViolation(
            telemetry,
            { session_id: toolName },
            {
              tool_name: toolName,
              code: violation.code,
              severity: violation.severity,
              path: violation.path,
              message: violation.message,
            },
          );
        }
        log.warn(
          `schema_validator: ${toolName}: ${summarizeViolations(violations)}`,
        );

        // Repair boundary (plan T15, documented in repairToolSchema):
        // log_only: true  -> pure observability, the schema is NEVER mutated.
        // log_only: false -> the ONLY repair is adding root "type": "object"
        // when the root has properties but no type. Root anyOf/oneOf/allOf
        // semantics are NEVER rewritten (collapsing a combinator changes
        // which inputs the tool accepts) — those get the log + mitigation
        // recommendation above only.
        if (!astrocodeConfig.schema_validator.log_only) {
          if (repairToolSchema(output.parameters)) {
            log.info(`schema_validator: ${toolName}: repaired root type to "object"`);
          }
        }
      } catch (err) {
        log.error("tool.definition hook threw; no-op", err);
      }
    },
  };
};

export default astrocodePlugin;