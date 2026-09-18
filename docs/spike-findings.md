# Spike findings: `experimental.chat.system.transform`

## Probe setup

- Probe source: `spike/probe-system-transform.js`
- Scratch project: `/tmp/astrocode-spike-scratch`
- Scratch config: `.opencode/opencode.jsonc` with:
  - `file:///home/astroreen/Documents/opencode/astrocode/spike/probe-system-transform.js`
  - `opencode-claude-auth`
- Model used for real runs: `anthropic/claude-haiku-4-5`
- Dump path: `/tmp/astrocode-spike-dump.json`

## Answers

- **A1: YES** — evidence: `/tmp/astrocode-spike-dump.json` primary-turn entry for session `ses_f4a01d419fferiXOF1iRheLAlI` already contains a non-empty `system` array before probe mutation; the main chat entry starts with `You are OpenCode, the best coding agent on the planet.` and `jq '.[0].system | length'`/inspection shows length `1`, so hook sees prefilled content (mutate semantics, not replace).
- **A2: YES** — evidence: the parent task run used session `ses_f4a0190e8ffezLl1HXwPjXKU1i`, while the spawned `task(subagent_type="explore", ...)` produced dump entries under different session `ses_f4a017f62ffeAi9o3P3PrCMaBN`; `task` tool metadata in `/tmp/astrocode-spike-run2.jsonl` also reports `parentSessionId: ses_f4a0190e8ffezLl1HXwPjXKU1i` and `sessionId: ses_f4a017f62ffeAi9o3P3PrCMaBN`.
- **A3: YES** — evidence: with native agent `SpikeNative.md` active, the dumped `output.system[0]` begins with literal sentinel `ASTROCODE_NATIVE_AGENT_BODY_SENTINEL_A3` followed by the rest of the agent body text, so native `.md` agent content is already present inside `output.system` when the hook fires.

## Locked conclusions

- Hook contract behavior locked: `output.system` uses **mutate/pre-filled** semantics.
- Guard reach locked from A2: guards injected via this hook **will reach subagents** too, because the hook fires again for spawned `explore` sessions.
- Native-agent duplication risk is real: if plugin also injects persona-like text, it can duplicate `.md` agent content already present in `output.system`.

## Locked contract

```ts
getGuards(family: "claude" | "cheap-openrouter" | "fallback"): string[]
```

## Reproduction commands

```bash
XDG_CONFIG_HOME="/tmp/astrocode-spike-xdg" opencode run --auto -m anthropic/claude-haiku-4-5 "Reply with exactly: PRIMARY_OK"

XDG_CONFIG_HOME="/tmp/astrocode-spike-xdg" opencode run --auto --agent SpikeNative -m anthropic/claude-haiku-4-5 \
  "Delegate once using task(subagent_type=\"explore\", prompt=\"List the files in the current directory\") and then reply with exactly SUBAGENT_DONE."
```

## Evidence files

- Primary-turn dump excerpt: `.sisyphus/evidence/task-2-a1-dump.json`
- Parent/subagent dump excerpt: `.sisyphus/evidence/task-2-a2-dump.json`
