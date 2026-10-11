// Tool-schema snapshot probe (plan T8.3; reused by T7 and gate G3).
//
// Snapshots the full tool list (id + description + JSON-schema parameters)
// that opencode would expose for a provider/model, via the SDK route
// `GET /experimental/tool` (`client.tool.list`, the same client pattern a
// plugin receives as `PluginInput.client`). Writes a JSON snapshot plus the
// sha256 of the canonicalized schema (recursively key-sorted objects, tools
// sorted by id) so hashes are comparable across runs and providers.
//
// The hash covers ONLY the canonicalized tool list — never the timestamp —
// so two snapshots of the same schema produce identical sha256 values.
//
// Exact invocation (T7 / G3):
//
//   bun spike/probe-tool-schema.ts \
//     --provider openrouter \
//     --model "xiaomi/mimo-v2.6-pro" \
//     --dir /tmp/opencode-t8-schema/project \
//     --out .sisyphus/evidence/2026-10-10-astrocode-telemetry-cache-reliability/T7/schema-openrouter.json
//
// The script spawns `opencode serve` inside --dir (so project plugins from
// that project's .opencode/ are registered), waits for readiness, snapshots,
// then terminates the server. Callers that need provider isolation should
// export XDG_CONFIG_HOME pointing at an isolated dir before invoking.
// To attach to an already-running server instead: --base-url http://127.0.0.1:4096
//
// Output path defaults to spike/out/tool-schema.json (relative to cwd).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { log } from "../src/log";

interface ProbeOptions {
  provider: string;
  model: string;
  dir: string;
  out: string;
  baseUrl?: string;
  port?: number;
}

function parseArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    provider: "openrouter",
    model: "xiaomi/mimo-v2.6-pro",
    dir: process.cwd(),
    out: "spike/out/tool-schema.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === "--provider") options.provider = value;
    else if (key === "--model") options.model = value;
    else if (key === "--dir") options.dir = resolve(value);
    else if (key === "--out") options.out = resolve(value);
    else if (key === "--base-url") options.baseUrl = value;
    else if (key === "--port") options.port = Number(value);
    else throw new Error(`unknown argument: ${key}`);
  }
  return options;
}

/** Grab a free TCP port (bind :0, read it, release). */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => rejectPort(new Error("no TCP port available")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

/** Poll the server's /path route until it answers (or timeout).
 *
 * Every attempt is bounded by its own AbortSignal: a fetch issued while the
 * server is still booting connects (listen backlog) but is never processed,
 * and bun's fetch has no default timeout — without the signal the probe hangs
 * forever instead of retrying (observed on opencode 1.18.31). */
async function waitUntilReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = "server not started yet";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/path`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(200);
  }
  throw new Error(`opencode serve not ready at ${baseUrl}: ${String(lastError)}`);
}

/** Recursively sort object keys so JSON.stringify is key-order stable. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalSchemaSha256(tools: unknown[]): string {
  const sorted = [...tools].sort((a, b) =>
    String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(sorted)))
    .digest("hex");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  log.info(
    `probe-tool-schema: provider=${options.provider} model=${options.model} dir=${options.dir}`,
  );

  let server: Bun.Subprocess<"ignore", Bun.FileSink, Bun.FileSink> | undefined;
  let baseUrl = options.baseUrl;
  if (!baseUrl) {
    const port = options.port ?? (await freePort());
    // Serve output MUST land in a real file: with stdout/stderr discarded
    // ("ignore") the spawned server never starts listening (observed on
    // opencode 1.18.31), and pipes would eventually fill and block it.
    const serveLog = join(tmpdir(), `astrocode-probe-tool-schema-${process.pid}.log`);
    server = Bun.spawn(
      ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd: options.dir,
        stdout: Bun.file(serveLog),
        stderr: Bun.file(serveLog),
      },
    );
    baseUrl = `http://127.0.0.1:${port}`;
    log.info(`probe-tool-schema: spawned opencode serve on ${baseUrl} (log: ${serveLog})`);
  }

  try {
    await waitUntilReady(baseUrl, 30_000);

    // Same client shape a plugin receives as PluginInput.client.
    const client = createOpencodeClient({ baseUrl, directory: options.dir });
    const result = await client.tool.list({
      query: { provider: options.provider, model: options.model, directory: options.dir },
    });
    if (result.error || !result.data) {
      throw new Error(`tool.list failed: ${JSON.stringify(result.error) ?? "no data"}`);
    }

    const tools = result.data.map((item) => ({
      id: item.id,
      description: item.description,
      parameters: item.parameters,
    }));
    const sha256 = canonicalSchemaSha256(tools);

    const snapshot = {
      schema_version: 1,
      // Metadata only — deliberately NOT part of the hashed canonical form.
      captured_at: new Date().toISOString(),
      provider: options.provider,
      model: options.model,
      directory: options.dir,
      tool_count: tools.length,
      sha256,
      tools: [...tools].sort((a, b) => a.id.localeCompare(b.id)),
    };

    await mkdir(dirname(options.out), { recursive: true });
    const payload = JSON.stringify(snapshot, null, 2) + "\n";
    await writeFile(options.out, payload, "utf8");

    // Sanitizer gotcha: read the file back and verify it round-trips.
    const readBack = await readFile(options.out, "utf8");
    const parsed = JSON.parse(readBack) as { sha256: string; tool_count: number };
    if (parsed.sha256 !== sha256 || parsed.tool_count !== tools.length) {
      throw new Error(`snapshot readback mismatch in ${options.out}`);
    }

    log.info(
      `probe-tool-schema: wrote ${options.out} (${tools.length} tools, sha256=${sha256})`,
    );
    console.log(JSON.stringify({ out: options.out, tool_count: tools.length, sha256 }));
  } finally {
    if (server) {
      server.kill();
      // Bounded shutdown: never hang the probe on a stubborn subprocess.
      const exited = await Promise.race([server.exited, Bun.sleep(3_000)]);
      if (exited === null && server.exitCode === null) {
        server.kill("SIGKILL");
        await Promise.race([server.exited, Bun.sleep(3_000)]);
      }
    }
  }
}

await main();
