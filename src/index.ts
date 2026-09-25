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
import type { Plugin } from "@opencode-ai/plugin";
import { resolveFamily, type ModelFamily } from "./models/resolveFamily";
import {
  reasoningConfigForFamily,
  resolveSampling,
  splitReasoningSuffix,
  isReasoningLevel,
} from "./models/tuning";
import { getGuards } from "./prompts/guards";
import { dumpPrompt } from "./prompts/dump";
import {
  isSisyphusSession,
  buildDynamicSisyphusPrompt,
} from "./prompts/sisyphus/dispatch";
import { dispatchFallback, parseModelString } from "./fallback";
import { areModelsEquivalent } from "./fallback/canonicalize";
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
import { loadAstrocodeConfig } from "./config/astrocode";
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
  findAgentsMdFiles,
  buildAgentsMdContext,
  hasAgentsMdContext,
} from "./context/agentsmd";
import { getErrorName } from "./fallback/classify";
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

  const projectDir = input?.directory;
  const searchDirs = [input?.directory, input?.worktree].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  const astrocodeConfig = loadAstrocodeConfig(searchDirs, options);
  const fallbackConfig = astrocodeConfig.fallback;

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
      clearFallbackState();
      clearAllSessionModels();
      clearChildSessions();
      resetIdleContinuationState();
    },

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
          const agentConfig = {
            ...personaToAgentConfig(
              persona,
              (persona as PersonaDefinition & { model?: string }).model,
              undefined,
            ),
            ...existing,
            description: persona.description,
            mode: persona.mode,
            prompt: persona.prompt,
          };

          // Family reasoning/thinking options (claude extended thinking, gpt
          // reasoningEffort). Only when we know the effective model.
          if (astrocodeConfig.reasoning.enabled) {
            const agentModel =
              (persona as PersonaDefinition & { model?: string }).model ??
              astrocodeConfig.model ??
              defaultModel;
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
    // as a `message.updated` on an assistant message carrying `.error`, or (for
    // retryable same-model retries) as `session.status` with type "retry".
    event: async ({ event }) => {
      try {
        // Idle continuation is independent of fallback enablement.
        if (
          event.type === "session.idle" &&
          astrocodeConfig.idleContinuation.enabled
        ) {
          const target = event.properties?.sessionID;
          if (target) {
            const result = await maybeContinueIdle(input.client, target, {
              max: astrocodeConfig.idleContinuation.max,
            });
            log.info(`idle-continuation: ${result.reason}`);
          }
          return;
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
            decision.reason === "throttled" ||
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
            ),
          );
          return;
        }

        if (event.type === "message.updated") {
          const info = event.properties?.info;
          if (info?.role !== "assistant") return;
          if (!info.error) return;
          logDecision(
            "message.updated",
            await dispatchFallback(
              input.client,
              fallbackConfig,
              info.sessionID,
              info.error,
            ),
          );
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
            await dispatchFallback(input.client, fallbackConfig, target, {
              message: status.message,
            }),
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

        const family = resolveFamily({
          providerID: input?.model?.providerID ?? "",
          // CALLER NOTE (see src/models/resolveFamily.ts): real Model uses
          // `.id`, not `.modelID`.
          modelID: input?.model?.id ?? "",
        });

        const guards = getGuards(family, input?.model?.id ?? "");
        for (const guard of guards) {
          if (!output.system.includes(guard)) {
            output.system.push(guard);
          }
        }

        // Sisyphus dynamic-prompt engine (Option C hybrid, see
        // docs/porting-plan.md). `agents/sisyphus.md` is the static baseline;
        // here we append family-aware, runtime-accurate delta content.
        if (isSisyphusSession(output.system)) {
          const dynamicPrompt = buildDynamicSisyphusPrompt(
            family,
            input?.model?.id ?? "",
          );
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

        dumpPrompt({
          hook: "experimental.chat.system.transform",
          sessionID: input?.sessionID ?? null,
          providerID: input?.model?.providerID ?? null,
          modelID: input?.model?.id ?? null,
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

    "chat.params": async (input, output) => {
      try {
        if (!output || typeof output !== "object") {
          log.warn("chat.params: output missing or not an object; no-op");
          return;
        }

        const family = resolveFamily({
          providerID: input?.model?.providerID ?? "",
          modelID: input?.model?.id ?? "",
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
      } catch (err) {
        log.error("chat.params threw; no-op", err);
      }
    },
  };
};

export default astrocodePlugin;