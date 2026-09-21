import { buildClaudeSisyphusPrompt } from "../claude";

const CALIBRATION = `<model_version_calibration version="claude-mythos">
- Experimental/preview build: behavior may drift between snapshots - verify against real output.
- Adaptive thinking: prefer explicit, checkable steps over implicit leaps.
- Long context: still read before editing; never speculate about unread code.
- Tool-call discipline: batch independent calls; sequence dependent ones.
- Failure mode: confident hallucination - ground every claim in tool output.
- Verification: one evidence pass per gate; report faithfully.
</model_version_calibration>`;

export function buildClaudeMythosSisyphusPrompt(): string {
  return `${buildClaudeSisyphusPrompt()}\n\n${CALIBRATION}`;
}