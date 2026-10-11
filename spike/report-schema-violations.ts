// Schema-violation report (plan T15): reads a tool-schema snapshot produced by
// probe-tool-schema.ts, runs the T15 validator (src/validation/schema.ts) over
// every tool, and writes the snapshot back enriched with a per-tool violations
// section plus a summary. Pure analysis — no opencode server needed.
//
//   bun spike/report-schema-violations.ts \
//     --in .sisyphus/evidence/.../T15/schema-report.json
//
// The enriched file keeps every original probe field (sha256, tools, ...) and
// adds: violations: [{tool, violations: Violation[]}], violation_summary:
// {tools_with_violations, by_code}.

import { readFile, writeFile } from "node:fs/promises";
import { validateToolSchema, type Violation } from "../src/validation/schema";

interface ReportOptions {
  input: string;
}

function parseArgs(argv: string[]): ReportOptions {
  const options: ReportOptions = { input: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === "--in") options.input = value;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!options.input) throw new Error("usage: --in <snapshot.json>");
  return options;
}

interface SnapshotTool {
  id: string;
  description?: string;
  parameters?: unknown;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await readFile(options.input, "utf8")) as Record<
    string,
    unknown
  > & { tools: SnapshotTool[] };

  const findings: { tool: string; violations: Violation[] }[] = [];
  const byCode = new Map<string, number>();
  for (const tool of snapshot.tools) {
    const violations = validateToolSchema(tool.id, tool.parameters);
    if (violations.length > 0) {
      findings.push({ tool: tool.id, violations });
      for (const violation of violations) {
        byCode.set(violation.code, (byCode.get(violation.code) ?? 0) + 1);
      }
    }
  }

  const enriched = {
    ...snapshot,
    validator: {
      version: 1,
      ran_at: new Date().toISOString(),
      tools_with_violations: findings.length,
      by_code: Object.fromEntries([...byCode.entries()].sort()),
      violations: findings,
    },
  };

  await writeFile(options.input, JSON.stringify(enriched, null, 2) + "\n", "utf8");
  console.log(
    JSON.stringify({
      input: options.input,
      tools: snapshot.tools.length,
      tools_with_violations: findings.length,
      by_code: Object.fromEntries(byCode.entries()),
    }),
  );
}

await main();
