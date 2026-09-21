# astrocode ↔ oh-my-openagent parity

Fact-check of how close astrocode is to `oh-my-openagent` **for the features astrocode ships**.
Deliberately-omitted systems (team-mode, categories, parallel/background orchestration, tmux,
git_master, browser_automation) are listed at the end and are out of scope by design.

Source of truth for oh-my internals: `~/.cache/opencode/node_modules/oh-my-openagent/dist/index.js`
(source-marker comments preserved in the bundle).

Legend: ✅ same behavior · 🟡 adapted/equivalent-but-different · ❌ not implemented.

## Dynamic prompt engine

| Aspect | oh-my-openagent | astrocode | Status |
|---|---|---|---|
| Injection granularity | one builder per model version (opus-4-7/4-8/5, gpt-5-4/5-5, kimi-k2-6/2-7/k3, glm-5-2, gemini, default) | one builder per **family** (claude/gpt/gemini/kimi/glm/fallback) **plus** version-level builders (`families/versions/*.ts`, `VERSION_BUILDERS`) layered on top when `resolveModelVersion` matches | 🟡 |
| Detection | agent factory knows the agent | marker scan of `output.system` (hook has no `agent` field) | 🟡 |
| Shared skeleton | ~914 LOC across 12 files, driven by runtime `availableAgents`/`Tools`/`Skills`/`Categories` | `src/prompts/sisyphus/sections.ts` driven by static `src/agents/metadata.ts` | 🟡 |
| Option C hybrid | regenerates and swaps the baked prompt in `system` (`sisyphus-runtime-prompt-reconciler`) | static `agents/sisyphus.md` baseline + appended runtime delta | 🟡 |
| Per-family calibration | full per-version self-knowledge blocks | family-level calibration blocks + a `<model_version_calibration>` block appended by the version builder (13 versions: claude-opus-4-7/4-8/5, claude-fable/mythos, kimi-k2-6/7/8, kimi-k3, kimi-swe-2, grok-4-5/4-6, minimax) | 🟡 |
| Gemini handling | fallback prompt + 5 spliced override blocks | fallback prompt + 5 appended override blocks | ✅ |
| `load_skills` | real `task` param | prompt convention (name skill in CONTEXT; subagent self-loads) | 🟡 |
| categories | category-based routing + `.model` defaults | dropped; per-agent `model` via astrocode.jsonc | ❌ (intentional) |
| frontier tool-schema guard | denies native `grep`/`glob` for Opus-4.7+/GPT-5.5/5.6 | not implemented | ❌ |

## Agent roster

| Aspect | oh-my-openagent | astrocode | Status |
|---|---|---|---|
| Display names | `Sisyphus - ultraworker`, `Hephaestus - Deep Agent`, `Prometheus - Plan Builder`, `Atlas - Plan Executor`, `Sisyphus-Junior`, `Metis - Plan Consultant`, `Momus - Plan Critic`; `oracle`/`librarian`/`explore`/`multimodal-looker` lowercase | identical map (`src/agents/personas.ts` `AGENT_DISPLAY_NAMES`) | ✅ |
| Config keys | remapped to display names | remapped to display names | ✅ |
| Default agent | `default_agent = "Sisyphus - ultraworker"` | same | ✅ |
| `build` / `plan` | demoted to `{mode:"subagent", hidden:true}` | demoted to `{mode:"subagent", hidden:true}` | ✅ |
| Per-agent color | one hex per agent | `DEFAULT_COLORS` + astrocode.jsonc override | ✅ |
| Per-agent model | `agent.<name>.model` | astrocode.jsonc `agents.<name>.model` | ✅ |
| Per-agent fallback | `fallback_models` | astrocode.jsonc `agents.<name>.fallback_models` | ✅ |
| Extra agents | athena, athena-junior, council-member, per-model momus/hephaestus variants | not implemented — oh-my ships no prompt/factory for athena/council (team-mode-owned), and per-model variants contradict family-level decision #1 | ❌ (intentional) |
| Thinking/reasoning config | claude extended-thinking config; gpt `reasoningEffort:"medium"` | `reasoningConfigForFamily()` merged into every agent config (`thinking: {type:"enabled", budgetTokens:32000}` for claude, `reasoningEffort:"medium"` for gpt); toggle via `reasoning.enabled` | ✅ |

## Model fallback

| Aspect | oh-my-openagent | astrocode | Status |
|---|---|---|---|
| Trigger | `message.updated` error parts + first-prompt watchdog + `session.error` | `session.error` + `message.updated` assistant `.error` + `session.status` type `retry` (proactive, before opencode gives up). Pre-flight `ProviderModelNotFoundError` (bad model id) happens before any event and cannot be caught — documented gap | 🟡 |
| Classifier | ~25 regexes + status codes + abort/context-overflow vetoes | same pattern list (incl. Chinese variants), **but a retryable message wins even on `MessageAbortedError`** and `isRetryable:false` no longer vetoes; `classifyError` adds `terminal_quota` (rotate immediately) vs `non_terminal` (one bounded same-model retry first) vs `context_overflow`/`not_retryable` | ✅/🟡 |
| Resubmission | `client.session.prompt` with retry payload | `client.session.prompt` (same session, preserved history), abort+retry once on failure | ✅ |
| Chain resolution | category → agent → plan→prometheus inheritance → sessionID agent-pattern | per-agent `fallback_models` (display or canonical key) → global `models` | 🟡 |
| Canonicalization | `canonicalizeRuntimeFallbackModelID` + `areRuntimeFallbackModelsEquivalent` | `canonicalizeModelID` (strips `-thinking`/`-max`/`-high` for claude-opus/sonnet/haiku, normalizes dotted versions) + `areModelsEquivalent`; `pickFallbackModel` never switches to a suffix-variant of the just-failed model | ✅ |
| State | multiple Maps + timeouts + cooldown + restore-primary-after-cooldown | in-memory attempts/cooldown, one retry in flight per session; `effectiveCooldownSeconds` doubles the cooldown per consecutive failure (capped 2^5); `sameModelRetried` bounds the one same-model retry | 🟡 |
| Synthetic note | visible assistant response | synthetic text part "[astrocode fallback] …" (skipped on re-collection) | 🟡 |
| Context preservation | server-side history | server-side history (same mechanism) | ✅ |
| Subagent sessions | delegated-child bootstrap | agent + model read from the child session's last user message | 🟡 |

