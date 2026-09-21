# astrocode — Safe oh-my-openagent Parity Features (11 items)

## TL;DR

> **Quick Summary**: Port 11 additional oh-my-openagent features into astrocode that are **robust by construction** — pure functions, filesystem-only reads, and simple in-memory state. Explicitly EXCLUDES everything fragile (team-mode, DAG scheduler, durable mailbox, boulder-state, memory-core, ralph-loop, multi-process runners, tmux, config profiles/harness views, Zod validation). astrocode's deliberate dropping of parallelism is CORRECT BY DESIGN and stays dropped.
>
> **Deliverables**:
> - `src/models/resolveVersion.ts` — version-level model detection (pure)
> - `src/prompts/sisyphus/families/versions/*.ts` — thin version-specific Sisyphus calibration builders
> - `src/models/tuning.ts` — reasoning-level ladder (`REASONING_LEVELS`, `clampReasoningLevel`, `splitReasoningSuffix`)
> - `src/fallback/canonicalize.ts` — model-id canonicalization for fallback equivalence
> - `src/fallback/classify.ts` — `classifyError()` producing `terminal_quota | non_terminal | context_overflow | not_retryable`
> - `src/context/agentsmd.ts` — AGENTS.md walk-up context injector
> - `src/idle/constants.ts` + backoff/abort-window gates in `src/idle/continue.ts` and `src/fallback/state.ts`
> - `src/skills/extra.ts` — explicit numeric skill-source priority + bundled builtin catalog
> - `skills/builtin/{commit-message,code-review,verify-before-done}/SKILL.md`
> - `src/config/astrocode.ts` — walk-up multi-layer config merge
> - New/updated `test/*.test.ts`; all green; `tsc --noEmit` 0 errors
>
> **Estimated Effort**: Medium (~1.5-2 focused days)
> **Parallel Execution**: YES — Wave 1 (Tier 0 pure) → Wave 2 (Tier 1 fs/in-memory) → Wave 3 (Tier 2 config) → Wave 4 integration
> **Critical Path**: T1 → T2 → T12 (integration). T3/T4/T5 independent of T1/T2. T10 depends on T9. T11 independent.

---

## Context

### Original Request

User (astroreen) owns `astrocode` (`/home/astroreen/Documents/opencode/astrocode`), a deliberately small, stable opencode plugin that reimplements the *useful, non-fragile* parts of `oh-my-openagent` (OMO). User's authoritative framing (verbatim):

> "Цель astrocode плагина - реализовать большую часть oh-my-openagent, но не реализовать сложные и хрупкие вещи по типу параллелизма. То что astrocode это урезанная версия oh-my-openagent так и должно быть, нужно оставить только самое нужно и то что не сломается так просто как вызовы параллельных агентов. Теперь скажи, какие еще функции из оригинала можно реализовать, которые не сломаются от любого чиха и будут работать и дальше?"

User then approved all 11 proposed features (verbatim):

> "Ок, давай сделаешь все 11 изменений, мне все нравятся. Создавай план, исползуй dcp чтобы сократить контекст и будем потом работать"

### Approved Scope (11 features, 3 risk tiers)

**TIER 0 — pure functions, zero fragility**
1. Version-level model detection within families (claude opus-4-7/4-8/5/fable/mythos, kimi k2.6/k2.7/k2.8/k3/swe-2, grok 4.5 vs 4.6, minimax).
2. Version-specific Sisyphus prompt builders + dispatch routing.
3. Reasoning-level ladder in `tuning.ts`.
4. Model-id canonicalization for fallback equivalence.
5. `terminal_quota` vs `non_terminal` error classification.

**TIER 1 — filesystem-only reads / simple in-memory state**
6. AGENTS.md walk-up context injector.
7. Exponential backoff + consecutive-failure cap (fallback + idle).
8. Abort-window gate in idle continuation.
9. Explicit numeric skill-source priority.
10. Bundled builtin-skills catalog.

**TIER 2 — slightly more complex, still filesystem-only, no locks/IPC**
11. Walk-up multi-layer config merge.

### Reference Source (read-only)

OMO source is cloned at `/tmp/oh-my-openagent`. Load-bearing reference files:
- `packages/model-core/src/model-family-detectors.ts` — version regexes (claude-opus-4-7/4-8/5, claude-fable/mythos, kimi k2.6/2.7/2.8/k3/swe-2, grok-4-5/4-6 digit-boundary, minimax, gemini).
- `packages/model-core/src/reasoning-level.ts` — `REASONING_LEVELS`, `clampReasoningLevel`, `splitReasoningSuffix`.
- `packages/model-core/src/runtime-fallback-model.ts` — `canonicalizeRuntimeFallbackModelID` (strips `-thinking`/`-max`/`-high` for claude-opus/sonnet/haiku), `areRuntimeFallbackModelsEquivalent`.
- `packages/omo-opencode/src/hooks/todo-continuation-enforcer/constants.ts` — `ABORT_WINDOW_MS=3000`, `COMPACTION_GUARD_MS=60000`, `CONTINUATION_COOLDOWN_MS=5000`, `MAX_CONSECUTIVE_FAILURES=5`, `FAILURE_RESET_WINDOW_MS=300000`.
- `packages/omo-opencode/src/hooks/todo-continuation-enforcer/idle-event.ts` — gate order + `effectiveCooldown = CONTINUATION_COOLDOWN_MS * 2 ** min(consecutiveFailures, 5)`.
- `packages/omo-opencode/src/hooks/todo-continuation-enforcer/abort-detection.ts` — `isLastAssistantMessageAborted` (error name `MessageAbortedError`/`AbortError`).
- `packages/omo-opencode/src/hooks/todo-continuation-enforcer/handler.ts` — abort detected via `session.error` event.
- `packages/skills-loader-core/src/features/opencode-skill-loader/AGENTS.md` — 6-tier numeric priority model.
- `packages/omo-config-core/src/loader/loader.ts` + `merge.ts` — walk-up farthest-first merge.

### Current astrocode Surface (verified by direct read)

