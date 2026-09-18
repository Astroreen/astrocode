import { readFile, writeFile } from "node:fs/promises";

const DUMP_PATH = "/tmp/astrocode-spike-dump.json";
const PROBE_MARKER = "[astrocode-spike-probe active]";

async function readDump() {
  try {
    const raw = await readFile(DUMP_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export async function AstrocodeSpikeProbe(ctx) {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      const entries = await readDump();
      entries.push({
        timestamp: new Date().toISOString(),
        sessionID: input.sessionID ?? null,
        model: {
          providerID: input.model?.providerID ?? null,
          modelID: input.model?.modelID ?? null,
        },
        directory: ctx.directory,
        worktree: ctx.worktree,
        system: Array.isArray(output.system) ? [...output.system] : [],
      });
      await writeFile(DUMP_PATH, JSON.stringify(entries, null, 2) + "\n", "utf8");

      if (!output.system.includes(PROBE_MARKER)) {
        output.system.push(PROBE_MARKER);
      }
    },
  };
}
