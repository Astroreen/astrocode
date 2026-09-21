import { buildClaudeSisyphusPrompt } from "../claude";

const CALIBRATION = `<model_version_calibration version="claude-opus-4-8">
- Stronger multi-step reasoning than 4-7: use it for architecture and subtle debugging, not for routine edits.
- Adaptive thinking: commit once the decisive fact is known; extra analysis is stalling.
- Long context: prefer targeted reads over dumping whole trees into context.
- Tool-call discipline: parallelize independent calls; sequence only true dependencies.
- Failure mode: over-delegation - do small local work yourself.
- Failure mode: over-verification - one evidence pass per gate, then stop.
</model_version_calibration>`;

export function buildClaudeOpus48SisyphusPrompt(): string {
  return `${buildClaudeSisyphusPrompt()}\n\n${CALIBRATION}`;
}