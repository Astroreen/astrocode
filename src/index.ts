// astrocode plugin entry point.
//
// Thin, model-aware layer (AD-2): appends model-family-specific defensive
// guard text via `experimental.chat.system.transform` and tunes sampling via
// `chat.params`. Personas themselves live in agents/*.md (native, stable) —
// this plugin never wipes or replaces output.system (AD-1: mutate-in-place,
// append only).
//
// Defensive by design: every hook is wrapped so an unexpected/changed API
// shape logs a warning and no-ops instead of crashing the host session.

import type { Plugin } from "@opencode-ai/plugin";
import { resolveFamily } from "./models/resolveFamily";
import { getGuards } from "./prompts/guards";
import { dumpPrompt } from "./prompts/dump";

const LOG_PREFIX = "[astrocode]";

// Sampling override applied only to the cheap-openrouter family (AD-3).
// claude and fallback keep whatever defaults the core/provider already set.
const CHEAP_TEMPERATURE = 0.3;
const CHEAP_TOP_P = 0.9;

const astrocodePlugin: Plugin = async () => {
  return {
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
          // Idempotency: string equality is enough since getGuards returns
          // the same verbatim module-const strings every call.
          if (!output.system.includes(guard)) {
            output.system.push(guard);
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

        if (family === "cheap-openrouter") {
          output.temperature = CHEAP_TEMPERATURE;
          output.topP = CHEAP_TOP_P;
        }
        // claude + fallback: leave whatever defaults are already set.
      } catch (err) {
        console.error(`${LOG_PREFIX} chat.params threw; no-op`, err);
      }
    },
  };
};

export default astrocodePlugin;
