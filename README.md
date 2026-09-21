# astrocode

Minimal, stable, model-aware opencode plugin + agent personas.

A deliberately small alternative to `oh-my-openagent`/`oh-my-opencode`. It keeps the parts
that matter — custom agent personas, model-aware defensive prompting, and the dynamic
per-model prompt engine — and drops the fragile heavy machinery (team-mode,
parallel/background orchestration, tmux, git_master, browser_automation, categories).

## Status

Implemented and verified (`bun test`: 103 tests pass, `tsc --noEmit`: 0 errors):

- plugin entry (`src/index.ts`) — guards, Sisyphus dynamic-prompt dispatch, sampling,
  builtin-command injection, runtime model fallback
- model router (`src/models/resolveFamily.ts`) — 7 families
- guards + dump side-channel (`src/prompts/*.ts`)
- dynamic Sisyphus prompt engine (`src/prompts/sisyphus/**`, `src/agents/metadata.ts`)
- agent personas (`agents/*.md`, 11 shipped + `plan`/`build` overrides)
- runtime model fallback (`src/fallback/**`)
- 7 builtin commands (`src/commands/index.ts`)

## Architecture

**Hybrid design:**

- **Agent personas** ship as native opencode `.md` files (`agents/`). Stable: they work even
  if the experimental plugin hook changes or breaks on an opencode upgrade.
- **A thin plugin** (`src/index.ts`) adds the *dynamic* layer: model-family guard text,
  family-specific Sisyphus prompt generation, sampling tweaks, builtin-command injection, and
  automatic model fallback. Every hook mutates `output` in place (append-only — never wipes the
  base prompt or persona body opencode has already filled in) and is wrapped defensively: if a
  hook input/output shape ever changes, it logs and no-ops instead of crashing the session.

### Model families

`src/models/resolveFamily.ts` returns one of seven families by `modelID` substring (no provider
gate):

`claude` | `gpt` | `gemini` | `kimi` | `glm` | `openrouter-generic` | `fallback`

