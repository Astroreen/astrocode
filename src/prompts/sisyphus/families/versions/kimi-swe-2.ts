import { buildKimiSisyphusPrompt } from "../kimi";

const CALIBRATION = `<model_version_calibration version="kimi-swe-2">
- Software-engineering tuned: favor concrete code changes over prose.
- Terminal condition: once the fix is clear, implement it - stop analyzing.
- Commitment: one approach, committed; diagnose before retrying.
- Tool-call discipline: batch independent reads; verify with real tool output.
- Failure mode: shotgun debugging - fix root causes, not symptoms.
- Failure mode: leaving code broken - revert to last known working state.
</model_version_calibration>`;

export function buildKimiSwe2SisyphusPrompt(): string {
  return `${buildKimiSisyphusPrompt()}\n\n${CALIBRATION}`;
}