- `src/models/resolveFamily.ts` — `ModelFamily = claude|gpt|gemini|kimi|glm|openrouter-generic|fallback`; `resolveFamily({providerID, modelID})` substring match; `isCheapSamplingFamily`.
- `src/models/tuning.ts` — `CLAUDE_THINKING_BUDGET_TOKENS=32000`; `reasoningConfigForFamily(family)` (claude→thinking, gpt→reasoningEffort medium, else {}); `DEFAULT_SAMPLING`; `resolveSampling(family, overrides?)`.
- `src/prompts/sisyphus/dispatch.ts` — `SISYPHUS_MARKER`; `isSisyphusSession(system)`; `buildDynamicSisyphusPrompt(family)` switch over 6 family builders.
- `src/prompts/sisyphus/families/{claude,gpt,glm,kimi,gemini,fallback}.ts` — each exports `build<Family>SisyphusPrompt()`; claude.ts is ~397 lines and calls `buildSisyphusSections()`.
- `src/fallback/classify.ts` — `RETRYABLE_ERROR_PATTERNS`, `getErrorMessage`, `getErrorName`, `getStatusCode`, `isRetryableError(error, retryOnErrors)`.
- `src/fallback/index.ts` — `parseModelString`, `resolveFallbackModels`, `pickFallbackModel(candidates, currentModel?)`, `decideFallback(...)`, `dispatchFallback(...)`.
- `src/fallback/state.ts` — `shouldThrottle(sessionID, maxAttempts, cooldownSeconds, now?)`, `recordAttempt`, `getAttemptCount`, `getLastFallbackModel`, `resetAttempts`, `clearAll`.
- `src/idle/continue.ts` — `DEFAULT_MAX_CONTINUATIONS=3`; `maybeContinueIdle(client, sessionID, {max?})`; flat max-count gate; sends on `getLastFallbackModel`.
- `src/skills/extra.ts` — `linkExtraSkillDirs`, `discoverSkills(dirs)` (first-dir-wins dedup), `standardSkillDirs(projectDirs)`.
- `src/config/astrocode.ts` — `CONFIG_FILE_NAMES` (4 names), `sanitizeJsonc`, `loadAstrocodeConfig(searchDirs, inlineOptions?)`, per-agent merge.
- `src/index.ts` — plugin entry; hooks `config`, `event`, `experimental.chat.system.transform`, `chat.params`, `dispose`. Captures `searchDirs` from `input.directory`/`input.worktree` at init.
- `src/env/context.ts` — `ENV_CONTEXT_MARKER="<omo-env>"`, `buildEnvContext()`, `hasEnvContext(system)` (idempotency pattern to mirror).
- Tests: `bun test` (11 files, 103 tests). Typecheck: `bunx tsc --noEmit`.

### Explicit NON-GOALS (do NOT port)

team-mode, DAG scheduler, durable mailbox, boulder-state, memory-core, ralph-loop, multi-process runners, tmux, config `[harness]`/`profiles.<P>` view resolution, Zod validation, prototype-pollution guard beyond `sanitizeJsonc`+`JSON.parse`, any IPC/child-process/file-locking-as-source-of-truth, any long-running background worker.

---

## Work Objectives

### Core Objective

Add 11 robust, non-fragile oh-my-openagent parity features to astrocode without reintroducing parallelism/team-mode fragility. Every new mechanism must be a pure function, a filesystem-only read, or simple in-memory state that degrades to a no-op on error.

### Concrete Deliverables

See TL;DR list. All new modules are pure or fs-only; all hook wiring is wrapped in try/catch no-op (existing convention).

### Definition of Done

- [ ] `bun test` → all pass (existing 103 + new tests)
- [ ] `bunx tsc --noEmit` → 0 errors
- [ ] Every new module has a dedicated test file or added cases in an existing one
- [ ] `experimental.chat.system.transform` dump (via `ASTROCODE_DUMP`) proves AGENTS.md context block is injected once and is idempotent
- [ ] No new runtime dependency added to `package.json`
- [ ] No hook can throw out of the plugin (all wrapped)

### Must Have

- Pure, total, never-throwing functions for all detection/classification logic
- Backward-compatible signatures where existing callers/tests depend on them
- Idempotent system-prompt injection (marker-based, same as `hasEnvContext`)
- Explicit numeric priority for skill sources; collision logged
- Walk-up config merge with nearest-wins semantics

### Must NOT Have (Guardrails)

- NO team-mode / parallel orchestration / background tasks / DAG / mailbox / boulder / memory / ralph-loop / tmux
- NO new npm dependencies
- NO Zod, NO config profiles/harness views, NO prototype-pollution guard beyond existing sanitizer
- NO breaking change to existing exported function signatures without a compatibility wrapper
- NO network calls, NO child processes, NO file locks
- NO deletion of existing behavior; new gates are additive and opt-in where they change runtime behavior

---

## Verification Strategy (MANDATORY)

> ZERO HUMAN INTERVENTION — all verification agent-executed.

### Test Decision

- Infrastructure exists: YES (`bun test`, `bunx tsc --noEmit`)
- Automated tests: YES — every todo adds/extends tests
- Framework: `bun:test` (`import { test, expect, describe, beforeEach } from "bun:test"`)
- Evidence dir: `.sisyphus/evidence/`

### QA Policy

Every todo includes agent-executed QA scenarios (happy + failure). Evidence → `.sisyphus/evidence/task-{N}-{slug}.txt`. Commands are exact and runnable from repo root.

### Global Verification Commands

```bash
bunx tsc --noEmit                 # expect exit 0
bun test                          # expect all pass
```

---

## Execution Strategy

### Wave 1 — Tier 0 (pure functions; parallelizable)

- **T1** Version detection (`resolveVersion.ts`)
- **T3** Reasoning-level ladder (`tuning.ts`)
- **T4** Model canonicalization (`fallback/canonicalize.ts`)
- **T5** Error classification (`fallback/classify.ts`)

### Wave 2 — Tier 0 dependent + Tier 1

- **T2** Version-specific Sisyphus builders (depends on T1)
- **T6** AGENTS.md walk-up injector
- **T7** Exponential backoff + failure cap (fallback + idle)
- **T8** Abort-window gate (idle)
- **T9** Skill-source priority
- **T10** Bundled builtin skills (depends on T9)

