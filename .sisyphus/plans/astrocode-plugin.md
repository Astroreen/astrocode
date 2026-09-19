# astrocode — minimal model-aware opencode plugin + agent personas

## TL;DR

> **Quick Summary**: Build a standalone, stable opencode plugin ("astrocode") replicating the essence of oh-my-openagent/oh-my-opencode — custom agent personas + model-aware defensive prompting — while dropping OMO's fragile heavy machinery (parallelism, circuit-breakers, tmux, background-task orchestration). Personas ship as native `.md` agent files (stable core); a thin plugin layer injects model-family-specific guard text and tunes sampling.
>
> **Deliverables**:
> - Native `.md` agent personas in `agents/` (MVP: sisyphus, explore, librarian, oracle, prometheus; extended: atlas, momus, metis, multimodal-looker, sisyphus-junior, hephaestus)
> - `src/index.ts` — plugin: `experimental.chat.system.transform` (append model-family guards) + `chat.params` (per-family sampling)
> - `src/models/resolveFamily.ts` — providerID/modelID -> family router (claude | cheap-openrouter | fallback)
> - `src/prompts/guards.ts` — verbatim-copied defensive guards; `src/prompts/dump.ts` — prompt-dump side-channel
> - `bun test` suite; README with nix meridian-pattern deploy snippet
> - `docs/fallback-spike-findings.md` — model-fallback feasibility investigation + recommendation
>
> **Estimated Effort**: Medium (~2-3 focused days)
> **Parallel Execution**: YES — Wave 0 bootstrap -> Wave 1 (spike gate) -> Wave 2A routing || 2B personas -> Wave 3 integration
> **Critical Path**: T0 (bootstrap+push) -> T1 (scaffold+test) -> T2 (SPIKE hook semantics) -> T5 (plugin) -> T8 (integration) -> T10 (nix deploy) -> F1-F4 -> user okay

---

## Context

### Original Request
User (astroreen) wants a self-built, minimal, STABLE alternative to the oh-my-openagent/oh-my-opencode opencode plugin. OMO repeatedly breaks (notifications not reaching orchestrator, tools unusable after long runs, self-broke its config schema between 3.17.4->4.19.4). User's exact-order priorities:
1. MOST IMPORTANT — custom agents (sisyphus, atlas, prometheus, metis, momus, librarian, explore, oracle, multimodal-looker, sisyphus-junior, etc.) + their capabilities, as dynamic, model-aware prompts.
2. Skills — already native (learn/caveman), no migration.
3. Notifications — already covered by existing @mohak34/opencode-notifier plugin, no work.
4. Parallelism/background-tasks — EXPLICITLY DROPPED (too complex/fragile; use native synchronous `task` tool).

User runs a MIX of models: primarily Claude Sonnet + cheap OpenRouter models (Deepseek, GLM, Kimi, Qwen, other Chinese models). Weak/cheap models need more defensive prompting than frontier Claude — the justification for model-aware branching.

Repo: `~/Documents/opencode/astrocode`, pushed private to GitHub (account: Astroreen). Wired into user's NixOS config via meridian-pattern (`home.activation` clone/install), referenced per-project in each project's `.opencode/opencode.jsonc` plugin array — NOT globally.

### Interview Summary
- Plugin vs pure agents: native `.md` agents are static (prompt/model/tools only) — cannot do model-aware dynamic behavior; plugin hooks required for the dynamic layer. Architecture = HYBRID.
- Why not extend OMO: huge surface (git_master, browser_automation, team_mode, tmux, i18n, keyword_detector, babysitting, ~5500 LOC delegate-task) -> structurally more bug surface. astrocode covers ~20% surface for ~80% value.
- Placement: separate standalone TS repo. Precedents: meridian (standalone npm project via home.activation) and inputs.caveman (separate flake source).

Research findings (VERIFIED against installed code + SDK types):
- SDK @opencode-ai/plugin (at ~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts) exposes experimental.chat.system.transform: input { sessionID?: string; model: Model }, output { system: string[] }.
- chat.params hook: input { sessionID, agent, model, provider, message }, output { temperature, topP, topK, options } — per-model sampling.
- Model carries providerID + modelID — sufficient for family routing.
- opencode loads plugin TS entry directly via Bun — no build step required (same as meridian.ts).
- OMO persona TEXT is bundled minified in ~/.cache/opencode/node_modules/oh-my-openagent/dist/index.js (~178k lines) — extractable but dynamically assembled from ~15 section modules per family. Extraction = reverse-engineer assembled output, not clean copy. Agents in dist/agents/: sisyphus, sisyphus-junior, oracle, explore, librarian, prometheus, multimodal-looker, atlas, momus, metis, hephaestus.
- OMO guards worth copying VERBATIM: KIMI_TOOL_LOOP_GUARD (anti-loop), GPT_APPLY_PATCH_GUIDANCE, frontier-tool-schema-guard (the last is a permission {grep:deny,glob:deny}, not prompt text).

### Metis Review (verified via probe agents)
- Hook is MUTATE-IN-PLACE, NOT replace. output.system: string[] arrives pre-filled with the base prompt. Proof: opencode-claude-auth uses output.system.unshift(...); OMO transforms.js:82-94: "OpenCode prepends the identity string, then concatenates all system entries into a single text block." To REPLACE, must explicitly output.system.length=0; push(...).
- Core opencode not available as source — Go binary in nix-store, upstream repo archived (read-only since 2025-09-18). Behavior frozen; no official runtime docs.
- `.md` agent body = primary system prompt (prompt: body.trim(), mode: subagent). Hook appends ON TOP. Order: base/.md -> plugins mutate -> concatenation.
- sessionID? optional in hook signature -> subagent firing NOT guaranteed; must be empirically tested (assumption A2 — the critical gate).

---

## Architecture Decisions (applied defaults — override if you disagree)

AD-1 (replace vs append): Hook uses mutate-in-place, append. Guards pushed onto output.system; base prompt NEVER wiped. Matches verified hook reality; non-destructive.

