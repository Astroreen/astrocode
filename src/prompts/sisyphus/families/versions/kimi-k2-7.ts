import { buildKimiSisyphusPrompt } from "../kimi";

const CALIBRATION = `<model_version_calibration version="kimi-k2-7">
- Terminal condition: stop at the decisive fact; additional analysis is stalling.
- Commitment: one path, committed; silent rejection of unused alternatives.
- Tool-call discipline: batch independent reads/searches in a single response.
- Failure mode: over-exploration - one exploration pass per question.
- Failure mode: confirmation turns treated as fresh investigations.
- Thinking budget: reserve for architecture and subtle debugging.
</model_version_calibration>`;

export function buildKimiK27SisyphusPrompt(): string {
  return `${buildKimiSisyphusPrompt()}\n\n${CALIBRATION}`;
}