### Wave 3 — Tier 2

- **T11** Walk-up config merge

### Wave 4 — Integration

- **T12** Full-suite verification + dump evidence + README/docs update

---

## TODOs

### T1 — Version-level model detection

**Deliverable**: New pure module `src/models/resolveVersion.ts` exporting `ModelVersion` type and `resolveModelVersion(modelID: string): ModelVersion | undefined`.

**Files**:
- CREATE `src/models/resolveVersion.ts`
- CREATE `test/resolveVersion.test.ts`

**References**:
- OMO `/tmp/oh-my-openagent/packages/model-core/src/model-family-detectors.ts` (regexes below)
- astrocode `src/models/resolveFamily.ts` (style: pure, total, never throws)

**Steps**:
1. Define `export type ModelVersion = "claude-opus-4-7" | "claude-opus-4-8" | "claude-opus-5" | "claude-fable" | "claude-mythos" | "kimi-k2-6" | "kimi-k2-7" | "kimi-k2-8" | "kimi-k3" | "kimi-swe-2" | "grok-4-5" | "grok-4-6" | "minimax";`
2. Normalize: `const m = modelID.toLowerCase().replaceAll(".", "-")`.
3. Claude: `m.includes("claude-opus-4-7")` → `claude-opus-4-7`; `claude-opus-4-8`; `claude-opus-5`; `/claude-(?:fable|mythos)-(?:\d+|preview)/` → `claude-fable` / `claude-mythos` (check fable before mythos).
4. Kimi: `/kimi-k2[.\-]?6/` → `kimi-k2-6`; `/kimi-k2[.\-]?7/` → `kimi-k2-7`; `/kimi-k2[.\-]?8/` → `kimi-k2-8`; `/kimi-k3/` → `kimi-k3`; `/^swe-2(?:[-.]|$)/` → `kimi-swe-2`.
5. Grok: `/grok-4-5(?![0-9])/` → `grok-4-5`; `/grok-4-6(?![0-9])/` → `grok-4-6`.
6. Minimax: `m.includes("minimax")` → `minimax`.
7. Return `undefined` when nothing matches. Order matters: check more-specific before less-specific (k2-6/7/8 before k3; opus-4-7/4-8 before opus-5 is NOT needed since strings differ, but keep deterministic order).
8. Guard non-string input: `if (typeof modelID !== "string") return undefined;`

**Acceptance Criteria**:
- `resolveModelVersion("claude-opus-4-7") === "claude-opus-4-7"`, `"claude-opus-4.8"` → `"claude-opus-4-8"`, `"claude-fable-5"` → `"claude-fable"`, `"claude-mythos-preview"` → `"claude-mythos"`.
- `"kimi-k2.7"` → `"kimi-k2-7"`, `"kimi-k3"` → `"kimi-k3"`, `"swe-2"` → `"kimi-swe-2"`.
- `"grok-4.5"` → `"grok-4-5"`, `"grok-4.6-fast"` → `"grok-4-6"`, `"grok-4.20"` → `undefined` (digit boundary).
- `"minimax-m2"` → `"minimax"`; `"gpt-5"` → `undefined`; `""`/`undefined` → `undefined`.

**QA Scenarios**:
- Happy: `bun test test/resolveVersion.test.ts` → all pass. Evidence: `.sisyphus/evidence/task-1-resolveversion.txt`
- Failure: add a test asserting `resolveModelVersion("grok-4.20")` is `undefined`; run and confirm it passes (proves digit-boundary guard). Evidence appended to same file.

**Commit**: `feat(models): add version-level model detection`

---

### T2 — Version-specific Sisyphus prompt builders + dispatch routing

**Deliverable**: Thin version builders under `src/prompts/sisyphus/families/versions/` that compose the existing family builder + a version-specific calibration block; `dispatch.ts` routes by version first, family second.

**Files**:
- CREATE `src/prompts/sisyphus/families/versions/claude-opus-4-7.ts`, `claude-opus-4-8.ts`, `claude-opus-5.ts`, `claude-fable.ts`, `claude-mythos.ts`, `kimi-k2-6.ts`, `kimi-k2-7.ts`, `kimi-k2-8.ts`, `kimi-k3.ts`, `kimi-swe-2.ts`, `grok-4-5.ts`, `grok-4-6.ts`, `minimax.ts`
- CREATE `src/prompts/sisyphus/families/versions/index.ts` (registry)
- MODIFY `src/prompts/sisyphus/dispatch.ts`
- MODIFY `src/index.ts` (pass `modelID` to `buildDynamicSisyphusPrompt`)
- MODIFY `test/sisyphus-dispatch.test.ts`

**References**:
- astrocode `src/prompts/sisyphus/families/claude.ts` (composition pattern: calls `buildSisyphusSections()`)
- astrocode `src/prompts/sisyphus/dispatch.ts`
- OMO `packages/omo-opencode/src/agents/sisyphus/*.ts` (13 version files — reference only; astrocode uses thin deltas, NOT full copies)

**Steps**:
1. Each version file exports `build<Name>SisyphusPrompt(): string` that returns `build<Family>SisyphusPrompt() + "\n\n" + VERSION_CALIBRATION` where `VERSION_CALIBRATION` is a short `<model_version_calibration>` block (5-15 lines) describing that version's known behavior (e.g. opus-4-7+ adaptive thinking; kimi-k3 long-context; grok-4-6 tool-call discipline). Keep each file < 40 lines. Do NOT duplicate the 397-line family body.
2. `versions/index.ts` exports `VERSION_BUILDERS: Partial<Record<ModelVersion, () => string>>` mapping every `ModelVersion` to its builder.
3. `dispatch.ts`: change signature to `buildDynamicSisyphusPrompt(family: ModelFamily, modelID?: string): string`. First compute `const version = modelID ? resolveModelVersion(modelID) : undefined;` then `const versionBuilder = version ? VERSION_BUILDERS[version] : undefined; if (versionBuilder) return versionBuilder();` else fall through to the existing family switch.
4. `src/index.ts`: in `experimental.chat.system.transform`, call `buildDynamicSisyphusPrompt(family, input?.model?.id ?? "")`.
5. Keep `buildDynamicSisyphusPrompt(family)` callable with one arg (modelID optional) so existing tests pass.

