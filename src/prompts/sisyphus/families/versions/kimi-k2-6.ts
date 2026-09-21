import { buildKimiSisyphusPrompt } from "../kimi";

const CALIBRATION = `<model_version_calibration version="kimi-k2-6">
- Terminal condition: once the decisive fact is known, act - stop analyzing.
- Commitment: pick a path and commit; do not keep half-explored alternatives open.
- Tool-call discipline: parallelize independent calls; sequence dependent ones.
- Failure mode: re-reading files already read - build on existing context.
- Failure mode: re-asking for permission already granted.
- Thinking budget: spend on genuine multi-step reasoning, not re-derivation.
</model_version_calibration>`;

export function buildKimiK26SisyphusPrompt(): string {
  return `${buildKimiSisyphusPrompt()}\n\n${CALIBRATION}`;
}