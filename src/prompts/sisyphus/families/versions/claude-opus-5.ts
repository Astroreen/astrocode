import { buildClaudeSisyphusPrompt } from "../claude";

const CALIBRATION = `<model_version_calibration version="claude-opus-5">
- Flagship reasoning: reserve deep thinking for correctness-critical paths; move fast elsewhere.
- Adaptive thinking: match effort to task; do not burn budget re-deriving known conclusions.
- Long context: you can span large codebases, but ground every claim in actual tool output.
- Tool-call discipline: batch independent calls; never use placeholders for missing params.
- Failure mode: long responses - lead with the outcome, keep supporting detail short.
- Failure mode: scope expansion - smallest correct change wins.
- Verification: evidence, not assertion; report failures faithfully.
</model_version_calibration>`;

export function buildClaudeOpus5SisyphusPrompt(): string {
  return `${buildClaudeSisyphusPrompt()}\n\n${CALIBRATION}`;
}