**Acceptance Criteria**:
- `buildDynamicSisyphusPrompt("claude", "claude-opus-4-7")` contains the claude family body AND `<model_version_calibration>`.
- `buildDynamicSisyphusPrompt("claude", "claude-sonnet-4-6")` (no version match) returns the plain claude family body (no calibration block).
- `buildDynamicSisyphusPrompt("kimi", "kimi-k3")` contains kimi family body + k3 calibration.
- `buildDynamicSisyphusPrompt("fallback")` still works (one-arg).

**QA Scenarios**:
- Happy: `bun test test/sisyphus-dispatch.test.ts` → pass. Evidence: `.sisyphus/evidence/task-2-sisyphus-versions.txt`
- Failure: assert unknown version falls back to family builder (no calibration marker). Evidence appended.

**Commit**: `feat(prompts): add version-specific Sisyphus calibration builders`

---

### T3 — Reasoning-level ladder

**Deliverable**: Extend `src/models/tuning.ts` with the OMO reasoning ladder and suffix parsing; wire optional level into `reasoningConfigForFamily`.

**Files**:
- MODIFY `src/models/tuning.ts`
- MODIFY `test/tuning.test.ts`

**References**:
- OMO `/tmp/oh-my-openagent/packages/model-core/src/reasoning-level.ts` (port `REASONING_LEVELS`, `clampReasoningLevel`, `splitReasoningSuffix` semantics)
- astrocode `src/models/tuning.ts`

**Steps**:
1. Add `export const REASONING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"] as const;` and `export type ReasoningLevel = (typeof REASONING_LEVELS)[number];`
2. Add `export function isReasoningLevel(value: string): value is ReasoningLevel`.
3. Add `export function clampReasoningLevel(value: string, allowed: readonly string[]): ReasoningLevel | undefined` — walk the ladder downward from the requested index to the first allowed level; return `undefined` if the requested value is not a level.
4. Add `export function splitReasoningSuffix(model: string, options?: { allowMaxSuffix?: boolean }): { base: string; level?: string }` — port OMO semantics: split on last `:`; token must be a level or `"auto"`; `":max"` stays attached unless `allowMaxSuffix` or base contains `/`.
5. Extend `reasoningConfigForFamily(family, level?: ReasoningLevel)`:
   - claude: keep `{ thinking: { type: "enabled", budgetTokens: 32000 } }` (unchanged when no level).
   - gpt: map level → `reasoningEffort` (off/minimal→"minimal", low→"low", medium→"medium", high/xhigh/max→"high"); default "medium" when no level.
   - else `{}`.
   - Backward compatible: existing one-arg calls unchanged.
6. Wire in `src/index.ts` config hook: when resolving an agent's effective model, call `splitReasoningSuffix(agentModel)`; use `.base` for `resolveFamily` and pass `.level` (if a valid level) to `reasoningConfigForFamily`. Keep behavior identical when no suffix present.

**Acceptance Criteria**:
- `clampReasoningLevel("max", ["low","medium"]) === "medium"`; `clampReasoningLevel("low", ["high"]) === undefined`.
- `splitReasoningSuffix("anthropic/claude-opus-4-7:high")` → `{ base: "anthropic/claude-opus-4-7", level: "high" }`.
- `splitReasoningSuffix("claude-opus-4-7:max")` → base unchanged (no `/`), `splitReasoningSuffix("anthropic/claude-opus-4-7:max")` → level `"max"`.
- `reasoningConfigForFamily("gpt", "high")` → `{ reasoningEffort: "high" }`; `reasoningConfigForFamily("gpt")` → `{ reasoningEffort: "medium" }`.

**QA Scenarios**:
- Happy: `bun test test/tuning.test.ts` → pass. Evidence: `.sisyphus/evidence/task-3-reasoning-ladder.txt`
- Failure: assert `splitReasoningSuffix("model:notalevel")` returns base unchanged, no level. Evidence appended.

**Commit**: `feat(models): add reasoning-level ladder and suffix parsing`

---

### T4 — Model canonicalization for fallback equivalence

**Deliverable**: New pure module `src/fallback/canonicalize.ts`; `pickFallbackModel` skips models equivalent to the just-failed model.

**Files**:
- CREATE `src/fallback/canonicalize.ts`
- CREATE `test/canonicalize.test.ts`
- MODIFY `src/fallback/index.ts` (`pickFallbackModel`)
- MODIFY `test/fallback.test.ts`

**References**:
- OMO `/tmp/oh-my-openagent/packages/model-core/src/runtime-fallback-model.ts` (`canonicalizeRuntimeFallbackModelID`, `areRuntimeFallbackModelsEquivalent`)
- astrocode `src/fallback/index.ts` (`pickFallbackModel`, `parseModelString`)

**Steps**:
1. `export function canonicalizeModelID(modelID: string): string` — lowercase, `replaceAll(".", "-")`; if it starts with `claude-opus-`/`claude-sonnet-`/`claude-haiku-`, strip trailing `-thinking`, `-max`, `-high` (in that order, each once).
2. `export function areModelsEquivalent(a: string | undefined, b: string | undefined): boolean` — parse both with `parseModelString`; if either fails, compare lowercased trimmed strings; else compare `providerID.toLowerCase()` equal AND `canonicalizeModelID(modelID)` equal.
3. In `src/fallback/index.ts`, change `pickFallbackModel(candidates, currentModel?)` to filter with `!areModelsEquivalent(candidate, currentModel)` instead of `!used.includes(candidate)`. Keep the `used` array for the `lastUsed` case: filter candidates equivalent to EITHER `currentModel` OR `lastUsed`. Simplest: `const remaining = candidates.filter(c => !areModelsEquivalent(c, currentModel) && !areModelsEquivalent(c, lastUsed));` — but signature currently only takes `currentModel`. Extend to `pickFallbackModel(candidates, currentModel?, lastUsed?)` (optional, backward compatible).
4. Update `decideFallback` call site to pass both `currentModel` and `lastUsed`.

