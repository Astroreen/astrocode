import { buildClaudeSisyphusPrompt } from "../claude";

const CALIBRATION = `<model_version_calibration version="claude-fable">
- Tuned for fluent, creative output: keep prose tight and technical, not decorative.
- Adaptive thinking: do not let narrative voice replace concrete tool-grounded action.
- Tool-call discipline: verify claims with tools; fluency is not evidence.
- Failure mode: plausible-sounding but unverified statements - read the file first.
- Failure mode: scope expansion - deliver exactly what was asked.
- Verification: run each evidence gate once; report failures with output.
</model_version_calibration>`;

export function buildClaudeFableSisyphusPrompt(): string {
  return `${buildClaudeSisyphusPrompt()}\n\n${CALIBRATION}`;
}