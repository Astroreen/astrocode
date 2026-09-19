# astrocode

Minimal, stable, model-aware opencode plugin + agent personas.

A deliberately small alternative to `oh-my-openagent`/`oh-my-opencode`. It keeps the parts
that matter — custom agent personas and model-aware defensive prompting — and drops the
fragile heavy machinery (parallel/background orchestration, circuit-breakers, tmux, etc.).

## Status

Implemented and verified: plugin (`src/index.ts`), model router
(`src/models/resolveFamily.ts`), guards + dump side-channel (`src/prompts/*.ts`), all 11
persona `.md` files (`agents/`), `bun test` suite (34 tests), and a real-opencode-session
integration QA pass (see `docs/spike-findings.md`, `docs/fallback-spike-findings.md`,
`.sisyphus/evidence/task-8-*.json`).

## Architecture

**Hybrid design:**
- **Agent personas** ship as native opencode `.md` files (`agents/`). Stable: they work even if
  the experimental plugin hook changes or breaks on an opencode upgrade.
- **A thin plugin** (`src/index.ts`) adds the *dynamic* layer only: it appends model-family-specific
  defensive guard text via `experimental.chat.system.transform` and tunes sampling via `chat.params`.
  Both hooks mutate `output` in place (append-only — never wipes the base prompt or persona body
  opencode has already filled in) and are wrapped defensively: if the plugin-hook input/output
  shape ever changes, they log and no-op instead of crashing your session.

**Model families** (`src/models/resolveFamily.ts`): `claude` | `cheap-openrouter` | `fallback`.
Weak/cheap models (Deepseek, GLM, Kimi, Qwen, Minimax, Yi, Zhipu on OpenRouter) get more
defensive guards (`src/prompts/guards.ts`: an anti-tool-loop guard + explicit apply-patch
guidance, copied verbatim from oh-my-openagent's empirically-tuned text); Claude gets none;
any unrecognized/unknown model falls back to the most defensive guard set.

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
2. Make `agents/*.md` available to that project, either:
   - copied to the project's `.opencode/agents/`, or
   - copied to `~/.config/opencode/agents/` to make them available to every project (personas
     are model-agnostic — the plugin adds guard text at runtime, so sharing them globally is
     safe even though the plugin itself stays per-project).

### Per-agent model override

Each persona `.md` file's YAML frontmatter supports an optional `model:` field
(`$defs.AgentConfig.model` in the [official config schema](https://opencode.ai/config.json)),
e.g. `model: anthropic/claude-sonnet-4-6`. If omitted, the agent uses whatever model the calling
session/`opencode.jsonc` has configured. This is independent of the plugin — it works with or
without astrocode installed.

### Model-availability fallback (rate-limited / down / moderation-refused)

See `docs/fallback-spike-findings.md` for the full investigation. Summary — **Feasibility:
PARTIAL**:
- A plugin-hook-based automatic retry (detect model X failed, resubmit to model Y) is **not
  possible**: the `@opencode-ai/plugin` Hooks surface has no error/retry hook and no hook
  exposes `model` as a settable field.
- The **recommended practical path** is OpenRouter's own native `models: [...]` fallback array,
  configured directly in `opencode.jsonc` (no plugin code needed) — *unverified in this
  investigation whether opencode forwards the `options` field through to the request verbatim;
  test empirically before relying on it in production*:
  ```jsonc
  {
    "provider": {
      "openrouter": {
        "models": {
          "deepseek/deepseek-chat": {
            "options": { "models": ["z-ai/glm-4.6", "qwen/qwen-2.5-72b-instruct"] }
          }
        }
      }
    }
  }
  ```
- If that passthrough doesn't work, the only remaining lever is manually rotating the `model:`
  string per-agent when a provider is degraded.

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
shape change would silently stop guard injection until astrocode is updated to match.

### NixOS deployment (meridian-pattern)

astrocode is a standalone git repo, not a nix flake input — deploy it the same way as
`meridian.ts` (`home/modules/terminal/ai/meridian.nix`): clone/install it via `home.activation`,
then symlink/copy `agents/` into `~/.config/opencode/agents/`. Target file for this wiring:
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
    $DRY_RUN_CMD mkdir -p "$HOME/.config/opencode/agents"
    $DRY_RUN_CMD cp -f "$ASTROCODE_DIR"/agents/*.md "$HOME/.config/opencode/agents/"
  '';
}
```

Then, per-project, add the plugin entry (§ Deployment above) pointing at
`$HOME/.local/share/astrocode/src/index.ts`.

**Verify the wiring** with the standard home-manager dry-run before applying, on the machine
where you build your home configuration (referred to as the "home build laptop" in this repo's
planning docs) — e.g. `home-manager build --dry-run` (or your flake's equivalent, such as
`nix build .#homeConfigurations.<name>.activationPackage`) — before running the real
`home-manager switch` / `home build laptop` activation.

## Dev

```bash
bun install
bun test                 # 34 tests, all pass
bunx tsc --noEmit         # 0 errors
```

## Repo layout

- `src/index.ts` — plugin entry (`experimental.chat.system.transform` + `chat.params`)
- `src/models/resolveFamily.ts` — model -> family router
- `src/prompts/guards.ts` — verbatim defensive guard strings
- `src/prompts/dump.ts` — `ASTROCODE_DUMP` debug side-channel
- `agents/*.md` — native persona definitions
- `test/*.test.ts` — bun test suite
- `docs/spike-findings.md` — hook-semantics investigation (Task 2)
- `docs/fallback-spike-findings.md` — model-fallback feasibility investigation (Task 11)
