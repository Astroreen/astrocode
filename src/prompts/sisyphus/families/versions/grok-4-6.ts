import { buildFallbackSisyphusPrompt } from "../fallback";

const CALIBRATION = `<model_version_calibration version="grok-4-6">
- Tool-call discipline: strict, well-formed calls; batch independent ones in one response.
- Never use placeholders or guess missing parameters.
- Failure mode: over-confident claims - verify with tools before asserting.
- Failure mode: scope expansion - smallest correct change wins.
- Read before editing; diagnose failures before retrying.
- Run each evidence gate once; report failures faithfully.
</model_version_calibration>`;

export function buildGrok46SisyphusPrompt(): string {
  return `${buildFallbackSisyphusPrompt()}\n\n${CALIBRATION}`;
}