# Porting plan: oh-my-openagent → astrocode

Consolidated findings + locked decisions for the current work: (1) port 7 builtin commands,
(2) real mid-task model fallback, (3) full dynamic per-family prompt engine for Sisyphus,
(4) broaden model-family taxonomy beyond claude/cheap-openrouter/fallback.

Source: `~/.cache/opencode/node_modules/oh-my-openagent/dist/index.js` (177998 lines, bundled
but not minified, source-marker comments `// packages/<pkg>/src/<path>.ts` before each module).
Extraction workspace: `/tmp/astrocode-extract/` (ephemeral, re-extract via `sed -n 'X,Yp'` using
line ranges below if lost).

## Locked decisions

1. **Prompt injection granularity: family-level**, not per-model-version. One prompt builder per
   family using the most complete/recent version file as representative (no claude-opus-4-7 vs
   -4-8 vs -5 forks, no gpt-5-4 vs -5-5 forks, no kimi-k2-6 vs -k2-7 vs -k3 forks).
2. **Team-mode/parallel/tmux sections in ported commands: keep as HTML-commented markdown**,
   never delete outright (`<!-- team-mode section, not implemented in astrocode: ... -->`).
3. **Fallback config: flat, no categories.**
   `{ fallback: { enabled, retry_on_errors:number[], max_attempts, cooldown_seconds,
   models:string[] (global chain), agents:{<name>:{models:string[]}} (full replace, no merge) } }`.
   No oh-my-openagent "categories" concept, no `plan`-inherits-`prometheus` quirk.
4. **Dynamic prompt engine: full port (option 1)**, not a static snapshot. User's call: astrocode's
   README "drop heavy machinery" phrase was about parallelism/orchestration specifically (buggiest,
   hardest part) — NOT about the dynamic-prompt system, which is considered valuable.
