## [2026-09-18T19:19Z] Task: 0+1 verification (pre-existing, bundled)
Repo already bootstrapped before this session (git init, local identity Astroreen, origin=github.com/Astroreen/astrocode private, pushed). Scaffold (package.json, tsconfig.json, .gitignore, test/smoke.test.ts) was bundled into the SAME initial commit "chore: initial commit (plan + scaffold)" rather than a separate Task-1 commit — this is fine, both tasks' acceptance criteria verified independently:
- Task 0: `gh repo view Astroreen/astrocode --json visibility,name` -> PRIVATE/astrocode; `git ls-remote origin main` -> abebda5...; local git config user.name=Astroreen, user.email set (global empty).
- Task 1: `bun install` + `bun test` -> 1 pass 0 fail; `bunx tsc --noEmit` -> OK (empty output).
Marked both checkboxes [x] in plan.

Local repo state at verification time: `main...origin/main [ahead 1]` (commit "Corrected the plan" not yet pushed) + untracked `bun.lock`. Delegating a quick git-sync task to commit bun.lock + push before starting Task 2 SPIKE, so Task 2's work starts from a clean/pushed tree.

src/models/, src/prompts/, agents/ dirs exist but are EMPTY (expected — populated by Tasks 3,4,5,6,7).

## [2026-09-18T19:30Z] Git hygiene closeout
Tracked bun.lock committed and pushed in `chore: track bun.lock`. Final synced state check: `git status -sb` still showed pre-existing dirty items outside this task scope (`.sisyphus/plans/astrocode-plugin.md` modified and `.sisyphus/notepads/` untracked). Bun.lock itself is now tracked; no repo files outside existing state were touched.

## [2026-09-18T19:30Z] Task: 2 spike A1/A2/A3
- Reliable headless invocation worked with `XDG_CONFIG_HOME="/tmp/astrocode-spike-xdg" opencode run --auto -m anthropic/claude-haiku-4-5 "..."` inside a scratch project containing `.opencode/opencode.jsonc`; isolating `XDG_CONFIG_HOME` prevented unrelated user-global plugins from contaminating the spike while still allowing project-local plugin loading.
- Free `opencode/*-free` model path was unusable on installed CLI v1.17.12 / runtime banner 1.18.0 compatibility path: provider returned `OpenCode 1.18.0 or newer is required to use the free tier`; Anthropic + `opencode-claude-auth` in scratch config worked.
- Empirical hook result: `experimental.chat.system.transform` sees a PRE-FILLED `output.system` array. Even before the main reply turn, a title-generator system prompt was already present; on the main turn the array contained the full base coding-agent prompt before probe mutation.
- Empirical subagent result: hook fires again for `task(subagent_type="explore", ...)` children. Parent sessionID `ses_f4a0190e8ffezLl1HXwPjXKU1i`; spawned explore sessionID `ses_f4a017f62ffeAi9o3P3PrCMaBN`. Guards added in this hook therefore reach subagents too.
- Empirical native-agent result: active `.md` agent body is already embedded in `output.system` when hook fires. Sentinel `ASTROCODE_NATIVE_AGENT_BODY_SENTINEL_A3` appeared at the start of dumped system text, so future plugin guard injection must avoid persona duplication.
- Gotcha: hook input delivered `model.providerID="anthropic"` but `input.model.modelID` came through `null` in the dump for these runs, even though `task` tool metadata separately reported `modelID: "claude-haiku-4-5"`. Do not assume hook-time `modelID` is always populated without defensive fallback.
- Correction to previous bullet: measured hook inputs always carried `input.sessionID`; only `input.model.modelID` was unexpectedly `null` in the dump.