AD-2 (`.md` vs plugin-injection): HYBRID.
- Personas -> native `.md` files (~/.config/opencode/agents/ or project .opencode/agents/). Stable even if the experimental.* hook breaks. Serves priority #1 with max stability.
- Plugin (src/index.ts) -> thin model-aware layer only: appends family guards via experimental.chat.system.transform, tunes sampling via chat.params.
- Decouples persona work (Wave 2B) from routing-engine (Wave 2A). Single contract: getGuards(family): string[].

AD-3 (cheap-openrouter detection): allowlist by substring (case-insensitive). family="cheap-openrouter" if providerID contains "openrouter" AND modelID contains any of ["deepseek","glm","kimi","qwen","minimax","yi","zhipu"]; family="claude" if modelID contains "claude"; else family="fallback" (most defensive — all guards on).

AD-4 (persona delegation without parallelism): adapted personas MUST strip all parallel/background/delegate instructions and rewrite delegation around the native synchronous `task` tool. A persona must never instruct calling a nonexistent tool.

---

## Work Objectives

### Core Objective
Deliver a stable, minimal opencode plugin + native agent personas giving model-aware defensive prompting for a Claude + cheap-OpenRouter mix, without OMO's fragile heavy machinery.

### Concrete Deliverables
- agents/*.md (MVP + extended sets above)
- src/index.ts, src/models/resolveFamily.ts, src/prompts/guards.ts, src/prompts/dump.ts
- test/*.test.ts (bun test)
- package.json, tsconfig.json, README.md, .gitignore
- Private GitHub repo (Astroreen) pushed
- Nix wiring snippet (meridian-pattern) in README
- docs/fallback-spike-findings.md (Task 11 output — feasibility verdict + recommendation)

### Definition of Done
- [ ] bun test -> all pass
- [ ] bunx tsc --noEmit -> 0 errors
- [ ] Prompt-dump proves guard text present for cheap model, absent for Claude
- [ ] MVP personas load as native agents (verified via opencode session)
- [ ] Repo pushed private to GitHub (Astroreen)

### Must Have
- Personas as native `.md` (stable core, no plugin dependency)
- Model-family router with deterministic fallback
- Verbatim-copied defensive guards for cheap models
- Zero-human verification via prompt-dump side-channel
- Defensive hook wrapper (no-op + log if experimental API shape changes)

### Must NOT Have (Guardrails — from Metis)
- NO reimplementation of OMO parallelism / delegate-task / circuit-breaker / tmux / background-task orchestration (~5500 LOC, dropped)
- NO 14-section dynamic prompt builder. Cap: 1 shared base per persona (.md) + conditional guard-string injection
- NO model variants beyond 2-3 families (claude / cheap-openrouter / fallback). NOT 13
- NO parallel/background instructions left in adapted personas
- NO entry in global programs.opencode.settings.plugin — per-project .opencode/opencode.jsonc only
- NO "improving"/abstracting copied guards — verbatim text only
- NO custom tool registration, notification code, or skill system (covered elsewhere)

---

## Verification Strategy (MANDATORY)

> ZERO HUMAN INTERVENTION — all verification agent-executed.

### Test Decision
- Infrastructure exists: NO (new project)
- Automated tests: YES (TDD where sensible) — bun test (user has bun 1.3.13)
- Framework: bun test
- Key insight: the ONLY zero-human way to observe output.system is a logging side-channel inside the plugin writing the assembled prompt to a file (/tmp/astrocode-prompt-dump.json). Built as test infra (Task 4).

### QA Policy
Every task includes agent-executed QA scenarios. Evidence -> .sisyphus/evidence/task-{N}-{slug}.{ext}.
- Plugin/module: bun test + bunx tsc --noEmit
- Integration (hook fires / prompt swap): run opencode session against a model, inspect the dump with grep/jq
- Personas: launch agent in an opencode session; confirm it loads + behaves

---

## Execution Strategy

### Parallel Execution Waves

Wave 0 (Bootstrap — must run first):
- Task 0: git init + local identity + commit plan/scaffold + create private GitHub repo + push [git]

Wave 1 (foundation + the critical gate):
- Task 1: Scaffold + bun test infra + tsconfig + package.json [quick]
- Task 2: SPIKE — resolve hook semantics A1/A2/A3, lock contract [deep] (GATE)

Wave 2A || 2B (after Task 2 — decoupled by getGuards contract):
- Task 3: resolveFamily() router + unit tests [unspecified-high]
- Task 4: guards.ts (verbatim) + dump.ts side-channel [unspecified-high]
- Task 5: src/index.ts plugin (system.transform append + chat.params) [deep]
- Task 6: MVP personas .md (sisyphus, explore, librarian, oracle, prometheus) [writing]
- Task 7: Extended personas .md (atlas, momus, metis, multimodal-looker, sisyphus-junior, hephaestus) [writing]
- Task 11: SPIKE — model-fallback feasibility via plugin hooks [deep]

Wave 3 (integration + deploy):
- Task 8: Integration wiring + prompt-swap integration QA [deep]
- Task 9: README (usage + nix meridian snippet + version-pin note) [writing]
- Task 10: Nix deployment snippet validated [quick]

Wave FINAL (after ALL — 4 parallel reviews, then user okay):
- F1: Plan compliance audit (oracle)
- F2: Code quality review (unspecified-high)
- F3: Real manual QA (unspecified-high)
- F4: Scope fidelity check (deep)
-> Present results -> explicit user okay

Critical Path: T0 -> T1 -> T2 -> T5 -> T8 -> T10 -> F1-F4 -> user okay

### Dependency Matrix
- 0: deps none -> blocks 1 (repo must exist before commits)
- 1: deps 0 -> blocks 2,3,4,5
- 2 (SPIKE/GATE): deps 1 -> blocks 5,6,7,8,11 (A2 result decides persona delivery path)
- 3: deps 1 -> blocks 5,8
- 4: deps 1 -> blocks 5,8
- 5: deps 2,3,4 -> blocks 8
- 6: deps 2 -> blocks 8
- 7: deps 2 -> blocks 8
- 8: deps 5,6,7 -> blocks 9,10
- 9: deps 8,11 -> blocks 10
- 10: deps 8,9 -> blocks F1-F4
- 11 (SPIKE): deps 2 -> blocks 9

### Agent Dispatch Summary
- Wave 0: T0 -> git
- Wave 1: T1 -> quick; T2 -> deep
- Wave 2: T3 -> unspecified-high; T4 -> unspecified-high; T5 -> deep; T6 -> writing; T7 -> writing; T11 -> deep
- Wave 3: T8 -> deep; T9 -> writing; T10 -> quick
- FINAL: F1 -> oracle; F2 -> unspecified-high; F3 -> unspecified-high; F4 -> deep

---

## TODOs

- [x] 0. Bootstrap repo + private GitHub push

  IDEMPOTENCY GUARD (check FIRST, before doing anything else):
  - Run `git -C ~/Documents/opencode/astrocode rev-parse --is-inside-work-tree` and `git -C ~/Documents/opencode/astrocode remote -v`.
  - If already a git repo AND `origin` already points to `github.com/Astroreen/astrocode` -> bootstrap is DONE. Skip `git init` and `gh repo create` entirely (repo already exists on GitHub; `gh repo create` will error "Name already exists" if run again). Only verify via Acceptance Criteria below and stop.
  - If partially done (e.g. git init'd but no remote) -> only perform the missing steps.

  What to do (only if NOT already done, per guard above):
  - git init in ~/Documents/opencode/astrocode; set LOCAL identity: git config user.name "Astroreen", git config user.email "ilja.zoludev@gmail.com" (global identity is empty)
  - Ensure scaffold files exist (Task 1 output) + this plan; initial commit
  - Create private GitHub repo via gh repo create astrocode --private --source=. --remote=origin (gh authenticated as Astroreen, scope repo present)
  - git push -u origin main (normalize branch to main)

  Must NOT do: do not make repo public; do not add secrets; do not add to global opencode config; do not re-run `gh repo create` if origin already exists; do not create a duplicate initial commit if one already exists

  Recommended Agent Profile: Category git; Skills none

  Parallelization: NO (bootstrap) | Blocks: 1 | Blocked By: None

  References: gh 2.96.0 authenticated (Astroreen, scope repo); node v24.16.0; bun 1.3.13; git 2.54.0; global git identity EMPTY (set locally)

  Acceptance Criteria:
  - [ ] git remote -v -> origin points to github.com/Astroreen/astrocode
  - [ ] gh repo view Astroreen/astrocode --json visibility -q .visibility -> "PRIVATE"
  - [ ] git push succeeds (branch main tracked)

  QA Scenarios:
  Scenario: repo is private and pushed (happy path)
    Tool: Bash
    Steps: 1) gh repo view Astroreen/astrocode --json visibility,name  2) Assert visibility=="PRIVATE", name=="astrocode"  3) git ls-remote origin main -> returns a commit sha
    Expected: private repo exists, main pushed
    Evidence: .sisyphus/evidence/task-0-repo.txt
  Scenario: local identity set, not global (edge)
    Tool: Bash
    Steps: 1) git config --local user.email -> "ilja.zoludev@gmail.com"  2) git config --global user.email -> still empty
    Evidence: .sisyphus/evidence/task-0-identity.txt

  Commit: YES — chore: initial commit (plan + scaffold) — files: all; Pre-commit: none

- [x] 1. Scaffold project + bun test infrastructure

  What to do:
  - package.json (type module; name astrocode; scripts test:bun test, typecheck:tsc --noEmit; devDeps @opencode-ai/plugin, typescript, @types/bun)
  - tsconfig.json (target ESNext, module ESNext, moduleResolution bundler, strict, noEmit)
  - Dirs already created: src/, src/models/, src/prompts/, agents/, test/
  - test/smoke.test.ts asserting 1+1===2
  - .gitignore (node_modules, dist, .sisyphus/evidence, bun.lockb)

  Must NOT do: no source logic; no plugin code; no bundler tooling (Bun runs TS directly)

  Recommended Agent Profile: Category quick; Skills none

  Parallelization: NO (foundation) | Blocks: 2,3,4,5 | Blocked By: 0

  References: meridian.ts (standalone TS opencode plugin, no build) — home/modules/terminal/ai/meridian.nix; installed types ~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts (read for Plugin/Hooks type)

  Acceptance Criteria:
  - [ ] bun test runs, 1 test passes
  - [ ] bunx tsc --noEmit -> 0 errors

  QA Scenarios:
  Scenario: bun test runs on fresh scaffold (happy path)
    Tool: Bash; Preconditions: bun install done
    Steps: 1) bun test  2) Assert exit 0 and output contains "1 pass"
    Expected: exit 0, "1 pass, 0 fail"; Evidence: .sisyphus/evidence/task-1-bun-test.txt
  Scenario: typecheck clean (edge)
    Tool: Bash; Steps: 1) bunx tsc --noEmit  2) Assert exit 0, empty output; Evidence: .sisyphus/evidence/task-1-typecheck.txt

  Commit: YES — chore(scaffold): init astrocode plugin project — files: package.json, tsconfig.json, .gitignore, test/smoke.test.ts; Pre-commit: bun test

- [x] 2. SPIKE — resolve hook semantics (A1/A2/A3) + lock getGuards contract [GATE]

  What to do:
  - Throwaway probe plugin implementing experimental.chat.system.transform writing to /tmp/astrocode-spike-dump.json: the FULL output.system array (before mutation), input.model.{providerID,modelID}, input.sessionID
  - Run opencode with probe active in a scratch project: (a) a primary chat turn, (b) a task(subagent_type="explore", ...) turn
  - Answer: A1 base prompt pre-filled (mutate) vs empty (replace)? A2 does hook fire for subagents from task()? A3 if a native .md agent active, does its body appear in output.system (duplication risk)?
  - Based on A2: if hook fires for subagents -> guards reach subagents; if NOT -> guards primary-only, personas still .md (AD-2 unchanged, only guard reach differs)
  - Write docs/spike-findings.md with A1/A2/A3 answers + final getGuards(family): string[] contract signature

  Must NOT do: do not build the real plugin here; keep probe under spike/

  Recommended Agent Profile: Category deep; Skills none

  Parallelization: NO (gate) | Blocks: 5,6,7,8 | Blocked By: 1

  References: opencode-claude-auth output.system.unshift(...) (mutate proof); OMO transforms.js:82-94 prepend+concatenate comment; ~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts ~line 197; WHY: A2 is the critical unknown — sessionID? optional, subagent firing must be measured

  Acceptance Criteria:
  - [ ] docs/spike-findings.md with concrete A1/A2/A3 answers (each YES/NO + evidence line)
  - [ ] getGuards(family): string[] contract documented
  - [ ] /tmp/astrocode-spike-dump.json captured with >=1 primary-turn entry

  QA Scenarios:
  Scenario: probe captures primary-turn system array (A1)
    Tool: Bash + opencode session; Preconditions: probe referenced in scratch .opencode/opencode.jsonc
    Steps: 1) Start opencode on a claude model, send one message  2) jq '.[0].system | length' /tmp/astrocode-spike-dump.json  3) Assert length > 0 (base pre-filled -> mutate)
    Expected: non-empty -> A1=mutate; Evidence: .sisyphus/evidence/task-2-a1-dump.json
  Scenario: subagent firing check (A2) — the gate
    Tool: Bash + opencode session; Steps: 1) Trigger task(subagent_type="explore", prompt="list files")  2) jq '[.[] | select(.sessionID != .[0].sessionID)] | length' /tmp/astrocode-spike-dump.json  3) Record binary answer in spike-findings.md
    Expected: A2 recorded (YES fires / NO does not; inconclusive -> treat as NO, guards primary-only); Evidence: .sisyphus/evidence/task-2-a2-dump.json

  Commit: YES — docs(spike): hook semantics + getGuards contract — files: docs/spike-findings.md, spike/; Pre-commit: none

- [x] 3. resolveFamily() model-family router + unit tests

  What to do:
  - src/models/resolveFamily.ts: export function resolveFamily(model: {providerID: string; modelID: string}): "claude" | "cheap-openrouter" | "fallback" per AD-3
  - Case-insensitive substring; deterministic; total (never throws)
  - TDD: test/resolveFamily.test.ts FIRST (RED) — all three families + unknown

  Must NOT do: no network; no model-registry read; pure function; no families beyond three

  Recommended Agent Profile: Category unspecified-high; Skills none

  Parallelization: YES (Wave 2A) | Blocks: 5,8 | Blocked By: 1

  References: AD-3 (allowlist substrings); WHY: deterministic core the plugin branches on; fallback = most defensive

  Acceptance Criteria (TDD):
  - [ ] test/resolveFamily.test.ts created
  - [ ] bun test test/resolveFamily.test.ts -> PASS

  QA Scenarios:
  Scenario: family resolution correctness (happy path)
    Tool: Bash (bun test); Steps: 1) bun test test/resolveFamily.test.ts  2) Assert {anthropic,claude-sonnet-4-6}->"claude"; {openrouter,deepseek/deepseek-chat}->"cheap-openrouter"; {openrouter,z-ai/glm-4.6}->"cheap-openrouter"
    Expected: all pass; Evidence: .sisyphus/evidence/task-3-resolvefamily.txt
  Scenario: unknown model -> fallback (edge)
    Tool: Bash (bun test); Steps: 1) Assert resolveFamily({providerID:"foo",modelID:"bar-99"})==="fallback"  2) Assert resolveFamily({providerID:"",modelID:""})==="fallback" (no throw)
    Expected: "fallback", no exception; Evidence: .sisyphus/evidence/task-3-fallback.txt

  Commit: YES — feat(models): add resolveFamily router — files: src/models/resolveFamily.ts, test/resolveFamily.test.ts; Pre-commit: bun test test/resolveFamily.test.ts

- [x] 4. Guard strings (verbatim) + prompt-dump side-channel

  What to do:
  - src/prompts/guards.ts: getGuards(family): string[] — verbatim from OMO bundle (KIMI_TOOL_LOOP_GUARD, GPT_APPLY_PATCH_GUIDANCE). Map: cheap-openrouter -> [tool-loop, explicit-tool-call-format]; fallback -> all (most defensive); claude -> []
  - Extract verbatim by grepping ~/.cache/opencode/node_modules/oh-my-openagent/dist/index.js for the guard constant names
  - src/prompts/dump.ts: dumpPrompt(entry) appends JSON line to ASTROCODE_DUMP env path (default /tmp/astrocode-prompt-dump.json); no-op if env unset
  - TDD: test/guards.test.ts — family->guard mapping + idempotency helper

  Must NOT do: no paraphrasing guards (verbatim only); no apply-patch guidance if the target model lacks apply_patch tool

  Recommended Agent Profile: Category unspecified-high; Skills none

  Parallelization: YES (Wave 2A) | Blocks: 5,8 | Blocked By: 1

  References: OMO bundle grep source; AD-3; Metis edge-case (apply-patch only if tool present); WHY: guards are OMO's empirically-tuned value for weak models — verbatim preserves tuning

  Acceptance Criteria (TDD):
  - [ ] test/guards.test.ts -> PASS
  - [ ] cheap-openrouter contains anti-tool-loop text; claude empty; fallback = superset

  QA Scenarios:
  Scenario: guard mapping per family (happy path)
    Tool: Bash (bun test); Steps: 1) bun test test/guards.test.ts  2) Assert getGuards("claude").length===0; getGuards("cheap-openrouter") contains tool-loop substring; getGuards("fallback").length >= getGuards("cheap-openrouter").length
    Expected: all pass; Evidence: .sisyphus/evidence/task-4-guards.txt
  Scenario: dump writes valid JSON line (happy path)
    Tool: Bash (bun test); Steps: 1) ASTROCODE_DUMP=/tmp/t4-dump.json; dumpPrompt({family:"claude",system:["x"]})  2) jq . /tmp/t4-dump.json -> valid JSON with family field
    Expected: valid JSON entry; Evidence: .sisyphus/evidence/task-4-dump.json

  Commit: YES — feat(prompts): verbatim guards + dump side-channel — files: src/prompts/guards.ts, src/prompts/dump.ts, test/guards.test.ts; Pre-commit: bun test test/guards.test.ts

- [x] 5. Plugin entry src/index.ts — system.transform append + chat.params

  What to do:
  - Default-export Plugin returning Hooks:
    - experimental.chat.system.transform: family = resolveFamily(input.model), push each getGuards(family) block onto output.system (append per AD-1), then dumpPrompt(...) if dump env set
    - chat.params: sampling per family (cheap-openrouter: temperature ~0.3 + explicit topP; claude: leave defaults)
  - Defensive wrapper: try/catch + shape checks (if (!output || !Array.isArray(output.system)) { log; return; }) -> API-shape change = no-op + log, never crash
  - Idempotency: sentinel-mark injected guards; skip if already present
  - TDD: test/index.test.ts — call hook with fake input/output, assert mutation

  Must NOT do: no wiping output.system (append only); no custom tool registration; no notification/background/parallel logic

  Recommended Agent Profile: Category deep; Skills none

  Parallelization: NO (integrates 3+4) | Blocks: 8 | Blocked By: 2,3,4

  References: SDK dist/index.d.ts (Plugin,Hooks,experimental.chat.system.transform,chat.params); docs/spike-findings.md; meridian.ts export shape; WHY: mutate-in-place + defensive wrapper are the stability guarantees motivating this project

  Acceptance Criteria (TDD):
  - [ ] test/index.test.ts -> PASS
  - [ ] appends guards for cheap model, leaves claude untouched, no-ops on malformed output

  QA Scenarios:
  Scenario: hook appends guards for cheap model (happy path)
    Tool: Bash (bun test); Steps: 1) output={system:["BASE"]}, input={model:{providerID:"openrouter",modelID:"deepseek/deepseek-chat"}}  2) Invoke hook; assert output.system[0]==="BASE" AND output.system.some(s=>s.includes(tool-loop guard))
    Expected: base preserved + guard appended; Evidence: .sisyphus/evidence/task-5-append.txt
  Scenario: malformed output -> no crash (edge)
    Tool: Bash (bun test); Steps: 1) Invoke hook with output={} (no system array)  2) Assert no throw, returns cleanly
    Expected: graceful no-op; Evidence: .sisyphus/evidence/task-5-graceful.txt
  Scenario: idempotent re-invocation (edge)
    Tool: Bash (bun test); Steps: 1) Invoke hook twice on same output object (cheap model)  2) Assert guard block appears exactly once
    Expected: no duplication; Evidence: .sisyphus/evidence/task-5-idempotent.txt

  Commit: YES — feat(plugin): model-aware system.transform + chat.params — files: src/index.ts, test/index.test.ts; Pre-commit: bun test

- [x] 6. MVP agent personas (.md) — sisyphus, explore, librarian, oracle, prometheus

  What to do:
  - Each agents/{name}.md: frontmatter (description, mode: subagent or all for sisyphus/prometheus, temperature, tools allowlist, optional model: override per AgentConfig.model schema — https://opencode.ai/config.json $defs.AgentConfig) + markdown body
  - Extract base persona intent from OMO bundle (dist/agents/{name}/, dist/index.js), ADAPT per AD-4: strip parallel/background/delegate-orchestration; rewrite delegation to native synchronous task
  - Keep prompts model-agnostic (plugin adds guards at runtime) — no per-model guard text in .md

  Must NOT do: no parallelism/background instructions; no OMO-only tools (background_output, delegate-task); no model-specific guards

  Recommended Agent Profile: Category writing; Skills none

  Parallelization: YES (Wave 2B) | Blocks: 8 | Blocked By: 2

  References (verified via GitHub source, repo https://github.com/code-yeongyu/oh-my-openagent — public, MIT):
  - explore: `packages/omo-opencode/src/agents/explore.ts` (trivial — single inline string literal in `createExploreAgent()`)
  - librarian: `packages/omo-opencode/src/agents/librarian.ts` (trivial — single inline string literal in `createLibrarianAgent()`)
  - oracle: `packages/omo-opencode/src/agents/oracle.ts` (trivial — `ORACLE_DEFAULT_PROMPT` / `ORACLE_GPT_PROMPT` / `ORACLE_GPT_5_5_PROMPT`; use `ORACLE_DEFAULT_PROMPT`)
  - prometheus: `packages/prompts-core/prompts/prometheus/default.md` (trivial — single markdown file, no composition, loaded via `loadPromptSync()`)
  - sisyphus (HARDEST — dynamically assembled, do NOT expect a single copyable string): router `packages/omo-opencode/src/agents/sisyphus-agent-factory.ts` -> `sisyphus-dynamic-prompt-builder.ts` calling `buildSisyphusDynamicPromptContent()` -> `sisyphus-dynamic-prompt-sections.ts` (13 section-builder functions, mostly from shared `dynamic-agent-prompt-builder.ts`: agentIdentity, antiPatterns, categorySkillsGuide, delegationTable, exploreSection, hardBlocks, keyTriggers, librarianSection, nonClaudePlannerSection, oracleSection, parallelDelegationSection, taskManagementSection, toolSelection) -> 4 render layers `sisyphus-dynamic-prompt-{role,exploration,execution,style}.ts` -> model-variant body, use `sisyphus/default.ts` (Claude/default variant; ignore the other 9 model-variant files under `sisyphus/`). Executor MUST read `sisyphus-dynamic-prompt-sections.ts` first to learn the assembly ORDER, then concatenate section outputs, THEN apply AD-4 strip (drop `parallelDelegationSection` and any task/delegate-parallel content entirely — these sections exist specifically for the machinery this plan drops).
  - IMPORTANT — do NOT use `~/.cache/opencode/node_modules/oh-my-openagent/dist/agents/*.d.ts` as a prompt-text source: verified locally these are TYPE-ONLY declarations (no literal prompt strings) for explore/librarian/oracle/sisyphus; only `momus.d.ts` happens to inline its prompt (see Task 7). Use the GitHub paths above instead.
  - existing `home/astroreen/profiles/terminal/ai/agents/PromptMaster.md`, `PromptHardener.md` (frontmatter format reference)
  - AD-4 (strip all parallel/background/delegate-orchestration instructions; rewrite around native synchronous `task` tool)
  - WHY: personas are priority #1; native .md = stable delivery

  Acceptance Criteria:
  - [ ] 5 .md files with valid frontmatter (parseable)
  - [ ] grep -iE "background_output|delegate-task|run_in_background|parallel wave" agents/*.md -> 0 matches
  - [ ] frontmatter parses cleanly whether or not model: is present (optional field per AgentConfig schema — no default forced by this task, resolvable also via opencode.jsonc agent.<name>.model)

  QA Scenarios:
  Scenario: personas load in opencode (happy path)
    Tool: interactive_bash (opencode session); Preconditions: agents/ copied to project .opencode/agents/
    Steps: 1) Start opencode, run task subagent_type=explore prompt="find README"  2) Assert agent responds in-character and completes
    Expected: explore agent loads and runs; Evidence: .sisyphus/evidence/task-6-explore-load.txt
  Scenario: no forbidden parallelism instructions (guardrail)
    Tool: Bash; Steps: 1) grep -iE "background_output|delegate-task|run_in_background" agents/*.md  2) Assert exit code 1 (no matches)
    Expected: no matches; Evidence: .sisyphus/evidence/task-6-no-parallelism.txt

  Commit: YES — feat(agents): MVP personas — files: agents/*.md; Pre-commit: grep guardrail

- [x] 7. Extended agent personas (.md) — atlas, momus, metis, multimodal-looker, sisyphus-junior, hephaestus

  What to do: same as Task 6 for the extended set. multimodal-looker may need a tools allowlist reflecting its role; sisyphus-junior is the delegated-worker persona (reference synchronous task only)

  Must NOT do: same guardrails as Task 6

  Recommended Agent Profile: Category writing; Skills none

  Parallelization: YES (Wave 2B) | Blocks: 8 | Blocked By: 2

  References (verified via GitHub source, repo https://github.com/code-yeongyu/oh-my-openagent — public, MIT):
  - atlas (HARD — markdown base + runtime injections): `packages/prompts-core/prompts/atlas/default.md` (use this variant; siblings `gpt.md`/`gemini.md`/`kimi.md`/`kimi-k2-7.md`/`opus-4-7.md`/`glm.md` are other model variants, skip) + `packages/omo-opencode/src/agents/atlas/agent.ts` (variant router) + `prompt-section-builder.ts` (fills runtime `{PLACEHOLDER}` tokens). Strip any placeholder that expands to parallel/delegate content per AD-4.
  - momus: `packages/omo-opencode/src/agents/momus.ts` -> `MOMUS_DEFAULT_PROMPT` constant (already fully extracted verbatim during this planning session — ~4000-word plan-reviewer prompt, no further lookup needed; use as-is). Ignore `momus-gpt-5-6.ts` (GPT variant, not needed).
  - metis: `packages/omo-opencode/src/agents/metis.ts` -> `METIS_SYSTEM_PROMPT` constant (default variant; ignore `METIS_K2_7_SYSTEM_PROMPT`, that's the Kimi variant)
  - multimodal-looker: `packages/omo-opencode/src/agents/multimodal-looker.ts` (trivial — single inline string literal in `createMultimodalLookerAgent()`)
  - sisyphus-junior (MODERATE — self-contained model variants, no cross-file assembly): `packages/omo-opencode/src/agents/sisyphus-junior/agent.ts` (router) + `default.ts` (use this variant; ignore `gpt.ts`/`gpt-5-4.ts`/`gpt-5-5.ts`/`gemini.ts`/`glm-5-2.ts`/`kimi-k2-6.ts`/`kimi-k2-7.ts` — other model variants)
  - hephaestus (MODERATE): `packages/omo-opencode/src/agents/hephaestus/agent.ts` (router) + `gpt.ts` (use as base variant; `gpt-5-4.ts`/`gpt-5-5.ts`/`gpt-5-6.ts` are other GPT-version variants, skip — note hephaestus has no plain-Claude variant in source, adapt from `gpt.ts` and strip GPT-specific tool guidance)
  - IMPORTANT — do NOT use `~/.cache/opencode/node_modules/oh-my-openagent/dist/agents/*.d.ts` as a prompt-text source for atlas/metis/multimodal-looker/sisyphus-junior/hephaestus: verified locally these are TYPE-ONLY declarations (no literal prompt strings); only `momus.d.ts` happens to inline its prompt, which is why momus above already has a ready-made string.
  - same frontmatter pattern as Task 6

  Acceptance Criteria:
  - [ ] 6 .md files with valid frontmatter
  - [ ] grep guardrail (no parallelism tokens) -> 0 matches

  QA Scenarios:
  Scenario: extended personas parse (happy path)
    Tool: Bash; Steps: 1) For each file, parse the frontmatter --- block; assert has description + mode
    Expected: all parse, required fields present; Evidence: .sisyphus/evidence/task-7-frontmatter.txt
  Scenario: guardrail grep (no parallelism)
    Tool: Bash; Steps: 1) grep -iE "background_output|delegate-task|run_in_background" agents/{atlas,momus,metis,multimodal-looker,sisyphus-junior,hephaestus}.md  2) Assert no matches
    Evidence: .sisyphus/evidence/task-7-no-parallelism.txt

  Commit: YES — feat(agents): extended personas — files: agents/*.md; Pre-commit: grep guardrail

- [ ] 8. Integration wiring + prompt-swap integration QA

  What to do:
  - Reference src/index.ts from a scratch project .opencode/opencode.jsonc plugin array; copy agents/ to that project's .opencode/agents/
  - Run REAL opencode sessions with ASTROCODE_DUMP set: one Claude model, one cheap OpenRouter (deepseek/glm)
  - Assert via dump: guard text present for cheap, ABSENT for Claude; base preserved both; persona .md body present when that agent active
  - Verify model-switch mid-session -> new family prompt (not cached by sessionID)

  Must NOT do: no global opencode config change; scratch project only

  Recommended Agent Profile: Category deep; Skills none

  Parallelization: NO | Blocks: 9,10 | Blocked By: 5,6,7

  References: docs/spike-findings.md; dump format (Task 4); AD-3; WHY: only proof the dynamic layer works against the real frozen runtime

  Acceptance Criteria:
  - [ ] Dump shows guard present for cheap, absent for claude
  - [ ] Base preserved both dumps
  - [ ] Model-switch -> updated family prompt

  QA Scenarios:
  Scenario: prompt swaps by model (happy path)
    Tool: interactive_bash (opencode) + Bash (jq); Preconditions: plugin + agents wired in scratch project, ASTROCODE_DUMP set
    Steps: 1) Session A claude-sonnet: send message -> dump entry A  2) Session B openrouter deepseek: send message -> dump entry B  3) jq assert: B system contains tool-loop guard; A does NOT
    Expected: cheap has guard, claude doesn't; both retain base; Evidence: .sisyphus/evidence/task-8-swap-dumps.json
  Scenario: mid-session model switch (edge)
    Tool: interactive_bash + jq; Steps: 1) In one session switch claude->deepseek, send message after each  2) Assert two dump entries with differing family
    Expected: family updates on switch (no stale cache); Evidence: .sisyphus/evidence/task-8-switch.json

  Commit: YES — test(integration): prompt-swap e2e — files: scratch config, evidence; Pre-commit: bun test

- [ ] 9. README — usage + nix meridian-pattern snippet + version-pin note

  What to do:
  - Document: what astrocode is; architecture (hybrid .md personas + thin plugin); per-project enable (.opencode/opencode.jsonc plugin entry + copy agents); env vars (ASTROCODE_DUMP)
  - NixOS wiring snippet (meridian-pattern): home.activation clone/install + copy agents/ to ~/.config/opencode/agents/, referencing home/modules/terminal/ai/meridian.nix
  - Version-pin caveat: experimental.chat.system.transform is experimental -> pin opencode in nix; plugin degrades gracefully (no-op) if hook shape changes
  - Document per-agent model override (model: field in frontmatter / agent.<name>.model in opencode.jsonc) and summarize Task 11's model-fallback feasibility verdict + recommended approach (native retry design OR OpenRouter models: [...] array)

  Must NOT do: no instruction to add to global programs.opencode.settings.plugin

  Recommended Agent Profile: Category writing; Skills none

  Parallelization: NO | Blocks: 10 | Blocked By: 8, 11

  References: home/modules/terminal/ai/meridian.nix (activation-clone-install); AD-1..AD-4; docs/fallback-spike-findings.md (Task 11 output); WHY: user deploys via nix — needs copy-paste-ready snippet; fallback recommendation must be documented so user knows the actual mechanism (native or OpenRouter-level)

  Acceptance Criteria:
  - [ ] README covers purpose, architecture, per-project enable, nix snippet, version-pin caveat
  - [ ] nix snippet references meridian pattern explicitly
  - [ ] README documents model: override field and Task 11's fallback recommendation (grep README.md for "fallback")

  QA Scenarios:
  Scenario: README completeness (happy path)
    Tool: Bash (grep); Steps: 1) grep README.md for "Architecture", ".opencode/opencode.jsonc", "home.activation", "experimental", "version"  2) Assert all present
    Expected: all sections present; Evidence: .sisyphus/evidence/task-9-readme.txt

  Commit: YES — docs(readme): usage + nix deploy + version-pin — files: README.md; Pre-commit: none

- [ ] 10. Validate nix deployment snippet

  What to do:
  - Put the meridian-pattern snippet in a scratch copy (do NOT modify the live nixos repo unless user asks); document exact target file (home/modules/terminal/ai/astrocode.nix) + where to import
  - Provide home build laptop / nixos dry-build laptop as the verify command the user runs

  Must NOT do: do not run home switch/nixos switch; do not commit into the nixos repo

  Recommended Agent Profile: Category quick; Skills none

  Parallelization: NO | Blocks: F1-F4 | Blocked By: 8,9

  References: home/modules/terminal/ai/meridian.nix; nixos AGENTS.md (home build laptop)

  Acceptance Criteria:
  - [ ] README deployment block finalized with exact target file + home build laptop verify step

  QA Scenarios:
  Scenario: nix snippet documented (happy path)
    Tool: Bash (grep); Steps: 1) grep README for "home build laptop" and "home.activation"  2) Assert present
    Evidence: .sisyphus/evidence/task-10-nix-doc.txt

  Commit: YES — docs(deploy): finalize nix wiring guidance — files: README.md; Pre-commit: none

- [x] 11. SPIKE — model-fallback feasibility via plugin hooks

  What to do:
  - Re-verify the full @opencode-ai/plugin Hooks surface (~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts): event, config, experimental.chat.messages.transform, experimental.chat.system.transform, experimental.session.compacting, experimental.text.complete. Grep specifically for any error/retry/onError-shaped field that may have been missed.
  - Determine: is there a hook that fires BEFORE the model call is dispatched (interceptable) vs only AFTER a response/error is already final (too late to retry with a different model)?
  - Cross-check the official core config schema (https://opencode.ai/config.json, $defs.AgentConfig / $defs.ProviderConfig / top-level Config) to confirm (already done once this session) there is no native fallback/fallback_models field — re-confirm still true, note schema fetch timestamp.
  - Review OMO's own oh-my-opencode.schema.json (~/.cache/opencode/node_modules/oh-my-openagent/dist/oh-my-opencode.schema.json) model_fallback/fallback_models keys as a reference for what a hand-rolled fallback config shape could look like — reference only, do not copy OMO's implementation code.
  - Verdict: if a viable interception point exists -> design (do NOT implement) a getFallbackModel(family): string contract + note which hook it would attach to. If NOT viable -> document why, and recommend OpenRouter's provider-level `models: [...]` fallback array (https://openrouter.ai/docs) as the practical alternative, including an example config snippet for how the user would list a primary + fallback model for their cheap-openrouter family.
  - Write docs/fallback-spike-findings.md: hooks evaluated, feasibility verdict (YES/NO/PARTIAL), evidence per hook, final recommendation.

  Must NOT do:
  - Do not implement actual fallback retry logic in src/index.ts or resolveFamily.ts in this task — SPIKE scope is investigation + documentation only
  - Do not change AD-3's "fallback" family meaning (defensive-guard classification for unknown models) — this task's "fallback" (model-availability failover) is a distinct concept, keep them clearly separated in the findings doc

  Recommended Agent Profile: Category deep; Skills none
  - Reason: same research-and-decide nature as Task 2's SPIKE — requires reading SDK types, cross-referencing schemas, and producing a reasoned verdict, not routine implementation

  Parallelization: YES (Wave 2A, with Tasks 3,4) | Blocks: 9 | Blocked By: 2

  References:
  - ~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts — full Hooks list (already enumerated this session: no error/retry hook found)
  - https://opencode.ai/config.json — official Config/AgentConfig/ProviderConfig schema (confirmed this session: no fallback/fallback_models field anywhere)
  - ~/.cache/opencode/node_modules/oh-my-openagent/dist/oh-my-opencode.schema.json — OMO's own model_fallback/fallback_models keys (reference for shape only, not implementation)
  - https://openrouter.ai/docs — OpenRouter's `models: [...]` provider-level fallback array (candidate recommendation if no clean plugin hook exists)
  - WHY: user asked to verify default-model-per-agent AND fallback-model configurability; default-per-agent is confirmed native (Task 6/7 model: field), fallback is NOT — this SPIKE settles whether astrocode can still deliver it some other way before committing to "not supported"

  Acceptance Criteria:
  - [ ] docs/fallback-spike-findings.md created with explicit "Feasibility: YES|NO|PARTIAL" line + evidence per hook checked
  - [ ] If YES/PARTIAL: getFallbackModel(family): string contract documented (signature only, not implemented)
  - [ ] If NO: OpenRouter models: [...] alternative documented with a concrete example snippet
  - [ ] grep -riE "getFallbackModel|fallback_models|model_fallback" src/ -> 0 matches (no implementation leaked into plugin code)

  QA Scenarios:
  Scenario: findings doc exists with explicit verdict (happy path)
    Tool: Bash
    Preconditions: Task 11 complete
    Steps: 1) test -f docs/fallback-spike-findings.md  2) grep -E "Feasibility: (YES|NO|PARTIAL)" docs/fallback-spike-findings.md
    Expected: file exists, verdict line present with one of YES/NO/PARTIAL; Evidence: .sisyphus/evidence/task-11-findings.txt
  Scenario: no fallback implementation leaked into plugin source (guardrail/edge)
    Tool: Bash
    Steps: 1) grep -riE "getFallbackModel|fallback_models|model_fallback" src/  2) Assert exit 1 (no matches)
    Expected: no matches — SPIKE stayed docs-only; Evidence: .sisyphus/evidence/task-11-no-impl.txt

  Commit: YES — docs(spike): model-fallback feasibility investigation — files: docs/fallback-spike-findings.md; Pre-commit: none

---

## Final Verification Wave (MANDATORY — after ALL tasks)

- [ ] F1. Plan Compliance Audit — oracle
  Read plan end-to-end. Each Must Have -> verify exists (read file/run command). Each Must NOT Have -> grep for forbidden patterns (parallelism, delegate-task, global plugin entry) — reject with file:line if found. Check evidence files exist.
  Output: Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT

- [ ] F2. Code Quality Review — unspecified-high
  bunx tsc --noEmit + bun test. Review changed files for as any/@ts-ignore, empty catches (except intentional defensive wrappers — verify they log), dead code, generic names.
  Output: Build [P/F] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT

- [ ] F3. Real Manual QA — unspecified-high
  Clean state. Execute EVERY task's QA scenarios; capture evidence. Cross-cutting: personas + plugin together in one session (persona .md body + family guards both in dump). Edge: unknown model->fallback guards, mid-session switch.
  Output: Scenarios [N/N] | Integration [N/N] | Edge [N] | VERDICT

- [ ] F4. Scope Fidelity Check — deep
  Per task: "What to do" vs git diff — 1:1, nothing missing, nothing beyond spec. Confirm Must NOT compliance (no OMO machinery crept in). Flag unaccounted changes.
  Output: Tasks [N/N] | Contamination [CLEAN/N] | Unaccounted [CLEAN/N] | VERDICT

-> Present consolidated results -> get explicit user okay before marking complete.

---

## Commit Strategy
- Per-task commits as listed. Conventional-commit style. Push to private GitHub repo (Astroreen) astrocode.

## Success Criteria

### Verification Commands
```
bun test                 # Expected: all pass
bunx tsc --noEmit        # Expected: 0 errors
grep -riE "background_output|delegate-task|run_in_background" agents/ src/  # Expected: no matches
jq . /tmp/astrocode-prompt-dump.json  # Expected: valid dump entries
gh repo view Astroreen/astrocode --json visibility -q .visibility  # Expected: PRIVATE
```

### Final Checklist
- [ ] All Must Have present
- [ ] All Must NOT Have absent
- [ ] All tests pass, tsc clean
- [ ] Prompt-swap proven via dump
- [ ] Repo pushed private to GitHub
