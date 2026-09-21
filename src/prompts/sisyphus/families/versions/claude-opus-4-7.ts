import { buildClaudeSisyphusPrompt } from "../claude";

const CALIBRATION = `<model_version_calibration version="claude-opus-4-7">
- Adaptive thinking: scale reasoning to task difficulty; do not over-think trivial edits.
- Long context: you can hold many files, but still read before editing - never assume.
- Tool-call discipline: batch independent reads/searches in one response; never guess params.
- Failure mode: literal following of "all/every" - apply to EVERY case, not the first.
- Failure mode: scope expansion - deliver exactly the requested scope.
- Verification: run each evidence gate once; do not re-run green suites.
</model_version_calibration>`;

export function buildClaudeOpus47SisyphusPrompt(): string {
  return `${buildClaudeSisyphusPrompt()}\n\n${CALIBRATION}`;
}