import { buildFallbackSisyphusPrompt } from "../fallback";

const CALIBRATION = `<model_version_calibration version="grok-4-5">
- Tool-call discipline: emit well-formed calls; never guess missing parameters.
- Parallelize independent calls; sequence only true dependencies.
- Failure mode: terse-but-incomplete answers - cover the full requested scope.
- Failure mode: skipping verification - ground claims in actual tool output.
- Read before editing; never speculate about unread code.
- Run each evidence gate once, then stop.
</model_version_calibration>`;

export function buildGrok45SisyphusPrompt(): string {
  return `${buildFallbackSisyphusPrompt()}\n\n${CALIBRATION}`;
}