**Acceptance Criteria**:
- `areModelsEquivalent("anthropic/claude-opus-4-7-thinking", "anthropic/claude-opus-4-7") === true`.
- `areModelsEquivalent("anthropic/claude-opus-4-7", "openrouter/claude-opus-4-7") === false` (different provider).
- `areModelsEquivalent("openai/gpt-4o", "openai/gpt-4o") === true`.
- `pickFallbackModel(["anthropic/claude-opus-4-7-thinking","openai/gpt-4o"], "anthropic/claude-opus-4-7")` → `"openai/gpt-4o"`.

**QA Scenarios**:
- Happy: `bun test test/canonicalize.test.ts test/fallback.test.ts` → pass. Evidence: `.sisyphus/evidence/task-4-canonicalize.txt`
- Failure: assert a chain of only suffix-variants of the failed model returns `undefined` (chain-exhausted). Evidence appended.

**Commit**: `feat(fallback): canonicalize model ids for equivalence`

---

### T5 — terminal_quota vs non_terminal error classification

**Deliverable**: `classifyError()` in `src/fallback/classify.ts`; `decideFallback` uses it so `terminal_quota` switches model immediately while `non_terminal` allows one same-model attempt.

**Files**:
- MODIFY `src/fallback/classify.ts`
- MODIFY `src/fallback/index.ts` (`decideFallback`, `dispatchFallback`)
- MODIFY `test/fallback.test.ts`

**References**:
- OMO `/tmp/oh-my-openagent/packages/model-core/src/runtime-fallback-error-classifier.ts` (terminal_quota vs non-terminal vs context_overflow)
- astrocode `src/fallback/classify.ts` (existing `RETRYABLE_ERROR_PATTERNS`, `CONTEXT_OVERFLOW_PATTERN`)

**Steps**:
1. Add `export type ErrorClass = "terminal_quota" | "non_terminal" | "context_overflow" | "not_retryable";`
2. Add `export const TERMINAL_QUOTA_PATTERNS: RegExp[]` — quota/usage-limit/out-of-credits/credit-balance/insufficient-credit/billing/payment-required/session-limit/hit-your/you've-hit/resets-N/insufficient-quota/exceeded-your-current-quota + Chinese quota patterns.
3. Add `export function classifyError(error: unknown, retryOnErrors: number[]): ErrorClass`:
   - context-overflow pattern → `"context_overflow"`.
   - terminal-quota pattern → `"terminal_quota"`.
   - `isRetryableError(error, retryOnErrors)` true → `"non_terminal"`.
   - else `"not_retryable"`.
