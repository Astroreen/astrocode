import { appendFileSync } from "node:fs";

export const DEFAULT_DUMP_PATH = "/tmp/astrocode-prompt-dump.json";

export function dumpPrompt(entry: unknown): void {
  const flag = process.env.ASTROCODE_DUMP;
  if (!flag) return;

  const path = flag === "1" || flag === "true" ? DEFAULT_DUMP_PATH : flag;
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // Intentionally swallowed: debug side-channel must never crash the host plugin.
  }
}
