// astrocode plugin entry point.
//
// Thin, model-aware layer: appends model-family guard text and the dynamic
// Sisyphus prompt via `experimental.chat.system.transform`, tunes sampling via
// `chat.params`, injects personas/commands via `config`, and performs real
// mid-task model fallback via `event`.
//
// Personas are owned by the plugin (read from the shipped `agents/*.md`), so a
// project only needs the plugin entry — no copying personas into
// `.opencode/agents/`. astrocode's own settings (per-agent model, fallback chain,
// colors) live in a dedicated `astrocode.jsonc` file, not in opencode.jsonc.
//
// Defensive by design: every hook is wrapped so an unexpected/changed API shape
// logs a warning and no-ops instead of crashing the host session.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { resolveFamily, isCheapSamplingFamily } from "./models/resolveFamily";
import { getGuards } from "./prompts/guards";
import { dumpPrompt } from "./prompts/dump";
import {
  isSisyphusSession,
  buildDynamicSisyphusPrompt,
} from "./prompts/sisyphus/dispatch";
import { dispatchFallback } from "./fallback";
import { clearAll as clearFallbackState } from "./fallback/state";
import { buildBuiltinCommands } from "./commands";
import { loadAstrocodeConfig } from "./config/astrocode";
import {
  buildNativeOverrides,
  loadPersonas,
  type PersonaDefinition,
} from "./agents/personas";

const LOG_PREFIX = "[astrocode]";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = join(PLUGIN_ROOT, "agents");

const CHEAP_TEMPERATURE = 0.3;
const CHEAP_TOP_P = 0.9;

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

const astrocodePlugin: Plugin = async (input, options) => {
  const searchDirs = [input?.directory, input?.worktree].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  const astrocodeConfig = loadAstrocodeConfig(searchDirs, options);
  const fallbackConfig = astrocodeConfig.fallback;

  // Personas are read once at plugin init; the native build/plan overrides are
  // layered on top (build -> Sisyphus, plan -> Prometheus).
  const basePersonas = loadPersonas(AGENTS_DIR);
  const personas = { ...basePersonas, ...buildNativeOverrides(basePersonas) };

  return {
    dispose: async () => {
      clearFallbackState();
    },

    // Own the agent roster + builtin commands. This replaces opencode's native
    // `build`/`plan` with the Sisyphus/Prometheus personas and gives every agent
    // its own color and optional model.
    config: async (cfg) => {
      try {
        const root = cfg as unknown as Record<string, unknown>;
        const agents =
          root.agent && typeof root.agent === "object"
            ? (root.agent as Record<string, AgentConfigLike>)
            : {};
        root.agent = agents;

        for (const [name, persona] of Object.entries(personas)) {
          const settings = astrocodeConfig.agents[name];
          agents[name] = personaToAgentConfig(
            persona,
            settings?.model,
            settings?.color,
          );
        }

        const commands =
          root.command && typeof root.command === "object"
            ? (root.command as Record<string, unknown>)
            : {};
        for (const [name, definition] of Object.entries(buildBuiltinCommands())) {
          if (!commands[name]) commands[name] = definition;
        }
        root.command = commands;

        console.error(
          `${LOG_PREFIX} config: injected ${Object.keys(personas).length} agents, ` +
            `${Object.keys(commands).length} commands, fallback=` +
            `${fallbackConfig.enabled ? "on" : "off"}`,
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} config hook threw; no-op`, err);
      }
    },

    // Real mid-task model fallback (docs/porting-plan.md "Fallback module
    // design"). opencode surfaces a failed model call either as `session.error`
    // or as a `message.updated` on an assistant message carrying `.error`; we
    // handle both.
    event: async ({ event }) => {
      try {
        if (!fallbackConfig.enabled) return;

        if (event.type === "session.error") {
          const target = event.properties?.sessionID;
          if (!target) return;
          const decision = await dispatchFallback(
            input.client,
            fallbackConfig,
            target,
            event.properties?.error,
          );
          console.error(
            `${LOG_PREFIX} fallback(session.error): ${decision.reason}` +
              (decision.model ? ` -> ${decision.model}` : ""),
          );
          return;
        }

        if (event.type === "message.updated") {
          const info = event.properties?.info;
          if (info?.role !== "assistant") return;
          if (!info.error) return;
          const decision = await dispatchFallback(
            input.client,
            fallbackConfig,
            info.sessionID,
            info.error,
          );
          console.error(
            `${LOG_PREFIX} fallback(message.updated): ${decision.reason}` +
              (decision.model ? ` -> ${decision.model}` : ""),
          );
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} event hook threw; no-op`, err);
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!output || !Array.isArray(output.system)) {
          console.error(
            `${LOG_PREFIX} experimental.chat.system.transform: output.system missing or not an array; no-op`,
          );
          return;
        }

        const family = resolveFamily({
          providerID: input?.model?.providerID ?? "",
          // CALLER NOTE (see src/models/resolveFamily.ts): real Model uses
          // `.id`, not `.modelID`.
          modelID: input?.model?.id ?? "",
        });

        const guards = getGuards(family);
        for (const guard of guards) {
          if (!output.system.includes(guard)) {
            output.system.push(guard);
          }
        }

        // Sisyphus dynamic-prompt engine (Option C hybrid, see
        // docs/porting-plan.md). `agents/sisyphus.md` is the static baseline;
        // here we append family-aware, runtime-accurate delta content.
        if (isSisyphusSession(output.system)) {
          const dynamicPrompt = buildDynamicSisyphusPrompt(family);
          if (!output.system.includes(dynamicPrompt)) {
            output.system.push(dynamicPrompt);
          }
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
        console.error(
          `${LOG_PREFIX} experimental.chat.system.transform threw; no-op`,
          err,
        );
      }
    },

    "chat.params": async (input, output) => {
      try {
        if (!output || typeof output !== "object") {
          console.error(
            `${LOG_PREFIX} chat.params: output missing or not an object; no-op`,
          );
          return;
        }

        const family = resolveFamily({
          providerID: input?.model?.providerID ?? "",
          modelID: input?.model?.id ?? "",
        });

        if (isCheapSamplingFamily(family)) {
          output.temperature = CHEAP_TEMPERATURE;
          output.topP = CHEAP_TOP_P;
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} chat.params threw; no-op`, err);
      }
    },
  };
};

export default astrocodePlugin;