5. **oh-my-openagent's own custom parallel-agent tool syntax is OUT of scope** — `task(category=,
   load_skills=, run_in_background=)`, `background_output`, `background_cancel`, `call_omo_agent`
   are that plugin's own bespoke tool surface (their own reimplementation of task dispatch), not
   generic opencode API. astrocode uses **real opencode tools only**: `Task` (params: `description`,
   `prompt`, `subagent_type`, `task_id` for resume — confirmed via this session's own tool schema),
   `Skill`, `TodoWrite`/`Todoread`, `Monitor` (background work notification, no separate
   output/cancel tool pair). All ported prompt text must reference ONLY these real tools.
6. **Categories → drop as separate layer.** Read `agent-overrides.ts` (dist line 161050-161395):
   `applyCategoryOverride(config, categoryName, mergedCategories)` merges a category's
   `{model, variant, temperature, reasoningEffort, textVerbosity, thinking, top_p, maxTokens,
   prompt_append}` onto an agent's config **at agent-registration time** — it is NOT a runtime
   dispatch mechanism, just a named reusable bag of per-agent-config overrides applied once at
   startup. astrocode already has an unused `model:` frontmatter field on all 11 agent `.md`
   files (confirmed earlier: 0/11 currently set it) — reusing that field for "default model per
   agent" is functionally equivalent to what categories provided for this specific use case.
   Decision: **do not build a category subsystem; just start using the existing `model:`
   frontmatter field.**
7. **Agent behavioral metadata: KEEP.** `agent.metadata.keyTrigger` (string, checked before
   classification), `.cost` (`FREE`|`CHEAP`|`EXPENSIVE`, sorts delegation table), `.useWhen`/
   `.avoidWhen` (string arrays, explore/librarian/oracle usage guidance), `.triggers`
   (`{domain, trigger}[]`, delegation-table rows), `.category` (`"utility"` sentinel value only
   used to EXCLUDE an agent from the cost-sorted delegation table — unrelated to the
   category-override concept in #6, unfortunate naming collision in the original). Must extend
   astrocode's 11 agent `.md` frontmatter schema to carry these fields (new YAML keys), and the
   ported skeleton builders (`buildKeyTriggersSection`, `buildToolSelectionTable`,
   `buildExploreSection`, `buildLibrarianSection`, `buildDelegationTable`, `buildOracleSection`)
   read them from there.
8. **Skill location/priority split → drop.** `find . -iname "*skill*"` in astrocode repo root:
   zero results. astrocode ships NO built-in/bundled skills — every skill is user or
   project-authored. The built-in-vs-custom priority distinction
   (`buildSkillsSection`'s "⚡ YOUR SKILLS (PRIORITY)" callout) has nothing to contrast against.
   Port `buildSkillsSection`/`buildCategorySkillsDelegationGuide` content as a flat skill list,
   no location tagging, no priority-override framing.
9. **`plan`/`build` native-agent override: reuse the existing native `.md` mechanism.** User
   confirmed oh-my-openagent replaces opencode's own built-in `plan` and `build` agent slots.
   `general-agents.ts`'s `collectPendingBuiltinAgents` loop (dist 161050+) shows this is NOT special
   code — `plan`/`build` just flow through the SAME generic per-agent override merge
   (`agentOverrides[agentName]` → `mergeAgentConfig`) as any other agent name. Working hypothesis
   for astrocode (**not yet verified against opencode's own agent-loading docs**): opencode's
   native agent loader treats a `.md` file whose name matches a built-in agent name (`plan`,
   `build`) as an override/replacement, the same mechanism astrocode already relies on for its 11
   custom personas. If true, adding `agents/plan.md` + `agents/build.md` following the existing
   persona-file pattern is sufficient — no new plugin-hook code. **TODO: verify this against
   opencode's actual agent config docs/schema before implementing** (risk: if opencode requires a
   different override path — e.g. `config` hook mutating `output.agent.plan` — for built-in names
   specifically, this needs different wiring than the custom personas).

## New finding relevant to fallback design

`sisyphus-runtime-prompt-reconciler.ts` (dist 152512 area / marker at ~161219 per earlier index,
content captured in agent-overrides.ts pull at line 170-193): `reconcileSisyphusRuntimePrompt(system,
runtimeModel)` — detects when the actual runtime model's resolved prompt-family differs from the
originally-configured model's family (e.g., user/fallback switched Claude → GPT mid-session),
rebuilds the family-specific prompt for the new model, and string-swaps the old baked prompt for
the new one inside the `system` array in place. **This is the missing piece connecting the
dynamic-prompt engine to the fallback module**: when the fallback hook resubmits a prompt on a
different-family model, the system prompt must also be rebuilt for that family, not left stale.
Plan: port this reconciler pattern and call it from both (a) `experimental.chat.system.transform`
normal flow and (b) the fallback retry path before calling `client.session.prompt(...)`.

## Architecture already captured (full read, ready to design from)

**Shared skeleton** (12 files, 914 lines, `/tmp/astrocode-extract/dynamic-agent-*.ts`,
`frontier-tool-schema-guard.ts`, `sisyphus-agent-config.ts`, `sisyphus-dynamic-prompt*.ts`):
composition pipeline is `buildSisyphusDynamicPromptSections(model, agents, tools, skills,
categories, useTaskSystem)` → produces a flat `sections` object → 4 renderers consume it:
`renderRoleAndIntentSections` (Phase 0: identity, key-triggers, intent classification,
ambiguity-gate), `renderExplorationSection` (Phase 2A: tool-selection table, explore/librarian
usage, parallel-execution rules, anti-duplication), `renderExecutionSections` (Phase 2B/2C/3:
delegation-prompt structure, session-continuity via `task_id`, code-change rules, verification,
failure-recovery, completion checklist), `renderToneAndConstraintsSection` (communication style,
hard-blocks, anti-patterns). Final assembly in `sisyphus-dynamic-prompt-builder.ts`:
`buildSisyphusDynamicPromptContent` concatenates all 4 renderer outputs. Per-family dispatch in
`sisyphus-agent-factory.ts`: `resolveSisyphusPromptFamily(model)` → one of `kimi-k3`|`kimi-k2-7`|
`kimi-k2-6`|`gpt-5-5`|`gpt-5-4`|`claude-fable-5`|`claude-opus-5`|`claude-opus-4-8`|
`claude-opus-4-7`|`glm-5-2`|`fallback`, then `createSisyphusAgent` calls
`build<Family>SisyphusAgentConfig(MODE, model, build<Version>SisyphusPrompt(model, agents, tools,
skills, categories, useTaskSystem))`. Per astrocode's family-level-not-version-level decision (#1),
collapse to: `claude`, `gpt`, `gemini`, `kimi`, `glm`, `fallback` (generic/qwen/deepseek/minimax/
etc. all fall to `fallback`).

**Per-family delta files** (representative picks per decision #1, NOT yet content-read except
`default.ts`): `claude-opus-5.ts` (398 lines, claude rep.), `gpt-5-5.ts` (392 lines) +
`gpt-prompt-identity.ts` (20) + `gpt-task-system-guide.ts` (24) (gpt rep.), `kimi-k3.ts` (193
lines, kimi rep.), `glm-5-2.ts` (165 lines, only glm file, no choice needed), `gemini.ts` (229
lines) + `gemini-fallback-overrides.ts` (22 lines, applied as a post-process wrapper via
`applyGeminiFallbackOverrides`, only gemini file, no choice needed), `default.ts` (110 lines,
fallback family rep. — **fully read**: exports only `buildTaskManagementSection(useTaskSystem)`,
two variants gated on whether the target has a Task-tool-based system (`TaskCreate`/`TaskUpdate`
wording) vs a todo-list-based one (`todowrite` wording) — directly portable, astrocode has both
`TaskCreate`/`TaskUpdate`-style and `Todowrite` tools depending on context).

**Guard constants already in astrocode's `guards.ts`, unchanged**: `TOOL_LOOP_GUARD` (=
`KIMI_TOOL_LOOP_GUARD`, dist ~155665), `APPLY_PATCH_GUIDANCE` (= `GPT_APPLY_PATCH_GUIDANCE`, dist
~154849). **Not yet added**: `GPT_FILE_EDIT_GUIDANCE` (dist ~154852, right after
apply-patch-guidance) — candidate addition for the `fallback` family when `apply_patch` tool
isn't available: "Use whichever file-editing tool is exposed in your toolset (`apply_patch`, or
`edit`/`write`). Keep each change small and match the surrounding lines exactly so it applies on
the first attempt."

## Fallback module design (SDK-verified, see task history for full detail)

Real opencode SDK confirmed to support this with NO passthrough hacks:
`event` hook on `session.error` → classify error (port `RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS`,
~25 regexes incl. rate-limit/quota/503/529/Chinese-localized variants, default
`retry_on_errors=[429,500,502,503,504]`) → if retryable & under `max_attempts`/`cooldown_seconds`
(in-memory `Map<sessionID,{attempts,lastAttemptAt}>`) → `client.session.messages({path:{id}})`,
take last `role==="user"` message's text parts → `client.session.prompt({path:{id}, body:{model:
{providerID,modelID}, parts}})` to resubmit on the next fallback-chain model, continuing the SAME
session (full tool-call/thought history already server-side, no manual replay needed — confirmed
via how oh-my-openagent's own `getLastUserRetryPayload` only ever re-sends the last user text, not
full history, because the session itself already carries it). Must also call the prompt-reconciler
(see above) before resubmitting if the fallback model's family differs from the original.
Open risk flagged (not yet resolved): cross-provider retry of `reasoning`/thinking parts — Claude's
extended-thinking blocks carry provider-specific signatures and likely can't replay as-is into a
GPT/Gemini retry; need to confirm whether opencode's own session-history serialization already
strips/filters these per-target-provider, or whether astrocode's fallback hook must do it
explicitly before resubmitting.

## Commands to port (7, verbatim source markers, NOT yet content-read)

`packages/omo-opencode/src/features/builtin-commands/` (dist lines): `templates/goal.ts`(111708),
`templates/stop-continuation.ts`(111739), `templates/refactor-sections/codemap-and-tests.ts`(111755),
`templates/refactor-sections/intro-and-analysis.ts`(111897),
`templates/refactor-sections/plan-and-execution.ts`(112110),
`templates/refactor-sections/verification-and-tooling.ts`(112260),
`templates/refactor-sections/team-mode-addendum.ts`(112394, → HTML-comment per decision #2),
`templates/refactor.ts`(112534, assembler), `templates/start-work.ts`(112537),
`templates/handoff.ts`(112677), `templates/remove-ai-slops.ts`(112875),
`templates/hyperplan.ts`(113092), `commands.ts`(113111, loader/registry shape).
astrocode has no `command/` directory yet — must be created.

## Open questions for user (blocking further implementation)

- **RESOLVED**: decisions #6 (drop categories, reuse `model:` frontmatter) and #8 (drop skill
  location/priority split, astrocode has zero built-in skills) are confirmed — user's follow-up
  answers plus empirical evidence (empty `find . -iname "*skill*"`, `applyCategoryOverride`
  semantics read in full) settle both. Decision #7 (keep agent metadata) explicitly confirmed by
  user ("Хорошая вещь... Сохрани и в моем плагине это"). Decision #5 (skip oh-my's own parallel
  tool syntax) explicitly confirmed. Overall approach = variant 2 (adapt content to astrocode's
  real tools), locked.
- **RESOLVED (verified)**: #9 mechanism confirmed against the official opencode agent docs
  (https://opencode.ai/docs/agents/): markdown agent files use the **file name as the agent
  name** ("`review.md` creates a `review` agent"), and builtin agents are also overridable via
  the JSON `agent` block (`agent.plan`, `agent.build`). Therefore astrocode ships
  `agents/plan.md` and `agents/build.md` alongside the 11 personas — same `.md`-by-name mechanism.
  Implemented: `plan` = read-only planner, `build` = Sisyphus orchestrator (carries the same
  marker string so it receives the dynamic prompt engine).

## Implementation status (all core steps DONE)

1. Decisions #1–#9 all resolved (see above).
2. Dynamic prompt engine ported: `src/agents/metadata.ts`, `src/prompts/sisyphus/sections.ts`,
   6 family builders (`src/prompts/sisyphus/families/*`), `src/prompts/sisyphus/dispatch.ts`,
   `agents/sisyphus.md` trimmed, wired into `src/index.ts`.
3. `src/fallback/` implemented (config/classify/state/orchestrator) + `event` hook on
   `session.error`; resubmits last user turn with the next model on the same session.
4. 7 builtin commands ported into `src/commands/index.ts`, injected via the `config` hook
   (team-mode/Codex sections HTML-commented per decision #2).
5. `agents/plan.md` + `agents/build.md` overrides written.
6. README updated; `.opencode/opencode.jsonc` stale `oh-my-openagent@3.17.4` reference removed
   (now an empty plugin array awaiting the per-project astrocode entry).
7. Verification: `bun test` → 66 pass / 0 fail; `bun run tsc --noEmit` → 0 errors.

## Second-wave revision (post user testing on the astrocode repo itself)

User feedback after the first project-level test run: (1) builtin `build` not replaced by
Sisyphus, (2) builtin `plan` not replaced by Prometheus, (3) wanted per-agent colors like
oh-my-openagent, (4) fallback did not trigger on a real subscription-limit error, (5) wanted a
default model + fallback list per agent, (6) wanted a dedicated astrocode config file instead of
dumping everything into `.opencode/opencode.jsonc`, (7) wanted `/start-work` to switch to Atlas.

Changes made:

- **Plugin now owns the agent roster** (`src/agents/personas.ts` + the `config` hook in
  `src/index.ts`): it loads the shipped `agents/*.md` personas, assigns distinct `DEFAULT_COLORS`
  (sisyphus #00CED1, prometheus #9B59B6, oracle #E74C3C, explore #2ECC71, …), and maps
  `build` → full **Sisyphus** persona and `plan` → full **Prometheus** persona
  (`buildNativeOverrides`). Supersedes the earlier `agents/plan.md`/`agents/build.md` markdown
  files (deleted) and the `.opencode/agents/` symlink directory (deleted) — no copying needed.
- **Dedicated config file** `src/config/astrocode.ts`: searches `astrocode.jsonc|json` in the
  project root and `.opencode/`. Shape `{agents: {<name>: {model?, fallback_models?, color?}},
  fallback: {...}}`. Inline plugin options override the file with a per-agent shallow merge.
- **Per-agent model + fallback list** wired through `src/fallback/config.ts`
  (`fallback_models` accepted alongside legacy `models`).
- **Fallback trigger fixed** (`src/fallback/classify.ts`): broadened retryable patterns
  (usage-limit/limit/quota/out-of-credits/billing/overloaded/capacity/resource-exhausted) and
  **removed the `isRetryable:false` veto** (switching providers is exactly what a
  subscription/quota limit needs). The `event` hook now reacts to both `session.error` and
  `message.updated` assistant errors. `dispatchFallback` aborts + retries once if resubmission
  errors, and the synthetic retry note is skipped when re-collecting user text.
- **`/start-work`** now sets `agent: "atlas"` + `subtask: false` so Atlas is switched to as the
  primary agent rather than invoked as a subagent.
- Verification: `bun test` → 77 pass / 0 fail / 290 expect() calls across 8 files;
  `bun run tsc --noEmit` → 0 errors. `opencode debug config` confirms:
  `[astrocode] config: injected 13 agents, 9 commands, fallback=on`, `build` primary
  color=#00CED1 with the Sisyphus prompt, `plan` primary color=#9B59B6 with the Prometheus prompt.
- Test config lives in `.opencode/opencode.jsonc` (just `model` + `plugin`) and
  `.opencode/astrocode.jsonc` (agents + fallback).

## Historical next-steps (retained for reference)

1. Get user sign-off on decisions #6/#7/#8 above (asked in chat, awaiting reply).
2. Verify #9's mechanism (quick check of opencode agent docs/config schema for built-in agent
   override, or empirical test).
3. Read remaining per-family delta file contents (claude-opus-5, gpt-5-5 + 2 helpers, kimi-k3,
   glm-5-2, gemini + fallback-overrides) — rewrite each dropping oh-my-specific tool syntax
   (decision #5), keeping model-specific STYLE/tone/thinking-guidance content.
4. Extend astrocode's 11 `agents/*.md` frontmatter with keyTrigger/cost/useWhen/avoidWhen/
   triggers/category(utility-sentinel) fields (decision #7), populate real values matching
   astrocode's actual 11 personas.
5. Implement the dynamic-prompt port: skeleton builders (decision #1 concatenation
   pipeline) + 6 family delta modules + factory dispatch, wired into `src/index.ts`'s
   `experimental.chat.system.transform` hook (replacing today's static guard-append).
6. Implement `src/fallback/` module (error-classifier + state map + event/session.prompt wiring +
   prompt-reconciler call).
7. Port 7 commands into `command/` (new dir), team-mode sections HTML-commented per decision #2.
8. Implement `plan.md`/`build.md` override files per resolved #9 mechanism.
9. Update README + tests + run `bun test` && `tsc --noEmit`.
10. Fix previously-flagged stale `.opencode/opencode.jsonc` (still references
    `oh-my-openagent@3.17.4` instead of astrocode's own `src/index.ts` entry point).
