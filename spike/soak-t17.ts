// T17 soak driver (plan T17.2, shortened soak): ONE persistent headless
// session, 30+ sequential prompts on the cheap model. Compaction state lives
// in the server process, so the session is driven over the SDK against a
// persistent `opencode serve` (T12 pattern) — never via repeated `opencode run`.
//
// The project dir passed via --dir must contain .opencode/astrocode.jsonc with
// compaction enabled + a tiny context_window (forces epoch breaks) and
// cooldown_seconds: 30. Telemetry capture happens via ASTROCODE_TELEMETRY_DIR
// on the serve process; aggregation is a separate step.
//
// Invocation:
//   bun spike/soak-t17.ts \
//     --base-url http://127.0.0.1:46117 \
//     --dir /tmp/opencode-qa-t17/project \
//     --prompts 32 \
//     --provider openrouter --model "xiaomi/mimo-v2.6-pro" \
//     --out .sisyphus/evidence/2026-10-10-astrocode-telemetry-cache-reliability/T17/soak-driver.json

import { createOpencodeClient } from "@opencode-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface DriverArgs {
  baseUrl: string;
  dir: string;
  prompts: number;
  provider: string;
  model: string;
  out: string;
}

function parseDriverArgs(argv: string[]): DriverArgs {
  const parsed: DriverArgs = {
    baseUrl: "http://127.0.0.1:46117",
    dir: process.cwd(),
    prompts: 32,
    provider: "openrouter",
    model: "xiaomi/mimo-v2.6-pro",
    out: "spike/out/soak-driver.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i]!.indexOf("=");
    const key = eq === -1 ? argv[i] : argv[i]!.slice(0, eq);
    const value = eq === -1 ? argv[++i] : argv[i]!.slice(eq + 1);
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === "--base-url") parsed.baseUrl = value;
    else if (key === "--dir") parsed.dir = resolve(value);
    else if (key === "--prompts") parsed.prompts = Number(value);
    else if (key === "--provider") parsed.provider = value;
    else if (key === "--model") parsed.model = value;
    else if (key === "--out") parsed.out = resolve(value);
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!Number.isFinite(parsed.prompts) || parsed.prompts < 1) {
    throw new Error("--prompts must be a positive number");
  }
  return parsed;
}

interface TurnRow {
  index: number;
  ok: boolean;
  elapsed_ms: number;
  reply_chars: number;
  error?: string;
}

const args = parseDriverArgs(process.argv.slice(2));
const client = createOpencodeClient({ baseUrl: args.baseUrl, directory: args.dir });

const created = await client.session.create({ body: { title: "T17 shortened soak" } });
const sessionID = created.data?.id;
if (!sessionID) {
  console.error(JSON.stringify({ fatal: "no session id from session.create" }));
  process.exit(1);
}
console.log(JSON.stringify({ session: sessionID, prompts: args.prompts }));

const wallStart = Date.now();
const rows: TurnRow[] = [];

for (let i = 1; i <= args.prompts; i++) {
  const text =
    `Turn ${i} of the T17 soak. Reply with exactly three short sentences ` +
    `describing a fictional cache experiment EXP-${i}. Do not use any tools.`;
  const t0 = Date.now();
  const row: TurnRow = { index: i, ok: false, elapsed_ms: 0, reply_chars: 0 };
  try {
    const result = await client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text }],
        model: { providerID: args.provider, modelID: args.model },
      },
    });
    const data = result.data;
    let replyChars = 0;
    if (data?.parts && Array.isArray(data.parts)) {
      for (const part of data.parts) {
        const candidate = part as { type?: string; text?: string };
        if (candidate?.type === "text" && typeof candidate.text === "string") {
          replyChars += candidate.text.length;
        }
      }
    }
    row.ok = true;
    row.reply_chars = replyChars;
  } catch (err) {
    row.error = String(err).slice(0, 300);
  }
  row.elapsed_ms = Date.now() - t0;
  rows.push(row);
  console.log(JSON.stringify(row));
}

const wallMs = Date.now() - wallStart;
const summary = {
  session_id: sessionID,
  provider: args.provider,
  model: args.model,
  prompts_requested: args.prompts,
  prompts_ok: rows.filter((r) => r.ok).length,
  prompts_error: rows.filter((r) => !r.ok).length,
  wall_ms: wallMs,
  started_epoch_ms: wallStart,
  ended_epoch_ms: wallStart + wallMs,
  rows,
};

await mkdir(dirname(args.out), { recursive: true });
await writeFile(args.out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ written: args.out, prompts_ok: summary.prompts_ok, wall_ms: wallMs }));