4. Refactor `isRetryableError` to remain behavior-identical (do NOT change its result); `classifyError` is additive.
5. In `decideFallback`: compute `const errorClass = classifyError(error, config.retry_on_errors);`. If `errorClass === "non_terminal"` AND `getAttemptCount(sessionID) === 0`, return `{ retry: false, reason: "same-model-retry" }` (let opencode's own same-model retry handle it). For `terminal_quota`, proceed to model rotation as today. Add `errorClass` to `FallbackDecision` (optional field).
6. `dispatchFallback` cheap-rejection path: keep `isRetryableError` gate; no behavior change beyond passing through.

**Acceptance Criteria**:
- `classifyError({ message: "You've hit your session limit · resets 4am" }, [429]) === "terminal_quota"`.
- `classifyError({ message: "429 Too Many Requests" }, [429]) === "non_terminal"`.
- `classifyError({ message: "maximum context length exceeded" }, []) === "context_overflow"`.
- `classifyError({ message: "syntax error" }, []) === "not_retryable"`.
- `decideFallback` with a non_terminal error and 0 prior attempts returns `reason: "same-model-retry"`; with 1 prior attempt it rotates.

**QA Scenarios**:
- Happy: `bun test test/fallback.test.ts` → pass. Evidence: `.sisyphus/evidence/task-5-error-class.txt`
- Failure: assert `isRetryableError` results are unchanged for the existing test corpus (regression guard). Evidence appended.

**Commit**: `feat(fallback): classify terminal-quota vs non-terminal errors`

---

### T6 — AGENTS.md walk-up context injector

**Deliverable**: New fs-only module `src/context/agentsmd.ts`; injected once per system array via the transform hook.

**Files**:
- CREATE `src/context/agentsmd.ts`
- CREATE `test/agentsmd.test.ts`
- MODIFY `src/index.ts` (transform hook)

**References**:
- OMO `packages/agents-md-core` (walk-up discovery + `[Directory Context: ...]` block)
- astrocode `src/env/context.ts` (idempotency marker pattern)

**Steps**:
1. `export const AGENTS_MD_MARKER = "[Directory Context:";`
2. `export function findAgentsMdFiles(startDir: string, stopDir?: string, maxFiles = 5): string[]` — walk up via `dirname` from `startDir`; at each level check `join(dir, "AGENTS.md")`; stop at `stopDir` (default `homedir()`) or filesystem root; return nearest-first, capped at `maxFiles`; never throws (try/catch per level).
3. `export function buildAgentsMdContext(files: string[]): string` — for each file, read (try/catch), format `[Directory Context: <abs path>]\n<content>`; join with `\n\n`; truncate total to 8000 chars with a trailing `…`.
4. `export function hasAgentsMdContext(system: string[]): boolean` — `system.some(e => e.includes(AGENTS_MD_MARKER))`.
5. In `src/index.ts`, capture `const projectDir = input?.directory` at plugin init. In the transform hook, after env context: `if (projectDir && !hasAgentsMdContext(output.system)) { const files = findAgentsMdFiles(projectDir); if (files.length) output.system.push(buildAgentsMdContext(files)); }`.
6. Wrap in the existing try/catch (already present).

**Acceptance Criteria**:
- `findAgentsMdFiles` finds a temp-dir AGENTS.md and its parent's, nearest-first.
- `buildAgentsMdContext` includes the marker and file content.
- `hasAgentsMdContext` detects the marker.
- Transform hook adds the block at most once (idempotent).

**QA Scenarios**:
- Happy: `bun test test/agentsmd.test.ts` → pass. Evidence: `.sisyphus/evidence/task-6-agentsmd.txt`
- Failure: nonexistent start dir → `findAgentsMdFiles` returns `[]`, no throw. Evidence appended.
- Integration: `ASTROCODE_DUMP=/tmp/astrocode-agentsmd-dump.json bun test test/index.test.ts` then grep dump for `[Directory Context:` (if index.test exercises the transform hook). Evidence: `.sisyphus/evidence/task-6-agentsmd-dump.txt`

**Commit**: `feat(context): inject nearby AGENTS.md directory context`

---

### T7 — Exponential backoff + consecutive-failure cap

**Deliverable**: Ported constants + backoff in `src/idle/continue.ts`; effective cooldown in `src/fallback/state.ts`.

**Files**:
- CREATE `src/idle/constants.ts`
- MODIFY `src/idle/continue.ts`
- MODIFY `src/fallback/state.ts`
- MODIFY `test/extras.test.ts` (idle) and `test/fallback.test.ts` (state)

**References**:
- OMO `packages/omo-opencode/src/hooks/todo-continuation-enforcer/constants.ts`
- OMO `packages/omo-opencode/src/hooks/todo-continuation-enforcer/idle-event.ts` (effectiveCooldown formula, failure reset window)

**Steps**:
1. `src/idle/constants.ts`: export `ABORT_WINDOW_MS = 3000`, `CONTINUATION_COOLDOWN_MS = 5000`, `MAX_CONSECUTIVE_FAILURES = 5`, `FAILURE_RESET_WINDOW_MS = 5 * 60 * 1000`, `MAX_BACKOFF_EXPONENT = 5`.
2. `src/idle/continue.ts`: add per-session state `{ lastInjectedAt?: number; consecutiveFailures: number; lastIncompleteCount?: number }` in a `Map`. In `maybeContinueIdle`:
   - After fetching incomplete todos, if `lastIncompleteCount !== undefined && incomplete.length >= lastIncompleteCount` → `consecutiveFailures++`; else reset to 0.
   - If `consecutiveFailures >= MAX_CONSECUTIVE_FAILURES` and `now - lastInjectedAt >= FAILURE_RESET_WINDOW_MS` → reset failures to 0.
   - If `consecutiveFailures >= MAX_CONSECUTIVE_FAILURES` → return `{ continued: false, reason: "max-failures" }`.
   - `effectiveCooldown = CONTINUATION_COOLDOWN_MS * 2 ** Math.min(consecutiveFailures, MAX_BACKOFF_EXPONENT)`; if `lastInjectedAt && now - lastInjectedAt < effectiveCooldown` → return `{ continued: false, reason: "cooldown" }`.
   - On successful send: set `lastInjectedAt = now`, `lastIncompleteCount = incomplete.length`.
   - Keep the existing flat `max` gate (still applies).
   - `resetIdleContinuationState()` clears the new map too.
3. `src/fallback/state.ts`: add `consecutiveFailures` to `SessionAttemptState`; add `export function effectiveCooldownSeconds(baseCooldownSeconds: number, failures: number): number` = `baseCooldownSeconds * 2 ** Math.min(failures, 5)`. `shouldThrottle` uses `effectiveCooldownSeconds(cooldownSeconds, state.consecutiveFailures)`. `recordAttempt` increments `consecutiveFailures`; add `resetFailures(sessionID)` and call it on a successful fallback (in `dispatchFallback` when `result.error` is falsy). Keep `attempts` semantics unchanged.

**Acceptance Criteria**:
- `effectiveCooldownSeconds(60, 0) === 60`, `(60, 1) === 120`, `(60, 5) === 1920`, `(60, 9) === 1920` (capped).
- Idle: two consecutive idles with non-decreasing incomplete count → second is throttled by cooldown; after `MAX_CONSECUTIVE_FAILURES` → `max-failures`.
- Fallback: `shouldThrottle` respects the exponential cooldown.

**QA Scenarios**:
- Happy: `bun test test/extras.test.ts test/fallback.test.ts` → pass. Evidence: `.sisyphus/evidence/task-7-backoff.txt`
- Failure: assert cooldown exponent is capped at 5 (no overflow). Evidence appended.

**Commit**: `feat(idle,fallback): add exponential backoff and failure caps`

---

### T8 — Abort-window gate in idle continuation

**Deliverable**: `recordAbort(sessionID)` + abort-window check; wired to the `session.error` abort signal.

**Files**:
- MODIFY `src/idle/continue.ts`
- MODIFY `src/index.ts` (event hook)
- MODIFY `test/extras.test.ts`

**References**:
- OMO `packages/omo-opencode/src/hooks/todo-continuation-enforcer/abort-detection.ts` + `handler.ts` (abort via `session.error`, error name `MessageAbortedError`/`AbortError`)
- astrocode `src/fallback/classify.ts` (`getErrorName` already exported)
- SDK types: `EventSessionError.properties.error` union includes `MessageAbortedError`; `EventSessionIdle.properties.sessionID`.

**Steps**:
1. In `src/idle/continue.ts`, add `const aborts = new Map<string, number>();` and `export function recordAbort(sessionID: string, now: number = Date.now()): void { aborts.set(sessionID, now); }`.
2. In `maybeContinueIdle`, before the todo fetch: `const abortAt = aborts.get(sessionID); if (abortAt !== undefined) { if (now - abortAt < ABORT_WINDOW_MS) return { continued: false, reason: "abort-window" }; aborts.delete(sessionID); }`.
3. `resetIdleContinuationState()` clears `aborts`.
4. In `src/index.ts` event hook, at the TOP of the `session.error` branch (before fallback dispatch): read `const errName = getErrorName(event.properties?.error);` and `const sid = event.properties?.sessionID;` then `if (sid && (errName === "MessageAbortedError" || errName === "AbortError")) recordAbort(sid);`. Import `getErrorName` from `./fallback/classify` and `recordAbort` from `./idle/continue`.
5. Note: this must run even when `idleContinuation.enabled` is false (cheap, harmless) — place it before the `if (!fallbackConfig.enabled) return;` guard, inside the try/catch.

**Acceptance Criteria**:
- `recordAbort(sid)` then immediate `maybeContinueIdle` → `{ continued: false, reason: "abort-window" }`.
- After `ABORT_WINDOW_MS` elapses (inject `now`), the gate clears and continuation proceeds.
- Non-abort `session.error` does not record an abort.

**QA Scenarios**:
- Happy: `bun test test/extras.test.ts` → pass. Evidence: `.sisyphus/evidence/task-8-abort-window.txt`
- Failure: assert a stale abort entry is deleted after the window (no permanent block). Evidence appended.

**Commit**: `feat(idle): skip continuation within abort window`

---

### T9 — Explicit numeric skill-source priority

**Deliverable**: `standardSkillSources()` with numeric priorities; `discoverSkills` resolves name collisions by highest priority and logs the winner.

**Files**:
- MODIFY `src/skills/extra.ts`
- MODIFY `test/extras.test.ts`

**References**:
- OMO `packages/skills-loader-core/src/features/opencode-skill-loader/AGENTS.md` (6-tier numeric priority: opencode-project 6 > project 5 > opencode 4 > user 3 > config 2 > builtin/shared 1)
- astrocode `src/skills/extra.ts` (`discoverSkills`, `standardSkillDirs`)

**Steps**:
1. Add `export interface SkillSource { dir: string; priority: number; label: string; }`.
2. Add `export function standardSkillSources(projectDirs: string[], bundledDir?: string): SkillSource[]`:
   - per project: `.opencode/skills`=60, `.claude/skills`=50, `.agents/skills`=40
   - home: `.config/opencode/skills`=30, `.claude/skills`=20, `.agents/skills`=10
   - bundled (if provided): priority 5, label `"builtin"`
3. Add `export function discoverSkillsWithPriority(sources: SkillSource[]): DiscoveredSkill[]`:
   - collect all candidates `{ name, description, location, priority, label }`
   - group by name; pick highest priority (ties → first encountered); on collision `console.error("[astrocode] skill collision: <name> — kept <winnerLabel>(<p>), dropped <loserLabel>(<p>)")`
   - return sorted by name.
4. Keep `discoverSkills(dirs: string[])` as a compatibility wrapper: map dirs to sources with descending priority by index and delegate.
5. Extend `DiscoveredSkill` with optional `source?: string` and `priority?: number` (optional → existing tests unaffected).
6. Keep `standardSkillDirs` (maps sources → dirs) for backward compatibility.

**Acceptance Criteria**:
- Two dirs with the same skill name → higher-priority dir's `location` wins.
- Collision logs once to stderr.
- `discoverSkills([low, high])` (legacy) still returns the first-dir-wins result (index order = priority order).

**QA Scenarios**:
- Happy: `bun test test/extras.test.ts` → pass. Evidence: `.sisyphus/evidence/task-9-skill-priority.txt`
- Failure: same-name skills in two dirs → assert winner is the higher priority and loser absent. Evidence appended.

**Commit**: `feat(skills): explicit numeric source priority for discovery`

---

### T10 — Bundled builtin-skills catalog

**Deliverable**: 3 bundled skills shipped in-repo, always discoverable at the lowest priority tier.

**Files**:
- CREATE `skills/builtin/commit-message/SKILL.md`
- CREATE `skills/builtin/code-review/SKILL.md`
- CREATE `skills/builtin/verify-before-done/SKILL.md`
- MODIFY `src/index.ts` (pass bundled dir to `standardSkillSources`)
- MODIFY `test/extras.test.ts`

**References**:
- OMO `packages/skills-loader-core/src/features/builtin-skills/*` (bundled catalog concept)
- astrocode `src/skills/extra.ts` (`standardSkillSources` from T9)
- astrocode `PLUGIN_ROOT` resolution in `src/index.ts` (`dirname(dirname(fileURLToPath(import.meta.url)))`)

**Steps**:
1. Create the 3 `SKILL.md` files with YAML frontmatter (`name`, `description`) and concise instructions:
   - `commit-message`: generate a Conventional Commits message from staged diff; subject ≤50 chars; body only when "why" isn't obvious.
   - `code-review`: review a diff for correctness, edge cases, and regressions; one line per finding (location, problem, fix).
   - `verify-before-done`: evidence gate checklist — run tests/typecheck, report faithfully, never claim done without observed output.
2. In `src/index.ts`, compute `const BUNDLED_SKILLS_DIR = join(PLUGIN_ROOT, "skills", "builtin");` and use `standardSkillSources(searchDirs, BUNDLED_SKILLS_DIR)` for the slash-command bridge (replacing the `standardSkillDirs` + extraDirs push loop).
3. Ensure bundled skills are lowest priority (5) so user/project skills override them.
4. Keep `astrocodeConfig.skills.extraDirs` included as sources (priority 35, between project and home) — or append them to the source list with an explicit priority; document the chosen value.

**Acceptance Criteria**:
- `discoverSkillsWithPriority(standardSkillSources([], bundledDir))` returns the 3 bundled skills.
- A project skill with the same name overrides the bundled one.
- The 3 skills appear as slash commands via the config hook (existing bridge).

**QA Scenarios**:
- Happy: `bun test test/extras.test.ts` → pass. Evidence: `.sisyphus/evidence/task-10-builtin-skills.txt`
- Failure: assert bundled skill is dropped when a higher-priority same-name skill exists. Evidence appended.

**Commit**: `feat(skills): ship bundled builtin skills catalog`

---

### T11 — Walk-up multi-layer config merge

**Deliverable**: `loadAstrocodeConfig` collects config files walking up from the project dir to home, merging farthest-first (nearest wins).

**Files**:
- MODIFY `src/config/astrocode.ts`
- MODIFY `test/config.test.ts`

**References**:
- OMO `packages/omo-config-core/src/loader/loader.ts` + `merge.ts` (walk-up, farthest-first merge)
- astrocode `src/config/astrocode.ts` (`CONFIG_FILE_NAMES`, `sanitizeJsonc`, existing per-agent merge)

**Steps**:
1. Add `export function collectConfigLayers(projectDir: string, stopDir: string = homedir()): string[]`:
   - walk from `projectDir` up via `dirname` until `stopDir` (inclusive) or filesystem root
   - at each level, find the first existing file among `CONFIG_FILE_NAMES`
   - return paths ordered **farthest-first** (root-most first, project last)
   - dedup; never throws.
2. Add `function mergeConfigLayers(layers: Record<string, unknown>[]): Record<string, unknown>`:
   - shallow-merge top-level keys, later (nearer) wins
   - `agents`: per-agent shallow merge (`{...far, ...near}` per agent name)
   - `fallback`: shallow merge
   - `sampling`: shallow merge
   - arrays (`skills.extraDirs`, `fallback.models`, `fallback.agents[x].models`): full replace by nearest layer that defines them (no concat)
3. Modify `loadAstrocodeConfig(searchDirs, inlineOptions?)`:
   - for each `searchDir`, `collectConfigLayers(searchDir)`; concatenate and dedup preserving farthest-first order
   - parse each layer (best-effort; malformed layer skipped)
   - `fileRaw = mergeConfigLayers(parsedLayers)`
   - rest of the function unchanged (inline options still override per-field).
4. Explicitly do NOT add profiles/harness/Zod/prototype guard.

**Acceptance Criteria**:
- A home-level `astrocode.json` with `fallback.max_attempts: 5` and a project-level one with `max_attempts: 2` → result `2`.
- Project-level `agents.sisyphus.model` overrides home-level; home-level `agents.sisyphus.color` survives when project doesn't set it.
- `skills.extraDirs` from the nearest layer fully replaces the farther layer's list.
- Malformed layer is skipped without throwing.

**QA Scenarios**:
- Happy: `bun test test/config.test.ts` → pass. Evidence: `.sisyphus/evidence/task-11-config-layers.txt`
- Failure: malformed nearest layer → farther layer still applies (graceful degrade). Evidence appended.

**Commit**: `feat(config): walk-up multi-layer config merge`

---

### T12 — Integration verification + docs

**Deliverable**: Full-suite green, dump evidence, README/docs updated.

**Files**:
- MODIFY `README.md` (document the 11 features + new config/skill behavior)
- MODIFY `docs/oh-my-parity.md` (move the 11 items from "missing" to "ported")
- CREATE `.sisyphus/evidence/task-12-*.txt`

**Steps**:
1. Run `bunx tsc --noEmit` → capture exit 0.
2. Run `bun test` → capture all pass.
3. Run the transform-hook dump: `ASTROCODE_DUMP=/tmp/astrocode-final-dump.json bun test test/index.test.ts`; grep the dump for `[Directory Context:` and `<omo-env>`.
4. Update README "What astrocode has" + "Why not just use oh-my-openagent" sections to reflect the new parity items.
5. Update `docs/oh-my-parity.md` table.
6. Record evidence files.

**Acceptance Criteria**:
- `bunx tsc --noEmit` exit 0.
- `bun test` all pass.
- Dump contains both markers.
- README + parity doc mention all 11 features.

**QA Scenarios**:
- Happy: `bunx tsc --noEmit && bun test` → exit 0, all pass. Evidence: `.sisyphus/evidence/task-12-full-suite.txt`
- Failure: intentionally break one test locally, confirm suite fails, revert. Evidence: `.sisyphus/evidence/task-12-negative.txt`

**Commit**: `docs: document safe oh-my parity features`

---

## Dependency Matrix

| Todo | Depends on | Blocks | Wave |
|---|---|---|---|
| T1 resolveVersion | — | T2 | 1 |
| T2 version builders | T1 | T12 | 2 |
| T3 reasoning ladder | — | T12 | 1 |
| T4 canonicalize | — | T12 | 1 |
| T5 error class | — | T12 | 1 |
| T6 agentsmd | — | T12 | 2 |
| T7 backoff | — | T12 | 2 |
| T8 abort-window | T7 (shares idle state) | T12 | 2 |
| T9 skill priority | — | T10 | 2 |
| T10 builtin skills | T9 | T12 | 2 |
| T11 config layers | — | T12 | 3 |
| T12 integration | T1-T11 | — | 4 |

**Parallelizable groups**: {T1, T3, T4, T5} (Wave 1); {T2, T6, T7, T9, T11} (Wave 2, T2 after T1); {T8, T10} after their deps.

---

## Success Criteria

- All 11 features implemented as pure/fs-only/in-memory mechanisms.
- `bun test` all pass; `bunx tsc --noEmit` 0 errors.
- No new npm dependency; no IPC/child-process/file-lock introduced.
- Every new module has tests; every hook wrapped in try/catch no-op.
- README + `docs/oh-my-parity.md` updated.
- Non-goals list untouched (no team-mode/DAG/mailbox/boulder/memory/ralph-loop/tmux/profiles/Zod).

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Version regexes over-match (e.g. `grok-4.20`) | Digit-boundary negative lookahead; explicit test cases |
| Version builders bloat the repo | Thin composition wrappers (<40 lines), not full copies |
| Backoff changes break existing idle tests | Keep flat `max` gate; add new gates additively; update tests |
| `non_terminal` same-model-retry changes fallback behavior | Gate on `attempts === 0` only; regression test `isRetryableError` unchanged |
| Walk-up config merge surprises users | Nearest-wins; arrays full-replace; malformed layers skipped; documented |
| AGENTS.md injection bloats prompts | Cap at 5 files / 8000 chars; idempotent marker |
| Skill priority changes existing discovery | `discoverSkills(dirs)` compatibility wrapper preserves index-order behavior |
| Abort signal not delivered | Event-based primary; document API fallback (`isLastAssistantMessageAborted`) as optional future work |

---

## Open Questions / Blockers

None blocking. Two decisions taken as defaults (override if disagree):
1. Version builders are **thin calibration deltas** composed on top of family builders, not full 13-file copies (keeps astrocode minimal).
2. `non_terminal` same-model-retry is gated to `attempts === 0` only (one same-model attempt, then rotate).