`claude` gets no extra guards; the other six get an anti-tool-loop guard + apply-patch guidance
(copied verbatim from oh-my-openagent's empirically-tuned text). `kimi`/`glm`/`openrouter-generic`
additionally get a sampling override (`temperature=0.3`, `topP=0.9`) via `isCheapSamplingFamily`.

### Dynamic Sisyphus prompt engine

This is the biggest feature and the closest thing to oh-my-openagent's core value. When the
active persona is Sisyphus, the plugin generates a family-specific behavioral prompt at runtime
and appends it to the system prompt. It is *not* a static string: the agent-facing sections
(Key Triggers, Agent Selection Table, Delegation Triggers, Explore/Librarian/Oracle usage) are
built live from `src/agents/metadata.ts`, so they stay accurate as the agent roster evolves.

- **Detection**: `experimental.chat.system.transform` has no `agent` field, so Sisyphus is
  detected by scanning `output.system` for the marker `"You are Sisyphus - the Master
  Orchestrator."` (`src/prompts/sisyphus/dispatch.ts`).
- **Shared skeleton**: `src/prompts/sisyphus/sections.ts` — family-agnostic section builders.
- **Family builders**: `src/prompts/sisyphus/families/{claude,gpt,glm,kimi,fallback,gemini}.ts`.
  Gemini is not a standalone persona: it reuses the fallback prompt plus Gemini-specific
  override blocks.
- **Option C hybrid** (see `docs/porting-plan.md`): `agents/sisyphus.md` stays as the static
  baseline persona; the plugin only appends the runtime-computed delta.

### Runtime model fallback

`src/fallback/` implements real mid-task model switching. On a retryable `session.error`
(rate limit, quota, 5xx, overloaded, …), the plugin resubmits the last user turn on the same
session with the next configured fallback model — full conversation history is preserved
server-side by opencode, so the new model continues rather than restarting. See
`docs/porting-plan.md` § "Fallback module design".

astrocode keeps its settings in its **own config file**, `astrocode.jsonc`, which the plugin
loads itself (searched in the project root and `.opencode/`) — you do not need to put anything
astrocode-specific in `opencode.jsonc`:

```jsonc
// astrocode.jsonc
{
  "agents": {
    // Optional per-agent default model + its own fallback chain + color.
    "sisyphus": {
      "model": "anthropic/claude-sonnet-4-6",
      "fallback_models": ["openrouter/~deepseek/deepseek-flash-latest"],
      "color": "#00CED1"
    },
    "oracle": {
      "model": "anthropic/claude-opus-4-6",
      "fallback_models": ["openrouter/~deepseek/deepseek-flash-latest"]
    }
  },
  "fallback": {
    "enabled": true,
    "retry_on_errors": [429, 500, 502, 503, 504],
    "max_attempts": 3,
    "cooldown_seconds": 60,
    // Global chain, used by every agent without its own fallback_models.
    "models": ["openrouter/~deepseek/deepseek-flash-latest"]
  },
  // Optional extras:
  "sampling": { "claude": { "temperature": 0.4, "topP": 0.8 } },
  "skills": { "extraDirs": ["/home/you/.cache/opencode/skills"] },
  "idleContinuation": { "enabled": false, "max": 3 },
  "reasoning": { "enabled": true }
}
```

A per-agent `fallback_models` list fully replaces the global chain for that agent (no merge).
Inline plugin options (the second tuple element in `opencode.jsonc`) are still honored and
override the file.

Why fallback fires: on a retryable provider error (rate limit, quota, usage limit, credits,
5xx, overloaded), astrocode resubmits the last user turn on the same session with the next
chain model. opencode surfaces such failures as `session.error`, as a `message.updated` on an
errored assistant message, **or** as a `session.status` retry (opencode's own same-model retry
loop) — astrocode handles all three, switching models proactively on the retry event.

**Known gap:** a pre-flight `ProviderModelNotFoundError` (a model id that does not exist) is
raised by opencode before any assistant message/event is created, so no event fires and
fallback cannot run. Verify model ids before relying on them.

### Model tuning and extras

- **Reasoning/thinking** (`src/models/tuning.ts`): every agent whose family resolves to claude
  gets `thinking: { type: "enabled", budgetTokens: 32000 }`; gpt gets `reasoningEffort: "medium"`.
  Toggle with `reasoning.enabled`.
- **Sampling**: per-family `temperature`/`topP` map. Defaults keep kimi/glm/openrouter-generic at
  0.3/0.9; override or extend via `sampling.<family>`.
- **Environment/date context** (`src/env/context.ts`): a `<omo-env>` block (timezone, locale,
  today) is appended to every agent's system prompt, mirroring oh-my's `applyEnvironmentContext`.
- **Extra skills** (`src/skills/extra.ts`): opencode's native skill loader only scans specific
  dirs, so skills left behind in oh-my's `~/.cache/opencode/skills` stop working. List such dirs
  in `skills.extraDirs`; each `<name>/SKILL.md` subdir is symlinked into
  `~/.config/opencode/skills` (never overwrites).
- **Skills as slash commands** (`src/skills/extra.ts`): opencode registers skills for the model's
  `skill` tool but does *not* expose them as commands, so `/caveman` etc. appear "missing" in the
  UI. astrocode scans the standard skill dirs and registers a thin `/<skill-name>` command for
  each discovered skill (never clobbers an existing command); invoking it tells the model to load
  that skill via its own tool.
- **Idle continuation** (`src/idle/continue.ts`): opt-in. On `session.idle`, if the session has
  unfinished todos, a short continuation prompt is sent on the same session (on the fallback
  model if one was already used), capped per session.

### Builtin commands

`src/commands/index.ts` ports oh-my-openagent's 7 builtin commands, adapted to astrocode's real
tool surface and injected via the plugin's `config` hook (existing user commands with the same
name win):

