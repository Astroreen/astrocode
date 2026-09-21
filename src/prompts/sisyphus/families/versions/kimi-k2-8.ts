import { buildKimiSisyphusPrompt } from "../kimi";

const CALIBRATION = `<model_version_calibration version="kimi-k2-8">
- Terminal condition: act once the decisive fact is in hand; no extra analysis.
- Commitment: commit to a path; do not narrate rejected alternatives.
- Tool-call discipline: parallelize independent calls; never guess missing params.
- Failure mode: scope expansion - deliver the requested scope only.
- Failure mode: over-delegation - small local work is yours.
- Thinking budget: genuine multi-step reasoning only.
</model_version_calibration>`;

export function buildKimiK28SisyphusPrompt(): string {
  return `${buildKimiSisyphusPrompt()}\n\n${CALIBRATION}`;
}