## [2026-09-18T22:50Z] Task: 4 verbatim guards + dump side-channel
Guard constants extracted VERBATIM from `~/.cache/opencode/node_modules/oh-my-openagent/dist/index.js`:
- `KIMI_TOOL_LOOP_GUARD` @ **line 155666** — template literal `<tool_loop_guard>...</tool_loop_guard>` (4 body lines, lines 155666-155670). Exported as `TOOL_LOOP_GUARD` in src/prompts/guards.ts.
- `GPT_APPLY_PATCH_GUIDANCE` @ **line 154850** — single-line string: `Use \`apply_patch\` for file edits. Keep patches small and match the surrounding lines exactly so verification passes.` Exported as `APPLY_PATCH_GUIDANCE`.
- grep: `grep -n "KIMI_TOOL_LOOP_GUARD\|GPT_APPLY_PATCH_GUIDANCE" <bundle>` -> 15 matches (2 defs + 13 template interpolations). Both were clean `var NAME = ...` decls, NOT minified object keys — easy verbatim copy.

Mapping (plan): claude->[]; cheap-openrouter->[TOOL_LOOP_GUARD, APPLY_PATCH_GUIDANCE] (tool-loop + explicit-tool-call-format); fallback->all (both). fallback==cheap here since only 2 guards exist -> superset test uses `>=` + contains-all (satisfied by equality).

dump.ts semantics reconciled plan's contradictory "default path" + "no-op if unset": ASTROCODE_DUMP unset/empty -> no-op; "1"/"true" -> DEFAULT_DUMP_PATH (/tmp/astrocode-prompt-dump.json); any other value -> treated as path. appendFileSync (append, one JSON line/call). catch swallows all -> never throws.

Idempotency: getGuards returns FRESH array each call (module-const strings, but new array literal) -> caller mutation-safe. No sentinel/injection helper here (that's Task 5's caller logic per MUST-NOT).

Verify: `bun test test/guards.test.ts` -> 6 pass/0 fail/16 expect; `bunx tsc --noEmit` -> clean.

## Task 3 — resolveFamily() router (done)

- Implemented `src/models/resolveFamily.ts` + `test/resolveFamily.test.ts` via TDD (RED confirmed: missing-module error before impl; GREEN: 19 pass / 0 fail; `tsc --noEmit` exit 0; LSP clean).
- AD-3 order matters: `claude` substring checked FIRST (wins even under `openrouter` provider), THEN `cheap-openrouter` (provider guard `openrouter` AND allowlist substring [deepseek,glm,kimi,qwen,minimax,yi,zhipu]), ELSE `fallback`. All matching case-insensitive.
- Totality via `(model?.X ?? "")` — no throw on empty/garbage/nullish input; always one of 3 literals.
- Kept param name `modelID` per plan; added mandatory CALLER NOTE docstring: real runtime `Model` has `id`, NOT `modelID` (spike-findings.md). Task 5 must pass `model.id`.
- GOTCHA (env-specific): the opencode Write/Edit client sanitizer mangles any `const x = <call|member|new|paren-RHS>` into `__POTENTIAL_IDENTIFIER_ASSIGNMENT_*__` placeholders (breaks file). Array/object-literal RHS survive. Workaround: avoid intermediate `const` assignments from identifiers — inline expressions inside `if(...)` conditions (expressions are NOT mangled). Cost several rewrite cycles; verify written file content after Write/Edit.
- Commit `2053257` pushed to origin/main: `feat(models): add resolveFamily router`.

## Persona Fixes (Task 6+7)
- **Root Cause**: Initial persona files contained OMO-specific branding (OhMyOpenCode), non-existent tools (call_omo_agent), and OMO-specific task categories.
- **Fixes**:
  - Removed 'OhMyOpenCode' branding from all descriptions and bodies.
  - Removed 'call_omo_agent', 'write', 'edit', 'apply_patch' from read-only agents (explore, librarian, oracle).
  - Adapted Prometheus to be self-contained, removing dependency on 'shared/ulw-plan' skill and updating paths from '.omo/' to '.sisyphus/plans/'.
  - Rewrote Sisyphus delegation logic to use 'subagent_type' with actual plugin agent names and removed 'category' parameter.
  - Validated all YAML frontmatter for correctness.
- **Commit Hashes**:
  - MVP: 18440ed
  - Extended: 31d0f08