`/goal`, `/refactor`, `/start-work`, `/stop-continuation`, `/remove-ai-slops`, `/handoff`,
`/hyperplan`.

Team-mode / Codex-harness sections are preserved as HTML comments (never deleted), per
`docs/porting-plan.md` decision #2. `/hyperplan` runs a single-agent adversarial fallback since
team-mode is not implemented.

### Agent roster, colors, and `plan` / `build` overrides

The plugin **owns the agent roster**: at startup it reads the shipped `agents/*.md` and injects
them via the `config` hook, so a project needs only the plugin entry — there is no copying or
symlinking personas into `.opencode/agents/`. Every agent gets a distinct color (oh-my style,
see `DEFAULT_COLORS` in `src/agents/personas.ts`), overridable per agent in `astrocode.jsonc`.

Agents are registered under the **same display names as oh-my-openagent** (matching the TAB
switcher), and `default_agent` is set to Sisyphus:

| canonical key | display name (config key) | color |
|---|---|---|
| `sisyphus` | `Sisyphus - ultraworker` | `#00CED1` |
| `hephaestus` | `Hephaestus - Deep Agent` | `#FF6B35` |
| `prometheus` | `Prometheus - Plan Builder` | `#9B59B6` |
| `atlas` | `Atlas - Plan Executor` | `#3498DB` |
| `sisyphus-junior` | `Sisyphus-Junior` | `#16A085` |
| `metis` | `Metis - Plan Consultant` | `#F1C40F` |
| `momus` | `Momus - Plan Critic` | `#E67E22` |
| `oracle` | `oracle` | `#E74C3C` |
| `explore` | `explore` | `#2ECC71` |
| `librarian` | `librarian` | `#1ABC9C` |
| `multimodal-looker` | `multimodal-looker` | `#E91E63` |

opencode's builtin primary agents are replaced/demoted, exactly like oh-my-openagent:

- `build` → demoted to a **hidden subagent** (`mode: "subagent"`, `hidden: true`); the Sisyphus
  persona takes over its role as the default primary agent.
- `plan` → demoted the same way; **Prometheus** (`Prometheus - Plan Builder`) is the planner,
  with `edit` denied and plans written to `.sisyphus/plans/`.

`astrocode.jsonc` agent keys may be either the canonical name or the display name.

## Why not just use oh-my-openagent?

It carries a huge surface (git_master, browser_automation, team_mode, tmux, ~5500 LOC
delegate-task) and has broken repeatedly (incl. self-breaking its config schema between
3.17.4 -> 4.19.4). astrocode covers ~20% of the surface for ~80% of the value.

## Deployment

Enabled **per-project**, never globally (do NOT add this to the global
`programs.opencode.settings.plugin` list):

