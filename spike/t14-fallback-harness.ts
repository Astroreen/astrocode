// Plan T14 QA harness — fallback observability.
//
// Proves the T14 wiring end-to-end at the module boundary:
//   - REAL dispatchFallback (chain advance, per-model cooldown marking)
//   - REAL JsonlTelemetryLogger (createTelemetryLogger -> JSONL on disk)
//   - MOCK SDK client (session.messages / promptAsync / abort stubs)
//
// Scenario A (happy): a terminal error rotates the chain twice
//   broken/t14-fail -> openrouter/xiaomi/mimo-v2.6-pro -> openrouter/z-ai/glm-5.3-flash
//   producing one "fallback" record per rotation; the first carries the
//   per-model cooldown override (120s), the second the global default (60s).
// Scenario B (failure): an error outside retry semantics ("invalid api key")
//   produces ZERO fallback records — no noise; the terminal error is visible
//   in the dispatch decision only.
//
// Run: bun run spike/t14-fallback-harness.ts <happy-dir> <terminal-dir>

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTelemetryLogger,
  type TelemetryRecord,
} from "../src/telemetry/log";
import { parseFallbackConfig } from "../src/fallback/config";
import { dispatchFallback } from "../src/fallback";
import { clearAll } from "../src/fallback/state";
import { clearAllSessionModels } from "../src/fallback/session-model";
import { clearAllModelCooldowns } from "../src/fallback/cooldown";

const happyDir = process.argv[2] ?? "/tmp/opencode-qa-t14/harness-happy";
const terminalDir = process.argv[3] ?? "/tmp/opencode-qa-t14/harness-terminal";

// The failing primary model carries the per-model cooldown override; the
// second link uses the global default.
const PRIMARY = "broken/t14-fail";
const CHAIN = [
  "openrouter/xiaomi/mimo-v2.6-pro",
  "openrouter/z-ai/glm-5.3-flash",
];

const config = parseFallbackConfig({
  enabled: true,
  models: CHAIN,
  cooldown_seconds: 60,
  cooldown_seconds_by_model: { [PRIMARY]: 120 },
  // Rotate on the first failure (no same-model retry deferral).
  same_model_max_retries: 0,
});

function userTurn(model: string): unknown {
  const slash = model.indexOf("/");
  const providerID = slash > 0 ? model.slice(0, slash) : model;
  const modelID = slash > 0 ? model.slice(slash + 1) : model;
  return {
    info: {
      role: "user",
      agent: "Sisyphus - ultraworker",
      model: { providerID, modelID },
    },
    parts: [{ type: "text", text: "do the thing" }],
  };
}

function mockClient(messages: unknown[]) {
  return {
    session: {
      messages: async () => ({ data: messages }),
      abort: async () => ({}),
      prompt: async () => ({ data: {} }),
      promptAsync: async () => ({ data: {} }),
    },
  };
}

function readRecords(dir: string): TelemetryRecord[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const out: TelemetryRecord[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.length > 0) out.push(JSON.parse(line) as TelemetryRecord);
    }
  }
  return out;
}

async function scenarioHappy(): Promise<void> {
  mkdirSync(happyDir, { recursive: true });
  clearAll();
  clearAllSessionModels();
  clearAllModelCooldowns();
  const logger = createTelemetryLogger({ dir: happyDir });

  // Rotation 1: the primary (broken/t14-fail) hits a terminal limit.
  const d1 = await dispatchFallback(
    mockClient([userTurn(PRIMARY)]) as never,
    config,
    "ses-harness",
    { message: "You've hit your session limit · resets 6pm" },
    undefined,
    logger,
  );
  console.log(`[happy] decision 1: ${JSON.stringify(d1)}`);

  // Rotation 2: the first fallback (mimo) fails too; the resubmitted turn ran
  // on it, so both the user turn and failedModel carry it.
  const d2 = await dispatchFallback(
    mockClient([userTurn(CHAIN[0] ?? "")]) as never,
    config,
    "ses-harness",
    { message: "You've hit your session limit · resets 6pm" },
    CHAIN[0],
    logger,
  );
  console.log(`[happy] decision 2: ${JSON.stringify(d2)}`);

  logger.close();
  const records = readRecords(happyDir);
  const fallbacks = records.filter((record) => record.kind === "fallback");
  console.log(`[happy] telemetry records: ${records.length} (fallback: ${fallbacks.length})`);
  for (const record of fallbacks) {
    console.log(`[happy] ${JSON.stringify(record)}`);
  }
}

async function scenarioTerminal(): Promise<void> {
  mkdirSync(terminalDir, { recursive: true });
  clearAll();
  clearAllSessionModels();
  clearAllModelCooldowns();
  const logger = createTelemetryLogger({ dir: terminalDir });

  const decision = await dispatchFallback(
    mockClient([userTurn(PRIMARY)]) as never,
    config,
    "ses-terminal",
    { message: "invalid api key" },
    undefined,
    logger,
  );
  console.log(`[terminal] decision: ${JSON.stringify(decision)}`);

  logger.close();
  const records = readRecords(terminalDir);
  const fallbacks = records.filter((record) => record.kind === "fallback");
  console.log(`[terminal] telemetry records: ${records.length} (fallback: ${fallbacks.length})`);
  for (const record of records) {
    console.log(`[terminal] ${JSON.stringify(record)}`);
  }
}

await scenarioHappy();
await scenarioTerminal();