## Commands

| Command | oh-my-openagent | astrocode | Status |
|---|---|---|---|
| `goal` | goal + idle auto-continuation + `update_goal` | goal tracked via todos; auto-continuation commented out | 🟡 |
| `refactor` | 4 sections, category/skills syntax | adapted to real tool surface | 🟡 |
| `start-work` | boulder.json + worktree + PR modes | atlas (`subtask:false`), `.sisyphus/plans/`, git flow | 🟡 |
| `stop-continuation` | stops enforcer/Ralph/goal/boulder | no-op (nothing auto-continues) | ❌ (documented) |
| `remove-ai-slops` | per-file slop squad + team addendum | per-file removal + critical review, team addendum commented | 🟡 |
| `handoff` | `session_read` + git | conversation + `todoread` + git | 🟡 |
| `hyperplan` | team-mode adversarial planning | single-agent adversarial fallback | 🟡 |
| Injection | spread into `config.command` | spread into `config.command` (user commands win) | ✅ |

## Other

| Aspect | oh-my-openagent | astrocode | Status |
|---|---|---|---|
| Guard strings (`TOOL_LOOP_GUARD`, `APPLY_PATCH_GUIDANCE`) | shipped verbatim | same verbatim text, appended per family | ✅ |
| Cheap-model sampling (`temperature`/`topP`) | capability engine (`chat-params.ts`) reconciling per-model settings | `chat.params` resolves a per-family map (defaults kimi/glm/openrouter-generic 0.3/0.9; override via `sampling.<family>`) | 🟡 |
| Skills priority | builtin vs custom (`location`) + own skills loader | native opencode loader; `skills.extraDirs` symlinks legacy skill dirs into `~/.config/opencode/skills`; `standardSkillSources` assigns explicit numeric priorities (project 60/50/40, user 30/20/10, bundled builtin 5) and `discoverSkillsWithPriority` keeps the highest-priority definition (collision logged); bundled `skills/builtin/{commit-message,code-review,verify-before-done}` always discoverable at the lowest tier; discovered skills are also registered as slash commands (opencode itself does not) | 🟡 |
| Todo system | TodoWrite or TaskCreate toggle | `todowrite` only | 🟡 |
| Idle continuation | hook-injected continuation | opt-in `idleContinuation`, driven by `session.idle` + `session.todo`, capped per session, continues on the fallback model if one was used; exponential cooldown (`CONTINUATION_COOLDOWN_MS` doubling, capped at `MAX_BACKOFF_EXPONENT`) + `MAX_CONSECUTIVE_FAILURES` cap (reset after `FAILURE_RESET_WINDOW_MS`); a user abort (`MessageAbortedError`/`AbortError`) suppresses continuation for `ABORT_WINDOW_MS` (3s) | 🟡 |
| Environment/date context | injected for librarian (and builtin agents) | `<omo-env>` (timezone/locale/today) appended for every agent via system transform | ✅ |
| AGENTS.md directory context | not a distinct feature | `findAgentsMdFiles` walks up to home (nearest-first, max 5) and `buildAgentsMdContext` injects `[Directory Context: <path>]` blocks (8000-char cap) once per session via the system transform | 🟡 |
| Reasoning-level ladder | per-model capability engine | `REASONING_LEVELS` (off/minimal/low/medium/high/xhigh/max) + `isReasoningLevel`/`clampReasoningLevel`; `splitReasoningSuffix` parses a trailing `:level`/`:auto` model suffix; `reasoningConfigForFamily(family, level?)` maps it onto claude thinking / gpt `reasoningEffort` | 🟡 |
| Config file | its own schema | dedicated `.opencode/astrocode.jsonc`; `collectConfigLayers`/`mergeConfigLayers` walk up to home and merge layers nearest-wins (arrays full-replace, `agents` merged per agent) | ✅ |

## Deliberately dropped (out of scope by design)

team-mode (`team_*`), categories, parallel/background agents (`run_in_background`,
`background_output`, `background_cancel`, `bg_*`), tmux (`interactive_bash`), git_master,
browser_automation, circuit-breakers, boulder/worktree/PR state, per-model-version prompt forks.
Athena/council agents are not included at all (oh-my ships no prompt for them; they belong to
team-mode, so registering bare names would create unusable agents).

## astrocode.jsonc options

| Key | Meaning |
|---|---|
| `model` | global default model for agents without their own `model` (also drives reasoning options) |
| `agents.<name>` | `{ model, fallback_models, color }` — per-agent; name may be canonical or display form |
| `fallback` | `{ enabled, retry_on_errors, max_attempts, cooldown_seconds, models, agents }` |
| `sampling` | per-family `{ temperature, topP }` overrides (defaults for kimi/glm/openrouter-generic) |
| `skills.extraDirs` | directories whose `<name>/SKILL.md` subdirs are symlinked into `~/.config/opencode/skills` |
| `idleContinuation` | `{ enabled, max }` — continue idle sessions with unfinished todos |
| `reasoning` | `{ enabled }` — claude extended thinking / gpt reasoningEffort |
