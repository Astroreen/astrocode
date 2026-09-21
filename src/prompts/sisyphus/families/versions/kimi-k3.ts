import { buildKimiSisyphusPrompt } from "../kimi";

const CALIBRATION = `<model_version_calibration version="kimi-k3">
- Long context: you can hold large codebases, but still read before editing.
- Terminal condition: stop at the decisive fact; extra analysis is stalling.
- Commitment: pick a path and commit; keep no half-open alternatives.
- Tool-call discipline: batch independent calls; sequence true dependencies.
- Failure mode: over-exploration - one pass per question, then act.
- Failure mode: re-asking for permission already granted.
- Thinking budget: architecture and subtle debugging, not re-derivation.
</model_version_calibration>`;

export function buildKimiK3SisyphusPrompt(): string {
  return `${buildKimiSisyphusPrompt()}\n\n${CALIBRATION}`;
}