1. In the target project's `.opencode/opencode.jsonc`, reference the plugin entry point:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["file:///absolute/path/to/astrocode/src/index.ts"]
   }
   ```
   opencode runs plugin TypeScript entries directly via Bun — no build step required.
2. That's it — the plugin injects its own personas and commands. Optionally add
   `astrocode.jsonc` (see above) for per-agent models, fallback chains, and colors.

### `/start-work` switches to Atlas

The builtin `/start-work` command is injected with `agent: "Atlas - Plan Executor"` and
`subtask: false`, so it switches the session to Atlas (rather than running as a subagent).

### Per-agent model override

Set `agents.<name>.model` in `astrocode.jsonc` (see the config example above). If omitted, the
agent uses whatever model the calling session/`opencode.jsonc` has configured. Subagents get
their own agent-config `model` if set, otherwise the primary agent's model. Per-agent
`fallback_models` apply to subagent sessions too — the fallback dispatcher reads the child
session's agent name from its last user message.

### Environment variables

- `ASTROCODE_DUMP` — debug side-channel (`src/prompts/dump.ts`). Unset/falsy: no-op (default,
  zero overhead). `1` or `true`: append one JSON line per hook invocation to
  `/tmp/astrocode-prompt-dump.json`. Any other value: treated as a literal file path to append
  to instead. Useful for verifying which guards were injected for a given session/model —
  inspect with `jq`.

### Version-pin caveat

`experimental.chat.system.transform` and `experimental.chat.params` are **experimental**
opencode plugin hooks — the API surface can change between opencode releases without notice.
Pin your opencode version in nix when deploying astrocode. The plugin degrades gracefully (logs
and no-ops) rather than crashing your session if the hook input/output shape changes, but a
shape change would silently stop injection until astrocode is updated to match.

### NixOS deployment (meridian-pattern)

astrocode is a standalone git repo, not a nix flake input — deploy it the same way as
`meridian.ts` (`home/modules/terminal/ai/meridian.nix`): clone/install it via `home.activation`.
No agent copying is needed — the plugin injects its own personas. Target file for this wiring:
`home/modules/terminal/ai/astrocode.nix`, imported alongside the existing `meridian.nix` import.

Example snippet (adapt paths/repo URL to match your actual `meridian.nix` conventions):

```nix
# home/modules/terminal/ai/astrocode.nix
{ config, lib, pkgs, ... }:
{
  home.activation.astrocodeInstall = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ASTROCODE_DIR="$HOME/.local/share/astrocode"
    if [ ! -d "$ASTROCODE_DIR/.git" ]; then
      $DRY_RUN_CMD ${pkgs.git}/bin/git clone \
        "https://github.com/Astroreen/astrocode.git" "$ASTROCODE_DIR"
    else
      $DRY_RUN_CMD ${pkgs.git}/bin/git -C "$ASTROCODE_DIR" pull --ff-only
    fi
  '';
}
```

Then, per-project, add the plugin entry (§ Deployment above) pointing at
`$HOME/.local/share/astrocode/src/index.ts`.

**Verify the wiring** with the standard home-manager dry-run before applying on the build
machine — e.g. `home-manager build --dry-run` (or your flake's equivalent, such as
`nix build .#homeConfigurations.<name>.activationPackage`) — before running the real
`home-manager switch` activation.

## Dev

```bash
bun install
bun test                 # 103 tests, all pass
bun run tsc --noEmit     # 0 errors
```

## Repo layout

- `src/index.ts` — plugin entry (system transform, chat.params, config, event, dispose)
- `src/models/resolveFamily.ts` — model -> family router (7 families)
- `src/prompts/guards.ts` — verbatim defensive guard strings
- `src/prompts/dump.ts` — `ASTROCODE_DUMP` debug side-channel
- `src/prompts/sisyphus/` — dynamic prompt engine (`sections.ts`, `dispatch.ts`, `families/`)
- `src/agents/personas.ts` — reads `agents/*.md`, injects the agent roster under oh-my display
  names with colors; computes `default_agent` and the demoted `build`/`plan` agents
- `src/config/astrocode.ts` — loads the dedicated `astrocode.jsonc` (JSONC-aware)
- `src/models/tuning.ts` — per-family reasoning/thinking + sampling options
- `src/env/context.ts` — `<omo-env>` timezone/locale/date context
- `src/skills/extra.ts` — bridges extra skill dirs into opencode's native skills dir
- `src/idle/continue.ts` — opt-in idle continuation
- `src/agents/metadata.ts` — agent behavioral metadata driving the dynamic sections
- `src/fallback/` — runtime model fallback (config, classify, state, orchestrator)
- `src/commands/index.ts` — 7 ported builtin commands
- `agents/*.md` — native persona definitions (plugin-injected)
- `test/*.test.ts` — bun test suite
- `docs/oh-my-parity.md` — fact-checked parity table vs oh-my-openagent
- `docs/plugin-test-prompt.md` — copy-paste prompt that exercises every shipped feature
- `docs/porting-plan.md` — authoritative porting plan + locked decisions
- `docs/spike-findings.md` — hook-semantics investigation
- `docs/fallback-spike-findings.md` — early fallback feasibility investigation (superseded —
  see `docs/porting-plan.md` "Fallback module design")