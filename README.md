# astrocode

Minimal, stable, model-aware opencode plugin + agent personas.

A deliberately small alternative to `oh-my-openagent`/`oh-my-opencode`. It keeps the parts
that matter — custom agent personas and model-aware defensive prompting — and drops the
fragile heavy machinery (parallel/background orchestration, circuit-breakers, tmux, etc.).

## Status

Scaffold + work plan only. Implementation is executed by an AI agent via `/start-work`
against the plan in `.sisyphus/plans/astrocode-plugin.md`.

## Architecture (planned)

**Hybrid design:**
- **Agent personas** ship as native opencode `.md` files (`agents/`). Stable: they work even if
  the experimental plugin hook changes or breaks on an opencode upgrade.
- **A thin plugin** (`src/index.ts`) adds the *dynamic* layer only: it appends model-family-specific
  defensive guard text via `experimental.chat.system.transform` and tunes sampling via `chat.params`.

**Model families** (`src/models/resolveFamily.ts`): `claude` | `cheap-openrouter` | `fallback`.
Weak/cheap models (Deepseek, GLM, Kimi, Qwen, ...) get more defensive guards; Claude gets none;
unknown models fall back to the most defensive set.

## Why not just use oh-my-openagent?

It carries a huge surface (git_master, browser_automation, team_mode, tmux, ~5500 LOC
delegate-task) and has broken repeatedly (incl. self-breaking its config schema between
3.17.4 -> 4.19.4). astrocode covers ~20% of the surface for ~80% of the value.

## Deployment (planned)

Enabled **per-project**, never globally:
1. Reference `src/index.ts` in a project's `.opencode/opencode.jsonc` plugin array.
2. Make `agents/*.md` available (copied to `~/.config/opencode/agents/` or project `.opencode/agents/`).

NixOS: wire via the meridian-pattern (`home.activation` clone/install), mirroring
`home/modules/terminal/ai/meridian.nix`. Do NOT add to the global
`programs.opencode.settings.plugin` list. See the plan for the exact snippet.

## Dev

```bash
bun install
bun test
bunx tsc --noEmit
```
