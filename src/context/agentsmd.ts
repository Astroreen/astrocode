// AGENTS.md walk-up context injection.
//
// Walks up from a starting directory collecting `AGENTS.md` files (nearest
// first), then renders them into a single context block. Filesystem-only and
// defensive: every level and every read is guarded so this never throws.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const AGENTS_MD_MARKER = "[Directory Context:";

const MAX_CONTEXT_CHARS = 8000;

export function findAgentsMdFiles(
  startDir: string,
  stopDir: string = homedir(),
  maxFiles = 5,
): string[] {
  const found: string[] = [];
  try {
    let dir = startDir;
    while (found.length < maxFiles) {
      try {
        const candidate = join(dir, "AGENTS.md");
        if (existsSync(candidate)) {
          found.push(candidate);
        }
      } catch {
        // ignore an unreadable level, keep walking
      }
      if (dir === stopDir) {
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    // never throw
  }
  return found;
}

export function buildAgentsMdContext(files: string[]): string {
  const blocks: string[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(file, "utf8");
      blocks.push(`${AGENTS_MD_MARKER} ${file}]\n${content}`);
    } catch {
      // skip unreadable files
    }
  }
  const joined = blocks.join("\n\n");
  if (joined.length > MAX_CONTEXT_CHARS) {
    return joined.slice(0, MAX_CONTEXT_CHARS - 1) + "…";
  }
  return joined;
}

export function hasAgentsMdContext(system: string[]): boolean {
  return system.some((entry) => entry.includes(AGENTS_MD_MARKER));
}
