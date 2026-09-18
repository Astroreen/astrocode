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

- **A1: YES** — evidence: fresh primary-turn session `ses_f49f7cc57ffegFLSyFL30o441J` already had a non-empty `system` array before probe mutation; the main chat entry starts with `You are OpenCode, the best coding agent on the planet.` and the dumped `model.id` is non-empty (`claude-haiku-4-5`). This confirms mutate/pre-filled semantics.
- **A2: YES** — evidence: fresh parent task run used session `ses_f49f7b469ffeRmH37v1tLpO6pW`, while spawned `task(subagent_type="explore", ...)` entries appeared under distinct session `ses_f49f7a2ccffeEP39MQgNWz3Azs`; corrected acceptance command `jq '(.[0].sessionID) as $first | [.[] | select(.sessionID != $first)] | length' /tmp/astrocode-spike-dump.json` ran successfully and returned `5`.
- **A3: YES** — evidence: with native agent `SpikeNative.md` active, dumped `output.system[0]` starts with literal sentinel `ASTROCODE_NATIVE_AGENT_BODY_SENTINEL_A3`, followed by the agent body text, so native `.md` agent content is already present inside `output.system` when the hook fires.

## Root cause: modelID field bug

- Previous probe bug was **wrong field name in the probe**, not an opencode API limitation.
- `experimental.chat.system.transform` receives `input.model: Model`.
- `@opencode-ai/sdk/dist/gen/types.gen.d.ts` defines `Model` as:

```ts
export type Model = {
    id: string;
    providerID: string;
    api: {
        id: string;
        url: string;
        npm: string;
    };
    name: string;
    capabilities: { ... };
    ...
}
```

- Source evidence: `types.gen.d.ts` lines 1278-1287 show `id`, `providerID`, `api`, `name`, `capabilities`; there is **no `modelID` field** on `Model`.
- Fix applied: probe now writes `model: { providerID, id }` using `input.model.id`.
- Fresh dump proves this: main reply and explore-subagent entries now carry non-empty `model.id` such as `claude-haiku-4-5`.

## Locked conclusions

- Hook contract behavior locked: `output.system` uses **mutate/pre-filled** semantics.
- Guard reach locked from A2: guards injected via this hook **reach subagents too**, because the hook fires again for spawned `explore` sessions.
- Native-agent duplication risk is real: if plugin also injects persona-like text, it can duplicate `.md` agent content already present in `output.system`.

## Locked contract

```ts
getGuards(family: "claude" | "cheap-openrouter" | "fallback"): string[]
```

## Family-resolution note for Task 3

- `resolveFamily()` / future guard selection must inspect **`model.id`** and **`model.providerID`**.
- Do **not** use `model.modelID`; that field name was only the probe bug.
- AD-3 substring matching therefore keys off `model.id` (plus `providerID`), e.g. Claude vs cheap-openrouter vs fallback.

## Reproduction commands

```bash
XDG_CONFIG_HOME="/tmp/astrocode-spike-xdg" opencode run --auto -m anthropic/claude-haiku-4-5 "Reply with exactly: PRIMARY_OK"

XDG_CONFIG_HOME="/tmp/astrocode-spike-xdg" opencode run --auto --agent SpikeNative -m anthropic/claude-haiku-4-5 \
  "Delegate once using task(subagent_type=\"explore\", prompt=\"List the files in the current directory\") and then reply with exactly SUBAGENT_DONE."
```

## Corrected A2 acceptance command

Broken form in plan:

```bash
jq '[.[] | select(.sessionID != .[0].sessionID)] | length' /tmp/astrocode-spike-dump.json
```

Why broken:

- Inside `select(...)`, `.` is the current iterated object, so `.[0]` tries to index an object with numeric key `0`.
- That causes `jq: error: Cannot index object with number`.

Working form:

```bash
jq '(.[0].sessionID) as $first | [.[] | select(.sessionID != $first)] | length' /tmp/astrocode-spike-dump.json
```

Observed output on fresh dump:

```text
5
```

Meaning:

- There are 5 dump entries whose `sessionID` differs from the first primary session entry.
- That is non-zero, so A2 remains empirically confirmed.

## Evidence files

- Primary-turn dump excerpt: `.sisyphus/evidence/task-2-a1-dump.json`
- Parent/subagent dump excerpt + corrected jq evidence: `.sisyphus/evidence/task-2-a2-dump.json`
