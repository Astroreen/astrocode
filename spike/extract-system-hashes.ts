// System-prompt dynamics audit extractor (plan T8.2).
//
// Consumes the JSONL side-channel the plugin already writes when
// ASTROCODE_DUMP=<path> is set (src/prompts/dump.ts, fed by the
// experimental.chat.system.transform hook in src/index.ts) and computes the
// sha256 of the assembled system prompt per request via the same
// systemPromptKey + sha256Hex helpers the freeze uses.
//
// Live-session recipe (one session, three requests — each `opencode run` is a
// fresh process, so every entry below is a from-scratch assembly, which makes
// this a stronger check than within-process comparisons):
//
//   scratch=/tmp/opencode-t8-audit/project
//   mkdir -p "$scratch/.opencode"
//   printf '{"$schema":"https://opencode.ai/config.json","plugin":["/home/ilja/Documents/astrocode/src/index.ts"]}' \
//     > "$scratch/.opencode/opencode.json"
//   export XDG_CONFIG_HOME=/tmp/opencode-t8-audit/xdg
//   export ASTROCODE_DUMP=/tmp/opencode-t8-audit/dump.jsonl
//   export ASTROCODE_TELEMETRY_DIR=/tmp/opencode-t8-audit/telemetry
//   cd "$scratch"
//   opencode run --auto -m openrouter/xiaomi/mimo-v2.6-pro "Reply with exactly: OK1"
//   opencode run -s <sessionID> --auto -m openrouter/xiaomi/mimo-v2.6-pro "Reply with exactly: OK2"
//   opencode run -s <sessionID> --auto -m openrouter/xiaomi/mimo-v2.6-pro "Reply with exactly: OK3"
//   cd /home/ilja/Documents/astrocode
//   bun spike/extract-system-hashes.ts /tmp/opencode-t8-audit/dump.jsonl \
//     .sisyphus/evidence/2026-10-10-astrocode-telemetry-cache-reliability/T8
//
// Writes (per the prompt kind with the most transform entries):
//   <out-dir>/system-diff.json       — turns 1 and 2, `equal` must be true
//   <out-dir>/system-diff-3turns.json — all turns, `all_equal` must be true
// Exits non-zero if any pair of hashes differs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sha256Hex, systemPromptKey } from "../src/prompts/freeze";
import { log } from "../src/log";

interface DumpEntry {
  hook?: string;
  sessionID?: string | null;
  providerID?: string | null;
  modelID?: string | null;
  base_sha256?: string | null;
  system?: string[];
  timestamp?: string;
}

interface TurnHash {
  turn: number;
  sha256: string;
  items: number;
  captured_at: string | null;
}

async function readDump(path: string): Promise<DumpEntry[]> {
  const raw = await readFile(path, "utf8");
  const entries: DumpEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    entries.push(JSON.parse(line) as DumpEntry);
  }
  return entries;
}

async function writeVerified(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  // Sanitizer gotcha: read back and confirm the JSON round-trips.
  const readBack = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (JSON.stringify(readBack) !== JSON.stringify(payload)) {
    throw new Error(`readback mismatch in ${path}`);
  }
}

async function main(): Promise<void> {
  const [dumpPath = "/tmp/astrocode-prompt-dump.json", outDir = "."] =
    process.argv.slice(2);
  const entries = await readDump(resolve(dumpPath));
  const transforms = entries.filter(
    (entry) => entry.hook === "experimental.chat.system.transform" && Array.isArray(entry.system),
  );
  if (transforms.length === 0) {
    throw new Error(`no system.transform entries in ${dumpPath}`);
  }

  // Group by freeze key — (sessionID, provider, model, pre-filled base hash).
  // A session legitimately mixes prompt kinds (chat vs session-title
  // generation) and models, and those assemble different bytes ON PURPOSE;
  // determinism is required within one kind, not across kinds.
  const byKey = new Map<string, DumpEntry[]>();
  for (const entry of transforms) {
    const key = [
      entry.sessionID ?? "(no-session)",
      entry.providerID ?? "",
      entry.modelID ?? "",
      entry.base_sha256 ?? "(legacy-dump)",
    ].join("\u0000");
    const bucket = byKey.get(key);
    if (bucket) bucket.push(entry);
    else byKey.set(key, [entry]);
  }
  let sessionID = "";
  let sessionEntries: DumpEntry[] = [];
  for (const [key, bucket] of byKey) {
    if (bucket.length > sessionEntries.length) {
      sessionID = key;
      sessionEntries = bucket;
    }
  }
  log.info(
    `extract-system-hashes: prompt kinds=${byKey.size}; auditing ${sessionID}`,
  );

  const turns: TurnHash[] = sessionEntries.map((entry, index) => ({
    turn: index + 1,
    sha256: sha256Hex(systemPromptKey(entry.system ?? [])),
    items: (entry.system ?? []).length,
    captured_at: entry.timestamp ?? null,
  }));

  const first = turns[0];
  const equal = turns.length >= 2 && turns[1].sha256 === first.sha256;
  const allEqual = turns.every((turn) => turn.sha256 === first.sha256);

  const base = {
    session_id: sessionEntries[0]?.sessionID ?? null,
    provider: sessionEntries[0]?.providerID ?? null,
    model: sessionEntries[0]?.modelID ?? null,
    base_sha256: sessionEntries[0]?.base_sha256 ?? null,
    source_dump: resolve(dumpPath),
  };

  await writeVerified(resolve(outDir, "system-diff.json"), {
    ...base,
    requests: turns.slice(0, 2),
    equal,
  });
  await writeVerified(resolve(outDir, "system-diff-3turns.json"), {
    ...base,
    requests: turns,
    all_equal: allEqual,
  });

  console.log(
    JSON.stringify({
      prompt_kind: sessionID,
      turns: turns.length,
      equal,
      all_equal: allEqual,
      hashes: turns.map((turn) => turn.sha256),
    }),
  );
  if (!equal || !allEqual) {
    throw new Error("system prompt hashes diverge across requests");
  }
}

await main();
