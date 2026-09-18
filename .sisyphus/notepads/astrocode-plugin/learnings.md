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
