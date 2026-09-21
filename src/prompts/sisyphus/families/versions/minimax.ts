import { buildFallbackSisyphusPrompt } from "../fallback";

const CALIBRATION = `<model_version_calibration version="minimax">
- Tool-call discipline: keep calls simple and well-formed; batch independent ones.
- Failure mode: verbose output - lead with the outcome, trim supporting detail.
- Failure mode: incomplete scope - apply "all/every" to EVERY case.
- Read before editing; never speculate about unread code.
- Delegate only for matching specialist domains or sizeable independent tracks.
- Run each evidence gate once, then stop.
</model_version_calibration>`;

export function buildMinimaxSisyphusPrompt(): string {
  return `${buildFallbackSisyphusPrompt()}\n\n${CALIBRATION}`;
}