## [2026-09-18] Orchestrator verification of Task 6+7 persona fix
Independently re-verified (did not trust subagent self-report): git diff --stat 2053257..31d0f08 -- agents/ shows exactly 11 files, 894 insertions/0 deletions, no scope creep. Both grep guardrails re-run and clean (call_omo_agent|OhMyOpenCode|task\(category=|category="(visual-engineering|ultrabrain|quick) -> 0 matches; background_output|delegate-task|run_in_background|parallel wave -> 0 matches). Read all 5 fixed files (explore.md, librarian.md, oracle.md, prometheus.md, sisyphus.md) in full: all fixes confirmed genuine and correct. prometheus.md quality is notably good (60 lines, fully self-contained planning workflow, correctly demonstrates task(subagent_type=...) pattern and explicitly bans category=). bun test 26 pass, bunx tsc --noEmit clean.

RESIDUAL MINOR ISSUES (non-blocking, flagged for Final Wave F2/F4 reviewers):
- librarian.md tools frontmatter now includes `websearch_web_search_exa` — this is a harness/MCP-specific tool name (from the oc-mcp wrapper namespace used in THIS orchestration session), not a standard native opencode tool name. May not exist in the actual target deployment environment for these personas (a plain opencode + astrocode plugin install without the orchestration harness's MCP servers). Consider replacing with a more portable/generic name or removing if not confirmed available, before final ship.
- librarian.md body text (TOOL REFERENCE / FAILURE RECOVERY sections) also references `context7` and `grep_app` conceptually, neither of which appear in the tools: frontmatter allowlist — pre-existing inconsistency, not introduced by this fix round.
- sisyphus.md has a near-duplicate "Delegation Check" numbered list appearing twice (once in Phase 0 Step 3, once in Phase 2A) — copy-paste artifact from the rewrite, cosmetic only, not a functional bug.
- sisyphus.md's Phase 2A agent list includes `hephaestus` but the "Delegation Check" numbered lists only mention sisyphus-junior/explore/librarian/oracle/multimodal-looker (hephaestus omitted from the check, present in Selection) — minor inconsistency, not a functional blocker (hephaestus still invocable via subagent_type).

Task 6 and Task 7 checkboxes marked [x] in plan after this verification. Task 2/3/4/6/7 all now confirmed done (7/16 top-level tasks complete: 0,1,2,3,4,6,7). Remaining: 5,8,9,10,11 + Final Wave F1-F4.

## [2026-09-19T10:52Z] Task: 5 plugin entry src/index.ts (done, direct implementation)
NOTE: task()/subagent delegation unavailable in this session's environment (user confirmed
directly) — implemented directly instead of delegating, deviating from Atlas orchestrator
protocol for this one task. Verified same as any subagent output would be (tests+tsc+lsp+manual read).

- src/index.ts default-exports a Plugin (async () => Hooks) implementing:
  - `experimental.chat.system.transform`: resolveFamily({providerID: input.model.providerID,
    modelID: input.model.id}) — uses `.id` per Task 3's CALLER NOTE gotcha (real Model has
    `id`, not `modelID`). Pushes getGuards(family) onto output.system (append only, AD-1).
    Idempotency via `output.system.includes(guard)` check before push — no extra sentinel
    needed since getGuards returns the same verbatim module-const strings every call.
    Calls dumpPrompt({...}) unconditionally (dump.ts itself no-ops if ASTROCODE_DUMP unset).
  - `chat.params`: only cheap-openrouter family gets temperature=0.3/topP=0.9 override; both
    claude AND fallback are left untouched (plan text only specified cheap-openrouter override
    + "claude: leave defaults" — chose to also leave fallback alone rather than assume it
    should mirror cheap-openrouter's sampling, since Must-NOT forbids scope creep beyond spec).
  - Both hooks wrapped in try/catch + explicit shape guards (`!output || !Array.isArray(output.system)`
    for system.transform; `!output || typeof output !== "object"` for chat.params) ->
    console.error(`[astrocode] ...`) + return, never throws.
- test/index.test.ts: 8 tests (5 for system.transform incl. cheap/claude/malformed/idempotent/
  unknown-fallback, 3 for chat.params incl. cheap-override/claude-untouched/null-malformed).
- Verify: `bun test` -> 34 pass/0 fail (full suite, no regressions); `bunx tsc --noEmit` -> clean;
  lsp_diagnostics on both new files -> no diagnostics.
- Commit pending: feat(plugin): model-aware system.transform + chat.params.
