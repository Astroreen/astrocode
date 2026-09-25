# astrocode — Fallback robustness, subagent model isolation, family precision (4 issues + audit)

## TL;DR

> **Quick Summary**: Make astrocode's fallback fire on EVERY plausible error surface (incl. opencode zen free-tier limits and Claude-subscription "resets at" limits), survive a second consecutive failure without being self-throttled, stop subagents from inheriting the parent model (agent model → agent fallbacks → global model → global fallbacks), and replace the naive substring family detection with precise per-vendor classification incl. new `grok` and `minimax` families. Plus the audit corrections found along the way.
>
> **Deliverables**:
> - `src/fallback/classify.ts` — reads `responseBody` + `responseHeaders`, terminal/transient discriminators per provider, wait-window extraction (`retry-after` → "resets HH:MM")
> - `src/fallback/state.ts` — same-model retry becomes a COUNTER (multi-retry), rotation is never cooldown-throttled
> - `src/fallback/index.ts` — wait-window aware rotation, provider-aware pick on terminal quota, `resetFailures` finally wired
> - `src/models/model-id.ts` — single model-string parser (kills 3 duplicates)
> - `src/models/resolveFamily.ts` — anchored token grammar, 9 families (`+grok`, `+minimax`)
> - `src/prompts/sisyphus/families/{grok,minimax}.ts` — new family builders + dispatch wiring
> - `src/prompts/guards.ts` — `apply_patch` guidance gated to the exact opencode tool-visibility rule
> - `src/index.ts` + `src/config/astrocode.ts` — subagent model cascade, `message.part.updated` surface, `subagents.inherit_parent_model` flag
> - `src/idle/continue.ts` — keeps `agent`, uses `promptAsync`, shared parser
> - README rewritten to the new contract; audit fixes (skills TOCTOU, log swallow, dead exports, Map leaks)
> - All tests green (`bun test`), `tsc --noEmit` 0 errors
>
> **Estimated Effort**: Medium-Large (~2-3 focused days)
> **Parallel Execution**: YES — Wave 1 (pure) → Wave 2 (state/config) → Wave 3 (integration) → Wave 4 (cleanup/docs/gate)
> **Critical Path**: T2 → T9 → T10 → T13. T1/T3/T4/T5/T6 independent of T2. T7 blocks T8/T9. T11 blocks T14.

---

## Context

### Original Request (user verbatim, authoritative)

> While using this plugin (my more stable version of oh-my-openagent) i noticed two issues:
> 1. When I used free Opencode model and it hit their limit, it did not used fallback models. It just stopped with error.
> 2. All of the subagents that the agent with free model spun up, they also used the same free model, inheriting it from the parent, thus stopped when usage of free model ended.
>
> The fallback issue was a stable problem for me. Think about all other problems that agent might meet during a run and try to make fallback work after all possible errors.
>
> Futhermore, subagents should not inherit parent model, they should use agent-specific model and its fallbacks, if not specified, they should use global model and then global fallbacks.
>
> I also would like you to fix the @src/models/resolveFamily.ts since if any other models has, for example, "gpt" in it, despite not being openai model, it would still get the new prompts and corrections. It needs to be more precise for every model and correctly identify the families.
>
> To add to this, analyze whole project structure and see if any part of code or logic needs correction (just like with resolveFamilies.ts file), since there might be some bad decions have been made.

### Second-hop failure (user verbatim, added mid-planning)

> Right now, you were running as Claude Opus 5.5, you've hit your limit and then astrocode switched model to next in fallback chain - Claude sonnet 5, but since i've used up all my limit on my claude account, it also hit limit, but did not moved to the next in line model. How so? If this is also one of the situations you are planning to fix - continue. If not, investigate and add to the plan.

**Root cause (verified in code)**: `src/fallback/index.ts:247` calls `shouldThrottle` BEFORE classification and without `errorClass`. `state.ts:shouldThrottle` = attempt-count + cooldown only. After hop#1 `recordAttempt` sets `consecutiveFailures=1` → cooldown `60*2=120s`. The dead-account fallback fails instantly (T+ε) → hop#2 at T+ε sees `elapsed < 120s` → `"throttled"` → NO rotation. Compounding: `resetFailures` has zero callers (cooldown grows 120→240→…→1920s cap forever), `sameModelRetried` is a boolean (only one same-model retry ever), rotation is positional (burns remaining same-provider models first).

### Owner Decisions (Q&A, verbatim answers)

> Q1 - use (a), but also, if retry will be used after not minutes but hours, it should rather skip to another model in the fallback chain. Then, the retry can be performed more than one time.
> Q2 - use (a)
> Q3 - use (b)
> Q4 - use (a)

| Q | Meaning | Decision |
|---|---|---|
| Q1 | fallback aggressiveness | (a) terminal-ness via `responseBody`/headers → switch immediately; transient errors get same-model retry first. **+ amendment**: if the wait is hours-scale (> threshold) skip same-model retry and rotate NOW; same-model retry allowed MORE THAN ONCE while waits are minutes-scale |
| Q2 | family taxonomy | (a) `grok` and `minimax` become full families with their own prompt builders |
| Q3 | subagent inheritance | (b) behind a flag, **default `false`** (new no-inheritance behavior is the default; `true` restores old contract) |
| Q4 | global model | (a) `astrocode.model ?? opencode.model` (astrocode overrides) |

**Naming deviation (locked)**: the flag ships as `subagents.inherit_parent_model` in `astrocode.jsonc`, NOT `agents.inherit_parent_model`, because `agents` is already a `Record<string, AgentSettings>` map (see `src/config/astrocode.ts:39-52`) and a sibling boolean key would collide with agent names. Semantics identical to the approved option (b).

---

## Ground Truth (verified firsthand — do not re-derive)

Evidence root: `sst/opencode` clone at `/tmp/opencode-repo`, HEAD `16c56fe5ecc3305028d1f0a9cff5806e51c9d480`; SDK/plugin types at `<project>/node_modules/@opencode-ai/{sdk,plugin}/dist/**`; provider error formats researched 2026-09-25 (zen/OpenRouter/Anthropic/OpenAI/Gemini/Z.ai/Moonshot/AI-SDK).

1. **Child model resolution** — `packages/opencode/src/tool/task.ts:181-184`: `const model = next.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }` then `ops.prompt({ model: {...}, variant: next.model ? undefined : variant, agent: next.name, parts })` (L200-212). TWO tiers only: agent-config `model` → else parent assistant message's model. **Setting `agentConfig.model` kills parent inheritance completely.** Side effect: `variant` inheritance from parent is dropped when `next.model` is set (desired).
2. **Primary model resolution** — `packages/opencode/src/session/prompt.ts:646` (and 469): `const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))`. **The TUI always sends `model` explicitly** (`packages/tui/src/component/prompt/index.tsx:1095-1104`: `model: selectedModel` in the `session.prompt` body). Therefore `ag.model` NEVER outranks the TUI picker — pinning `agentConfig.model` is SAFE for primary/all-mode agents.
3. **apply_patch visibility** — `packages/opencode/src/tool/registry.ts:295-301`: `usePatch = modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")`; `apply_patch` shown iff `usePatch`, `edit`/`write` shown iff `!usePatch`.
4. **zen free-tier limit** — HTTP 429 body `{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."},"metadata":{}}` (Go variant: `GoUsageLimitError` + `metadata.limitName ∈ "5 hour"|"weekly"|"monthly"`). `retry-after` = seconds until UTC midnight. opencode has NO model-switching fallback (`retry.ts` retries the SAME model up to 5x honoring `retry-after`).
5. **Anthropic rule**: tier spend-cap 429 has NO `retry-after` and keeps failing → terminal. Ordinary 429 has `retry-after` → transient. 529 `overloaded_error` → transient. 402 `billing_error` → terminal.
6. **OpenRouter**: 402 `metadata.reason:"in_flight_budget_exhausted"` → transient (has `Retry-After`); 402 `metadata.reason:"weight_exceeds_budget"` → terminal; 429 `error_type:"rate_limit_exceeded"` → transient. Free models: 20 RPM, 50/1000 RPD.
7. **OpenAI**: 429 `credit_balance_exhausted` / `organization_usage_limit_exceeded` / `*_spend_limit_exceeded` → terminal ("Retrying billing, spend, or quota errors won't restore API access"); `rate_limit_error`/`slow_down` → transient; overload may arrive as **503** `server_is_overloaded` → transient.
8. **Gemini**: 429 `RESOURCE_EXHAUSTED` (spend-based rate limit → transient; daily `quota_exceeded` → terminal until midnight Pacific); 503 `UNAVAILABLE` → transient; 402 `payment_required` → terminal.
9. **Z.ai/GLM** (business `code` is a STRING, HTTP 429 for all): `1113` insufficient balance → terminal; `1302` rate limit → transient; `1305` overloaded → transient; `1308`/`1310` usage/weekly-monthly limit with `next_flush_time` → terminal until reset; `1309` package expired → terminal; `1316`-`1321` (5h/7d windows × insufficient balance × monthly spend) → terminal until reset.
10. **Moonshot/Kimi**: `engine_overloaded_error` → transient; `exceeded_current_quota_error` → terminal; `rate_limit_reached_error` (RPM/TPM/TPD) → transient (TPD resets next day).
11. **AI SDK**: `APICallError.responseBody` = raw string; `isRetryable` default from statusCode only (402→false).
12. **Cross-provider rule**: `retry-after`/`Retry-After` present ⇒ wait-and-retry-same-model is meaningful; 429/402 WITHOUT it ⇒ terminal until an external event.
13. **Error/event surface** (`types.gen.d.ts`): `ApiError.data = {message, statusCode?, isRetryable, responseHeaders?, responseBody?}`; `EventMessagePartUpdated` carries `RetryPart {type:"retry", attempt, error: ApiError}` (currently UNOBSERVED by astrocode); `SessionStatus {type:"retry", attempt, message, next}` where `next` is **epoch ms of the next retry** (`retry.ts:201`: `next: now + wait`).
14. **Persona modes** (`agents/*.md` frontmatter): `all` = sisyphus, atlas, prometheus; `subagent` = explore, hephaestus, librarian, metis, momus, multimodal-looker, oracle, sisyphus-junior.

---

## Scope / Must-NOT-Have

**Must-NOT-Have (hard):**
- No edits to persona prompt texts in `agents/*.md` (frontmatter stays as-is).
- No network I/O in `src/models/**` — `resolveFamily`/`resolveVersion`/`model-id` stay pure, total, deterministic.
- No change to the existing family prompt texts in `src/prompts/sisyphus/families/{claude,gpt,glm,gemini,kimi,fallback}.ts` EXCEPT adding the two new files and the `guards.ts` gating fix. These prompts are calibrated content, not bug surface.
- No `fallback.agents` config key (stays intentionally ignored — see `src/fallback/config.ts:17-19`).
- No parallelism/queue/durable-state (astrocode's simplicity doctrine stands).
- Do not touch `skills/builtin/**`.
- Do not override a client-supplied `model` in `chat.message` (TUI pick is sacred).
- No `model:` key in persona frontmatter parsing (config-only source of agent models).

**Out of scope (explicitly deferred):** multi-process state persistence, provider health tracking / cooldown-per-provider registry, dynamic chain pruning from `GET /api/v1/key`-style endpoints, oh-my-openagent team-mode/AGENTS categories.

---

## Work Items

### Wave 1 — pure foundations (parallelizable)

---

#### T1. `src/models/model-id.ts` — single model-string parser

**Problem**: model-string parsing exists 3 times — `parseModelString` (`src/fallback/index.ts:72-86`), `splitModel` (`src/fallback/canonicalize.ts:12-22`), inline copy (`src/idle/continue.ts:166-174`).

**Files**:
- CREATE `src/models/model-id.ts`
- EDIT `src/fallback/index.ts` (drop local impl, re-export)
- EDIT `src/fallback/canonicalize.ts` (import shared)
- EDIT `src/idle/continue.ts` (import shared)
- CREATE `test/model-id.test.ts`

**Changes**:
1. `src/models/model-id.ts` exports exactly:
   ```ts
   export interface ModelRef { providerID: string; modelID: string }
   export function parseModelString(value: string | undefined): ModelRef | undefined
   export function formatModelString(ref: ModelRef): string   // `${providerID}/${modelID}`
   ```
   `parseModelString` semantics (keep identical to current `src/fallback/index.ts:72-86`): trim, split on FIRST `/`, return `undefined` when slash index ≤ 0 or slash is last char. Pure/total — never throws, returns `undefined` for `undefined`/garbage.
2. `src/fallback/index.ts`: delete local `parseModelString`, add `export { parseModelString } from "../models/model-id"` (re-export keeps `test/fallback.test.ts` imports valid — verified imports at `test/fallback.test.ts:4-9`).
3. `src/fallback/canonicalize.ts`: replace local `splitModel` with `parseModelString` from `../models/model-id` (no circular import: `model-id.ts` imports nothing from `fallback/`). Update the comment at L12-13 (the "duplicated on purpose" rationale is now obsolete).
4. `src/idle/continue.ts:166-174`: delete the inline parse block, call `parseModelString`.

**Acceptance**:
- `rg -n "indexOf\(\"/\"\)" src/` returns hits ONLY in `src/models/model-id.ts`.
- `test/fallback.test.ts` untouched imports still resolve (re-export path).
- `parseModelString` returns identical results to the old function for: `"a/b"`, `"/b"`, `"a/"`, `"a"`, `""`, `undefined`, `"a/b/c"` (→ `{providerID:"a", modelID:"b/c"}`).

**QA** (agent-executed):
```bash
bun test test/model-id.test.ts test/fallback.test.ts test/canonicalize.test.ts test/idle.test.ts
tsc --noEmit
rg -n 'indexOf\("/"\)' src/
```
Evidence: `.sisyphus/evidence/t1-model-id.txt` (paste full command output).

**Commit**: `refactor(models): single model-string parser in src/models/model-id.ts`

---

#### T2. `src/fallback/classify.ts` — full error evidence + terminal/transient discriminators + wait window

**Problem (issue #1 root cause)**: `getErrorMessage` reads only `error.data.message`/`error.message`/`error.cause` — NEVER `error.data.responseBody`, so `FreeUsageLimitError`/`GoUsageLimitError` are invisible; `"Rate limit exceeded. Please try again later."` matches `/rate.?limit/i` but no `TERMINAL_QUOTA_PATTERNS` → classified `non_terminal` → `same-model-retry` defers to opencode's own retry loop which backs off until UTC midnight. Additionally nothing reads `responseHeaders`/`retry-after`, so wait duration is unknown.

**Files**:
- EDIT `src/fallback/classify.ts`
- EDIT `test/fallback.test.ts` (or CREATE `test/classify.test.ts` if it grows past ~200 lines — executor's call, one of the two)

**Changes** (exact):
1. New exports (pure, total):
   ```ts
   export function getErrorResponseBody(error: unknown): string
   export function getErrorHeaders(error: unknown): Record<string, string>
   export function getRetryAfterSeconds(error: unknown): number | undefined
   export function getWaitSeconds(error: unknown): number | undefined
   export function getEvidenceText(error: unknown): string
   ```
   - `getErrorResponseBody`: `error.data.responseBody` when string, else `""`.
   - `getErrorHeaders`: `error.data.responseHeaders` when it is a plain object of string→string (accept mixed case; normalize keys to lowercase), else `{}`.
   - `getRetryAfterSeconds`: header `"retry-after"` (case-insensitive) parsed as a finite number ≥ 0 → that many SECONDS; non-numeric → `undefined`. Also accept `error.data.retryAfter` if a finite number ≥ 0 (seconds; defensive).
   - `getWaitSeconds(error)`: `getRetryAfterSeconds(error)` if defined; else `error.next` if a finite number ≥ 0 treated as **epoch ms** → `Math.max(0, (next - Date.now())/1000)` (this is the `session.status` retry shape, `retry.ts:201 next = now + wait`); else parse from message via `parseResetSeconds(message)` (below); else `undefined`.
   - `parseResetSeconds(message: string, now = new Date())`: exported helper. Matches `/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i` (e.g. `"resets 4:20pm (Europe/Vilnius)"`, `"resets at 16:20"`) → seconds until that local wall-clock time today; if that instant is already past → +24h. Also matches `/resets?\s+(?:in\s+)?(\d+)\s*(second|minute|hour|day)s?/i` → seconds. Returns `undefined` when nothing matches. Never throws.
   - `getEvidenceText(error)`: `getErrorName(error) + "\n" + getErrorMessage(error) + "\n" + getErrorResponseBody(error)` — the ONLY text used for pattern matching from now on. `getErrorMessage` itself stays display-only (unchanged semantics, used in the fallback note).
2. Classification pattern sets (match against lowercased `getEvidenceText`):
   - **TERMINAL_DISCRIMINATORS** (checked FIRST, win over everything): `/freeusagelimiterror/`, `/gousagelimiterror/`, `/blackusagelimiterror/`, `/quota_?exceeded/`, `/credit_balance_exhausted/`, `/insufficient_?quota/`, `/exceeded_current_quota_error/`, `/(organization|project)_spend_limit_exceeded/`, `/organization_usage_limit_exceeded/`, `/weight_exceeds_budget/`, `/billing_error/`, `/payment_?required/`, `/glmcodingplan/` (Z.ai `1309` wording), plus existing `TERMINAL_QUOTA_PATTERNS` entries kept verbatim (`/usage.?limit/i`, `/limit.?reached/i`, `/reached.?your.?limit/i`, `/out.?of.?credits?/i`, `/credit.?balance/i`, `/insufficient.?credit/i`, `/billing/i`, `/session.?limit/i`, `/hit your/i`, `/you'?ve hit/i`, `/resets?\s+\d/i`, `/额度|配额|余额不足/`).
   - Z.ai business codes: `/\"code\"\s*:\s*\"(1113|1308|1309|1310|131[6-9]|132[01])\"/` → terminal; `/\"code\"\s*:\s*\"(1302|1305)\"/` → transient (these two ONLY via code, not via message text).
   - **TRANSIENT_DISCRIMINATORS**: `/in_flight_budget_exhausted/`, `/engine_overloaded_error/`, `/provider_overloaded/`, `/provider_unavailable/`, `/overloaded_error/`, `/service_?unavailable/`, `/server_is_overloaded/`, `/rate_limit_exceeded/`, `/slow_down/`, `/too_many_requests/`, `/rate_limit_reached_error/`, `/resource_?exhausted/`.
3. **`classifyError(error, retryOnErrors)` decision order (replace the current order):**
   1. `CONTEXT_OVERFLOW_PATTERN` match on evidence → `"context_overflow"`.
   2. Any `TERMINAL_DISCRIMINATORS` match (incl. Z.ai terminal codes) → `"terminal_quota"`.
   3. Status is 429 or 402 (via `getStatusCode`) AND `getRetryAfterSeconds(error) === undefined` → `"terminal_quota"` (the Anthropic spend-cap / OpenAI credit rule).
   4. Any `TRANSIENT_DISCRIMINATORS` match → `"non_terminal"`.
   5. `isRetryableError(error, retryOnErrors)` (KEEP the existing function and its four-step order, but run its pattern checks against `getEvidenceText` instead of `getErrorMessage` only) → `"non_terminal"`.
   6. Else `"not_retryable"`.
4. `isRetryableError` update: the `error.data.isRetryable === false` non-veto rationale stays (comment preserved). Bare `MessageAbortedError` with NO matching evidence pattern stays non-retryable (user cancellation).
5. Do NOT delete any existing `RETRYABLE_ERROR_PATTERNS` entry (including the unverified Chinese ones and `/hit your/i` family) — only ADD. Broad `/\blimit\b/i` catch-all stays LAST.

**Acceptance**:
- `classifyError({data:{message:"Rate limit exceeded. Please try again later.", statusCode:429, responseBody:'{"type":"error","error":{"type":"FreeUsageLimitError"}}'}})` → `"terminal_quota"`.
- `classifyError({data:{message:"Rate limit exceeded. Please try again later.", statusCode:429, responseBody:'{"error":{"type":"FreeUsageLimitError"}}', responseHeaders:{"retry-after":"36000"}}})` → `"terminal_quota"` (discriminator wins even with retry-after).
- `classifyError({data:{message:"The engine is currently overloaded, please try again later", statusCode:429, responseBody:'{"error":{"type":"engine_overloaded_error"}}', responseHeaders:{"retry-after":"5"}}})` → `"non_terminal"`.
- `classifyError({data:{message:"boom", statusCode:429}})` (no headers, no body) → `"terminal_quota"` (rule 3).
- `classifyError({data:{message:"The API is temporarily overloaded.", statusCode:529, responseHeaders:{"retry-after":"30"}}})` → `"non_terminal"`.
- `getWaitSeconds({data:{message:"You've hit your session limit · resets 4:20pm (Europe/Vilnius)"}})` → finite number > 0 and ≤ 86400 (local-time dependent).
- `getWaitSeconds({data:{message:"x"}, next: Date.now()+120000})` → ≈120 (±5).
- `getWaitSeconds({data:{message:"x"}})` → `undefined`.
- `classifyError(MessageAbortedError-shaped {name:"MessageAbortedError", data:{message:"interrupted"}})` → `"not_retryable"` (unchanged).

**QA** (agent-executed):
```bash
bun test test/fallback.test.ts   # or test/classify.test.ts if split out
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t2-classify.txt`. Test file must contain one `test.each` table named `terminal discriminators` and one named `transient discriminators` covering ALL the patterns listed in change 2 (each pattern gets at least one fixture).

**Commit**: `fix(fallback): classify terminal quota from responseBody/headers and compute wait window`

---

#### T3. `src/models/resolveFamily.ts` — precise per-vendor family detection (issue #3)

**Problem**: `modelID.includes("gpt")` misclassifies any id containing "gpt"; `"yi"` is a 2-char needle; `providerID` accepted but unused; no `grok`/`minimax` families.

**Files**:
- EDIT `src/models/resolveFamily.ts`
- REWRITE `test/resolveFamily.test.ts`
- EDIT `src/models/tuning.ts` (family-dependent bits — see change 5)
- EDIT `src/prompts/guards.ts` only if `ModelFamily` import list needs updating (it re-exports the type — no change expected)

**Changes** (exact):
1. New union (9 families):
   ```ts
   export type ModelFamily =
     | "claude" | "gpt" | "gemini" | "kimi" | "glm"
     | "grok" | "minimax"
     | "openrouter-generic" | "fallback";
   ```
2. Matching algorithm — token-based, no bare `includes` on the full id:
   ```ts
   const tokens = modelID.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
   const joined = tokens.join(" ");
   ```
   Then FIRST-EXECUTED-WINS. **This exact order is authoritative** (vendor tokens must beat `gpt` so `deepseek/gpt-oss-120b` is openrouter-generic, not gpt):
   1. `"claude"` if `tokens` contains `claude` OR `opus` OR `sonnet` OR `haiku` OR `fable` OR `mythos`.
   2. `"kimi"` if `tokens` contains `kimi` OR `moonshot` OR `k2` OR `k3` OR (`swe` AND `2`).
   3. `"glm"` if `tokens` contains `glm` OR `zhipu` OR `bigmodel`.
   4. `"grok"` if `tokens` contains `grok`.
   5. `"minimax"` if `tokens` contains `minimax` (plain token check — do NOT match bare `m1`/`m2`).
   6. `"gemini"` if `tokens` contains `gemini` OR `gemma`.
   7. `"openrouter-generic"` if `tokens` contains `deepseek` OR `qwen` OR `yi` (as a **standalone token only** — `["yi"]`, `["yi","34b"]` match; `family` tokenizes to `["family"]` so `yi` never matches inside a word).
   8. `"gpt"` if `tokens` contains `gpt` OR `chatgpt` OR `dall-e` OR `dalle` OR `openai` OR a full token matches `/^o[1-9]$/` (tokens split on hyphens, so `o3-mini` → `["o3","mini"]` and `o3` matches; covers `o1`, `o3`, `o4`) OR token starts with `text-embedding` OR is `text-davinci` OR is `codex`.
   9. `"openrouter-generic"` if `tokens` contains `openrouter`.
   10. Else `"fallback"`.
   - **ProviderID is accepted and preserved in the signature but STILL not used for routing** (matches documented behavior "no provider gate" — the user asked for precision of family identity, not provider gating; the openrouter-slug form `vendor/model-id` is handled because `vendor` becomes a token: e.g. `anthropic/claude-3.5` → tokens `[anthropic, claude, 3, 5]` → rule 1).
3. Explicit regression fixtures that must classify CORRECTLY (these are the bug cases):
   - `{providerID:"openrouter", modelID:"openai/gpt-4o"}` → `"gpt"` (slug token `openai` → rule 8).
   - `{providerID:"openrouter", modelID:"deepseek/gpt-oss-120b"}` → `"openrouter-generic"` (rule 7 beats rule 8).
   - `{providerID:"meta", modelID:"llama-3.1-70b"}` → `"fallback"` (no collision).
   - `{providerID:"x", modelID:"family-guy-model"}` → `"fallback"` (2-char `yi` no longer matches inside `family`).
   - `{providerID:"x", modelID:"my-gpt-helper"}` → `"gpt"` (contains `gpt` token — ACCEPTED, this is what family means).
   - `{providerID:"x", modelID:"lightning-fast"}` → `"fallback"`.
   - `{providerID:"x", modelID:"grok-4-5"}` → `"grok"`.
   - `{providerID:"x", modelID:"minimax-m2"}` → `"minimax"`.
   - `{providerID:"x", modelID:"MiniMax-M1"}` → `"minimax"` (case-insensitive tokens).
   - `{providerID:"deepseek", modelID:"deepseek-chat"}` → `"openrouter-generic"`.
   - `{providerID:"", modelID:""}` → `"fallback"`, must not throw.
   - `{providerID:"zhipuai", modelID:"glm-4.6"}` → `"glm"` (zhipu → glm, NOT generic).
4. `isCheapSamplingFamily` — KEEP the export and behavior (kimi/glm/openrouter-generic → true) but ADD `grok: false`, `minimax: false` via the type (the function body already switches on equality — adding families to the union is enough; `test/resolveFamily.test.ts` asserts the new members are false).
5. `src/models/tuning.ts`:
   - `DEFAULT_SAMPLING` — unchanged keys (kimi/glm/openrouter-generic get 0.3/0.9). ADD explicit `grok: { temperature: 0.3, topP: 0.9 }`? **NO — decision: do NOT add sampling defaults for grok/minimax** (X.AI and MiniMax have their own defaults; the 0.3/0.9 doctrine was for cheap OpenRouter samplers). Nothing to change in the map.
   - `reasoningConfigForFamily` — ADD case: `"grok"` → `{}` (Grok reasoning is controlled by model id, not params) and `"minimax"` → `{}`. Both already covered by the `return {}` default — **so NO code change needed in tuning.ts**; just verify `tsc` passes with the wider union (add the two cases explicitly as `return {}` with a comment, for readability).
6. README family list (L55-58) — deferred to T13.

**Acceptance**:
- `bun test test/resolveFamily.test.ts` green with the fixtures in change 3 as an explicit `describe("regression: no substring collisions")` block.
- Totality test asserts the return is always one of the NINE literals.
- `test.each` collision table: `["family-guy-model","lightning-fast","yikes-model","vladimir-ilyich","miniature-max"]` all → `"fallback"` (the `yi`/`minimax` needles no longer fire inside words — `miniature-max` tokenizes to `[miniature, max]`, `minimax` not present).

**QA** (agent-executed):
```bash
bun test test/resolveFamily.test.ts test/tuning.test.ts test/sisyphus-dispatch.test.ts
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t3-resolve-family.txt`.

**Commit**: `fix(models): token-precise family detection with grok and minimax families`

---

#### T4. `src/models/resolveVersion.ts` — ordering fixes

**Files**: EDIT `src/models/resolveVersion.ts`, EDIT `test/resolveVersion.test.ts`

**Changes** (exact):
1. Version check order — longest/most-specific first. `claude-opus-5-<x>` style ids must resolve to `claude-opus-5` only after any hypothetical 5-x versions; since only `claude-opus-5` exists in `ModelVersion`, FIX the real bug: `claude-opus-5-5` must NOT be swallowed ambiguously — decision: `claude-opus-5` matches `/claude-opus-5(?![0-9])/` (digit-boundary, same style as grok) so `claude-opus-5-5` → `undefined` (falls to family prompt, which is correct since `claude-opus-5-5` is NOT the shipped `claude-opus-5` version prompt). Same digit-boundary for `claude-opus-4-7`/`claude-opus-4-8` (already positional, keep `includes` but make them `/claude-opus-4-7(?![0-9])/` style).
2. kimi-k2 ordering: `/kimi-k2-6(?![0-9])/` then `-7` then `-8` as three separate patterns (the current `/kimi-k2[.\-]?6|7|8/` alternation binds wrong and the `[.\-]?` is dead after dot normalization). Keep the normalization `toLowerCase().replaceAll(".","-")`.
3. `/^swe-2/` → `/swe-2(?:[-.]|$)/` (NOT anchored at string start) so `moonshotai/swe-2` and `kimi-swe-2` both match; and check `kimi-swe-2` BEFORE the generic k2 checks (a `swe-2` id must not be eaten by `kimi-k2` patterns — it isn't today, but keep the order explicit: k2-6, k2-7, k2-8, k3, swe-2).
4. `minimax`: `includes("minimax")` stays last before `undefined`.

**Acceptance**: new test cases: `"claude-opus-5-5"` → `undefined`; `"claude-opus-5"` → `"claude-opus-5"`; `"moonshotai/swe-2"` → `"kimi-swe-2"`; `"kimi-k2.7"` → `"kimi-k2-7"`; `"grok-4-5"` → `"grok-4-5"`; `"grok-4-51"` → `undefined`.

**QA**:
```bash
bun test test/resolveVersion.test.ts test/sisyphus-dispatch.test.ts
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t4-resolve-version.txt`.

**Commit**: `fix(models): digit-boundary and ordering in resolveVersion`

---

#### T5. `src/prompts/guards.ts` — `apply_patch` guidance gated to the real tool visibility

**Files**: EDIT `src/prompts/guards.ts`, EDIT `test/guards.test.ts`, EDIT `src/index.ts` (only the call site — see change 3)

**Changes** (exact):
1. Replace `getGuards(family)` with `getGuards(family, modelID)` (modelID: `string`):
   ```ts
   const useApplyPatch = modelID.toLowerCase().includes("gpt-")
     && !modelID.toLowerCase().includes("oss")
     && !modelID.toLowerCase().includes("gpt-4");
   ```
   Return value:
   - `useApplyPatch === true` → `[TOOL_LOOP_GUARD, APPLY_PATCH_GUIDANCE]`
   - else if family is `"claude"` → `[]` (unchanged)
   - else → `[TOOL_LOOP_GUARD, EDIT_TOOL_GUIDANCE]` where `EDIT_TOOL_GUIDANCE = "Use the \`edit\` tool for file edits. Keep patches small and match the surrounding lines exactly so verification passes."` (mirror wording of the existing constant, new export).
   - This mirrors `packages/opencode/src/tool/registry.ts:295-301` EXACTLY: the guidance must never mention a tool the model does not have. Note the gate is intentionally substring-based on `gpt-` (same as opencode's) even though T3 made family detection precise — the family value is NOT used for this decision beyond the claude special case.
2. `getGuards` keeps its `ModelFamily` re-export. Update the doc comment: cite `packages/opencode/src/tool/registry.ts:295-301` as the source of truth for the rule.
3. Call site `src/index.ts` (`experimental.chat.system.transform` hook, ~line 370): `getGuards(family)` → `getGuards(family, input?.model?.id ?? "")`. Add the `modelID` argument there and nowhere else (`rg getGuards src/` must show exactly one call site).

**Acceptance**:
- `getGuards("gpt", "gpt-5.5")` includes `APPLY_PATCH_GUIDANCE`.
- `getGuards("gpt", "gpt-4o")` includes `EDIT_TOOL_GUIDANCE`, NOT `APPLY_PATCH_GUIDANCE`.
- `getGuards("gpt", "gpt-oss-20b")` includes `EDIT_TOOL_GUIDANCE`.
- `getGuards("gemini", "gemini-2.5-pro")` / `("kimi","kimi-k2")` / `("glm","glm-4.6")` / `("grok","grok-4-5")` / `("minimax","minimax-m2")` / `("openrouter-generic","deepseek-chat")` / `("fallback","x")` → `EDIT_TOOL_GUIDANCE`.
- `getGuards("claude", "claude-opus-5")` → `[]`.
- `getGuards("gpt", "o3-mini")` → `EDIT_TOOL_GUIDANCE` (no `gpt-` substring).

**QA**:
```bash
bun test test/guards.test.ts test/index.test.ts
tsc --noEmit
rg -n "getGuards\(" src/
```
Evidence: `.sisyphus/evidence/t5-guards.txt`.

**Commit**: `fix(prompts): apply_patch guidance only for models opencode actually gives apply_patch`

---

#### T6. New families `grok` + `minimax` prompt builders + dispatch (Q2a)

**Files**:
- CREATE `src/prompts/sisyphus/families/grok.ts`
- CREATE `src/prompts/sisyphus/families/minimax.ts`
- EDIT `src/prompts/sisyphus/dispatch.ts`
- EDIT `test/sisyphus-dispatch.test.ts`

**Changes** (exact):
1. `grok.ts` exports `buildGrokSisyphusPrompt(): string`. `minimax.ts` exports `buildMinimaxSisyphusPrompt(): string`. Both are STATIC text blocks (~150-300 LOC each) in the exact structural style of `src/prompts/sisyphus/families/kimi.ts` / `glm.ts` (read those two first and mirror their section skeleton: identity block, tool-discipline block, output-format block, self-verification block). Content requirements:
   - `grok.ts`: emphasize terse factual answers, high reasoning latency tolerance, tool-call precision, no sycophancy, JSON/structured output when asked, explicit uncertainty statements. Calibrated for xAI Grok 4.x behavior.
   - `minimax.ts`: emphasize long-context discipline (MiniMax M-series), instruction adherence, code-edit precision, avoiding gratuitous rewrites, stable formatting.
   - Both must START with the SISYPHUS identity framing used by the other family builders so `isSisyphusSession` semantics stay coherent, and must NOT contain the string `You are Sisyphus - the Master Orchestrator.` verbatim (that is the marker owned by `agents/sisyphus.md` and `dispatch.ts:29` — do not create a second source).
   - Do NOT copy `TOOL_LOOP_GUARD`/`APPLY_PATCH_GUIDANCE` into these blocks (guards are appended separately by `src/index.ts`).
2. `src/prompts/sisyphus/dispatch.ts` `buildDynamicSisyphusPrompt`:
   - Family switch gains `case "grok": return buildGrokSisyphusPrompt()` and `case "minimax": return buildMinimaxSisyphusPrompt()`.
   - Version-first behavior stays: `resolveModelVersion(modelID)` → `VERSION_BUILDERS[version]()` (grok-4-5/grok-4-6/minimax version prompts keep priority over family prompts).
   - `openrouter-generic` and `fallback` continue → `buildFallbackSisyphusPrompt()`.
3. `test/sisyphus-dispatch.test.ts`: add cases `("grok","grok-4-9")` → `buildGrokSisyphusPrompt()` output (no version prompt since 4-9 isn't in `ModelVersion`), `("minimax","minimax-m2")` → minimax builder, `("grok","grok-4-5")` → the VERSION builder output (version wins).

**Acceptance**: `bun test test/sisyphus-dispatch.test.ts` green; `buildDynamicSisyphusPrompt("grok", "grok-9")` returns the grok block (non-empty, ≠ fallback block).

**QA**:
```bash
bun test test/sisyphus-dispatch.test.ts test/resolveVersion.test.ts
tsc --noEmit
wc -l src/prompts/sisyphus/families/grok.ts src/prompts/sisyphus/families/minimax.ts
```
Evidence: `.sisyphus/evidence/t6-families.txt` (wc output must show both files ≥ 120 lines).

**Commit**: `feat(prompts): grok and minimax sisyphus family builders`

---

### Wave 2 — state & orchestration (sequential after T2)

---

#### T7. `src/config/astrocode.ts` — new config fields

**Files**: EDIT `src/config/astrocode.ts`, EDIT `test/config.test.ts`

**Changes** (exact):
1. `FallbackConfig` (`src/fallback/config.ts` — NOTE: the interface lives HERE, parser in `config.ts`) gains:
   ```ts
   same_model_max_retries: number;   // default 2
   same_model_max_wait_seconds: number; // default 300
   ```
   Edit `src/fallback/config.ts`: add both to the interface + `DEFAULT_FALLBACK_CONFIG` (`same_model_max_retries: 2`, `same_model_max_wait_seconds: 300`) + `parseFallbackConfig` (via `asNonNegativeInt`, keep defaults on garbage).
2. `AstrocodeConfig` (`src/config/astrocode.ts:45+`) gains:
   ```ts
   subagents: { inherit_parent_model: boolean };
   ```
   Default `{ inherit_parent_model: false }` in `EMPTY_ASTROCODE_CONFIG`. Parsed from root key `subagents` (`input.subagents?.inherit_parent_model === true` only — any non-`true` value → `false`).
   **Naming deviation from the approved flag name `agents.inherit_parent_model` is locked** (see Context §Naming deviation). Do not ALSO accept the old name (one source of truth).
3. `mergeConfigLayers`: `subagents` is shallow-merged like `fallback`/`sampling` (nearest layer wins per field).
4. `loadAstrocodeConfig` inline-options path: `options.subagents` (if present in the plugin options object) overrides file values, same shape.
5. The existing bridge `agents[name].fallbackModels` → `fallback.agents[name] = {models}` stays as-is.

**Acceptance**:
- `parseFallbackConfig({}).same_model_max_retries === 2`, `same_model_max_wait_seconds === 300`.
- `loadAstrocodeConfig` on a fixture with `{"subagents":{"inherit_parent_model":true}}` → `config.subagents.inherit_parent_model === true`.
- Absent `subagents` key → `false`.
- `test/config.test.ts` adds a `describe("subagents.inherit_parent_model")` block.

**QA**:
```bash
bun test test/config.test.ts test/fallback.test.ts
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t7-config.txt`.

**Commit**: `feat(config): same_model retry budget, wait threshold and subagents.inherit_parent_model`

---

#### T8. `src/fallback/state.ts` — multi same-model retry + rotation-immune throttle

**Files**: EDIT `src/fallback/state.ts`, EDIT `test/fallback.test.ts`

**Changes** (exact):
1. `SessionAttemptState.sameModelRetried: boolean` → `sameModelAttempts: number`. Remove `hasSameModelRetried` / `markSameModelRetried` / `resetSameModelRetried` exports. Add:
   ```ts
   export function getSameModelAttempts(sessionID: string): number
   export function incrementSameModelAttempts(sessionID: string): number
   export function resetSameModelAttempts(sessionID: string): void
   ```
2. Replace `shouldThrottle` with TWO functions (delete the old one — update all call sites):
   ```ts
   export function shouldThrottleRotation(sessionID: string, maxAttempts: number): boolean
   // true iff state exists && attempts >= maxAttempts. Cooldown NEVER consulted.
   export function shouldThrottleSameModel(sessionID: string, cooldownSeconds: number, now = Date.now()): boolean
   // true iff state exists && elapsed < effectiveCooldownSeconds(cooldownSeconds, consecutiveFailures)
   ```
   `effectiveCooldownSeconds` unchanged.
3. `recordAttempt` — reset `sameModelAttempts` to 0 on each rotation (a model switch clears the same-model budget for the NEW model). Keep `consecutiveFailures: (prev ?? 0) + 1`.
4. LRU bound: `const MAX_STATES = 1024`. At the end of `recordAttempt` and `markRetryKey`, if `states.size > MAX_STATES` (resp. `retryKeys.size > MAX_STATES`), delete the OLDEST 25% entries by `lastAttemptAt` (resp. insertion order via Map iteration order). Never throw.
5. `resetFailures` / `resetAttempts` KEEP their exports (they get called in T9).

**Acceptance**:
- `shouldThrottleRotation` never returns `true` for `attempts < maxAttempts` regardless of elapsed time.
- `shouldThrottleSameModel` returns `true` within cooldown and `false` after `effectiveCooldownSeconds` elapsed (use injected `now`).
- `incrementSameModelAttempts` ×2 → `getSameModelAttempts === 2`; `resetSameModelAttempts` → 0.
- `recordAttempt` zeroes `sameModelAttempts`.
- Map never exceeds 1024 entries in a synthetic loop of 5000 `recordAttempt` calls with distinct ids.

**QA**:
```bash
bun test test/fallback.test.ts test/idle.test.ts
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t8-state.txt`.

**Commit**: `fix(fallback): multi same-model retries and rotation-immune throttle`

---

#### T9. `src/fallback/index.ts` — wait-window rotation, provider-aware pick, throttle fixes

**Files**: EDIT `src/fallback/index.ts`, EDIT `test/fallback.test.ts`

**Changes** (exact):
1. `decideFallback(config, sessionID, error, agent?, currentModel?)`:
   - Replace `shouldThrottle(...)` with `shouldThrottleRotation(sessionID, config.max_attempts)` → `{retry:false, reason:"throttled"}` (unchanged reason string).
   - Replace the `non_terminal → same-model-retry` block with:
     ```ts
     if (errorClass === "non_terminal") {
       const wait = getWaitSeconds(error);
       const longWait = wait !== undefined && wait > config.same_model_max_wait_seconds;
       if (!longWait && getSameModelAttempts(sessionID) < config.same_model_max_retries) {
         return { retry: false, reason: "same-model-retry", errorClass,
                  detail: wait === undefined ? "wait=unknown" : `wait=${Math.round(wait)}s` };
       }
       // long wait or budget spent → rotate immediately (Q1 amendment)
     }
     ```
   - Rotation block: keep `attempts % candidates.length` rotation and `pickFallbackModel`, EXTEND `pickFallbackModel` signature to `(candidates, currentModel?, lastUsed?, preferDifferentProviderFrom?)`. When `preferDifferentProviderFrom` is a non-empty providerID: stable-partition the rotated list so entries whose `parseModelString(c)?.providerID.toLowerCase() !== preferDifferentProviderFrom.toLowerCase()` come first. Then apply the existing equivalence filter and take the first remaining.
   - Call it as `pickFallbackModel(rotated, currentModel, lastUsed, errorClass === "terminal_quota" ? parseModelString(currentModel ?? "")?.providerID : undefined)`.
   - `chain-exhausted` when nothing survives filtering (unchanged).
2. `dispatchFallback`:
   - The cheap-rejection `shouldThrottle` at L247 → `shouldThrottleRotation(sessionID, config.max_attempts)`.
   - `same-model-retry` handling at L263: `incrementSameModelAttempts(sessionID)` (replaces `markSameModelRetried`).
   - Success path (after `promptAsync` with no `result.error`): `resetSameModelAttempts(sessionID)`, `resetFailures(sessionID)`, `clearRetryKeys(sessionID)` (add the missing `resetFailures` — this is the dead-code fix).
   - `recordAttempt` stays where it is (before resubmit).
   - The synthetic note text is UNCHANGED.
   - `parseModelString` now comes from `../models/model-id` (T1 re-export covers it — no call-site change needed if the re-export is used; prefer importing directly from `../models/model-id` in this file and keeping the re-export line for test compat).
3. `collectLastUserText` — unchanged behavior (visible-preferring scan). `abortSession` unchanged. Child-abort special case (`no-fallback-models` + `terminal_quota` + `isChildSession`) unchanged.

**Acceptance** (fixtures in `test/fallback.test.ts`):
- Terminal quota + `wait=28800s` (`"resets 4:20pm"` far away) on model A with chain `[A,B,C]` → `{retry:true, reason:"retry", model:"...B..."}` IMMEDIATELY (no `same-model-retry`), even on the FIRST failure.
- Transient error with `retry-after: 30` and budget 2 → first call `{retry:false, reason:"same-model-retry"}`, second call (after `incrementSameModelAttempts`) again `same-model-retry`, third call → rotates to B.
- Transient error with `retry-after: 7200` (> 300s) → rotates immediately (reason `"retry"`).
- **Second-hop regression (the user's exact scenario)**: `recordAttempt(s,"A")` then `decideFallback(..., terminalQuotaError, agent, "B")` at `now+1000ms` → `{retry:true, model:"...C..."}` (NOT `"throttled"`). This test must exist with the literal name `test("terminal quota is never cooldown-throttled (second hop)")`.
- `shouldThrottleRotation` exhaustion: `max_attempts: 1`, one `recordAttempt` → `decideFallback` returns `"throttled"`.
- Provider-aware: chain `["anthropic/claude-opus-5-5","anthropic/claude-sonnet-5","google/gemini-2.5-pro"]`, terminal quota on `anthropic/claude-sonnet-5`, currentModel `anthropic/claude-sonnet-5`, lastUsed `anthropic/claude-opus-5-5` → picks `google/gemini-2.5-pro` (skips the remaining anthropic candidate... there is none unfiltered; add fixture chain `["anthropic/claude-opus-5-5","anthropic/claude-sonnet-5","anthropic/claude-haiku-4","google/gemini-2.5-pro"]` → must pick `google/gemini-2.5-pro`, NOT `claude-haiku-4`).

**QA**:
```bash
bun test test/fallback.test.ts test/index.test.ts test/idle.test.ts
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t9-fallback-orchestrator.txt` (include the named second-hop test output line).

**Commit**: `fix(fallback): rotate immediately on terminal quota and long waits, multi same-model retries`

---

### Wave 3 — integration

---

#### T10. `src/index.ts` config hook — subagent model cascade (issue #2)

**Files**: EDIT `src/index.ts`, EDIT `src/config/astrocode.ts` (only if a helper is needed), EDIT `test/index.test.ts`

**Changes** (exact):
1. In the `config` hook, replace the current `personaToAgentConfig(persona, persona.model, undefined)` construction (L206-210) with a resolution step per persona:
   ```ts
   const settings = astrocodeConfig.agents[key] ?? astrocodeConfig.agents[displayName];
   const explicitModel = settings?.model;                     // per-agent model (unchanged source)
   const globalModel = astrocodeConfig.model ?? defaultModel; // Q4(a): astrocode overrides opencode
   const resolvedModel =
     explicitModel ??
     (astrocodeConfig.subagents.inherit_parent_model ? undefined : globalModel);
   const agentConfig = {
     ...personaToAgentConfig(persona, resolvedModel, undefined),
     ...existing, description, mode, prompt,
   };
   ```
   - **`resolvedModel` is written into EVERY agent entry (primary/all/subagent alike)**. This is SAFE because the TUI always sends `model` in the prompt body (`packages/tui/src/component/prompt/index.tsx:1095`) so `prompt.ts:646 input.model ?? ag.model ?? …` never lets `ag.model` override a user's picker choice; and it is REQUIRED because `task.ts:181-184` (`next.model ?? parent`) is exactly where parent-inheritance happens.
   - When `explicitModel` is set, `persona.model` currently comes from `toAgentConfigs` (`src/agents/personas.ts` `entry.model = settings.model` — same value). To avoid double logic, drop the `persona.model` argument usage in favor of `resolvedModel` computed here (single place). `personaToAgentConfig`'s `model` parameter keeps its signature.
   - `inherit_parent_model: true` + no `explicitModel` → `resolvedModel === undefined` → NO `model` key written → opencode's old parent-inheritance contract restored (escape hatch).
2. `personaToAgentConfig` — make it omit the `model` key entirely when the value is `undefined` (verify current behavior; if it already does, no change).
3. The reasoning-branch `agentModel = persona.model ?? astrocodeConfig.model ?? defaultModel` becomes `agentModel = resolvedModel` (same value now; keeps behavior and kills the duplicated chain).
4. `familyForModel(resolvedModel)` for the reasoning branch — unchanged logic.
5. **Do NOT** add a `model`-override in the `chat.message` hook for the global model: `input.model` from the TUI is authoritative there (Must-NOT-Have).

**Acceptance**:
- Fixture config `{"model":"openrouter/deepseek-chat","subagents":{"inherit_parent_model":false},"agents":{"explore":{"model":"moonshotai/kimi-k2"}}}` + fake root config `{}`:
  - explore entry `.model === "moonshotai/kimi-k2"` (explicit wins).
  - every other persona entry `.model === "openrouter/deepseek-chat"` (global cascade).
- Same fixture with `"subagents":{"inherit_parent_model":true}`:
  - explore `.model === "moonshotai/kimi-k2"`;
  - every other entry has NO `model` key (`!("model" in entry)`).
- Fixture with NO astrocode `model` but root `model: "opencode/gpt-5.5"` → entries get `"opencode/gpt-5.5"`.
- Fixture with neither → entries have no `model` key.
- `test/index.test.ts` gains `describe("subagent model cascade")` with these four cases.

**QA**:
```bash
bun test test/index.test.ts test/personas.test.ts test/config.test.ts
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t10-model-cascade.txt`.

**Commit**: `feat(agents): agent-specific model cascade kills parent-model inheritance for subagents`

---

#### T11. `src/index.ts` event hook + `src/idle/continue.ts` — remaining error surfaces

**Files**: EDIT `src/index.ts`, EDIT `src/idle/continue.ts`, EDIT `test/index.test.ts`, EDIT `test/idle.test.ts`

**Changes** (exact):
1. `message.part.updated` — NEW branch in the `event` hook (insert AFTER the `message.updated` branch, same `fallbackConfig.enabled` gate already applied earlier in the flow):
   ```ts
   if (event.type === "message.part.updated") {
     const part = event.properties?.part;
     if (part?.type === "retry" && part.error) {
       const target = event.properties?.info?.sessionID ?? sessionID;
       const key = `retry:${part.attempt}:${getErrorMessage(part.error).trim().slice(0, 200)}`;
       if (markRetryKey(target, key)) {
         const decision = await dispatchFallback(client, fallbackConfig, target, part.error);
         logDecision("message.part.updated", decision);
       }
     }
     return;
   }
   ```
   (`RetryPart { type:"retry", attempt, error: ApiError, time }` — types.gen.d.ts L327-337. Use `event.properties.info?.sessionID` if the payload shape carries it; if `tsc` shows the part event's session id lives elsewhere, use the outer `sessionID` variable already extracted at the top of the hook — do not guess, let `tsc` drive the exact property path and record what you used in the commit body.)
2. `session.status` retry branch — the synthesized error gains the wait:
   ```ts
   dispatchFallback(client, fallbackConfig, target, {
     message: status.message,
     next: status.next,
   } as unknown as { message: string; next: number });
   ```
   `getWaitSeconds` (T2) already understands `error.next` as epoch ms. Keep the existing `markRetryKey` dedup.
3. `src/idle/continue.ts`:
   - Replace the inline model parse (L166-174) with `parseModelString` from `../models/model-id`.
   - Add `agent` to the resubmit body: `const agent = getChildSessionAgent(sessionID); const body = {...(parsedModel ? {model} : {}), ...(agent ? {agent} : {}), parts:[note]}` (import `getChildSessionAgent` from `../fallback/subagent`).
   - Switch `client.session.prompt` → `client.session.promptAsync` (same body shape; `promptAsync` accepts the identical `body`). If the awaited result type differs (`204/void`), drop the `result.error` check and treat a resolved promise as success; wrap the call in the existing try/catch.
4. Do NOT touch the idle continuation's cooldown/backoff math.

**Acceptance**:
- `test/index.test.ts`: synthetic `message.part.updated` event with a `RetryPart` carrying an `ApiError` with `responseBody: "...FreeUsageLimitError..."` and a 3-model chain → `promptAsync` called with model #2 (mock the client, assert the body.model). Same event twice with identical `attempt`+message → only ONE dispatch (dedup).
- Synthetic `session.status` `{type:"retry", next: Date.now()+9_000_000}` on an empty-attempt session → decision is a ROTATION (not `same-model-retry`), because wait > 300s.
- `test/idle.test.ts`: idle continuation body carries `agent` when `registerChildSession` was called; body uses `promptAsync`.

**QA**:
```bash
bun test test/index.test.ts test/idle.test.ts test/subagent.test.ts test/fallback.test.ts
tsc --noEmit
```
Evidence: `.sisyphus/evidence/t11-event-surfaces.txt`.

**Commit**: `feat(fallback): observe RetryPart and status.next; idle continuation keeps agent and goes async`

---

### Wave 4 — audit cleanup, docs, final gate

---

#### T12. Audit fixes (skills TOCTOU, log swallow, dead exports, metadata comment)

**Files**: EDIT `src/skills/extra.ts`, EDIT `src/log.ts`, EDIT `src/agents/metadata.ts`, EDIT `test/extras.test.ts`, EDIT `test/log.test.ts`

**Changes** (exact):
1. `src/skills/extra.ts:70-79` — replace `existsSync`+`symlinkSync` with an EEXIST-tolerant sequence:
   ```ts
   mkdirSync(targetDir, { recursive: true });
   try { symlinkSync(skillDir, target, "dir"); report.linked.push(entry); }
   catch (err) {
     if ((err as NodeJS.ErrnoException)?.code === "EEXIST") { report.skipped.push(entry); }
     else { report.errors.push(`${entry}: ${String(err)}`); }
   }
   ```
   (`mkdirSync` moves BEFORE the try — it is idempotent with `recursive:true`.) The existing `if (existsSync(target)) { report.skipped.push(entry); continue; }` fast-path may stay (it just avoids an exception) but the catch is now authoritative.
2. `src/skills/extra.ts:241-247` — DELETE `discoverSkills()` (dead export; `rg -n "discoverSkills\(" src/ test/` must return zero callers afterwards — if `test/extras.test.ts` imports it, delete those tests too).
3. `src/log.ts:100-102` `swallow()` — make the failure visible without crashing the host:
   ```ts
   function swallow(result: unknown): void {
     void Promise.resolve(result).catch((err) => {
       try { console.error("[astrocode:log]", err); } catch { /* never throw */ }
     });
   }
   ```
4. `src/agents/metadata.ts` — fix the stale doc-comment path `src/prompts/sisyphus/dynamicSections.ts` → `src/prompts/sisyphus/sections.ts`. Comment-only change.
5. Do NOT implement WeakMap conversions — T8's LRU covers the fallback state; for `session-model.ts`/`subagent.ts`/`idle/continue.ts` maps, add the SAME `MAX_STATES = 1024` oldest-25% eviction in `setSessionFallbackModel`, `registerChildSession`, and `maybeContinueIdle`'s `counts`/`states` writes (a tiny shared helper `evictOldest(map: Map<string, {at:number}>, max=1024)` in `src/models/model-id.ts` is NOT appropriate — put it in `src/fallback/state.ts` as `export function evictOldestByStamp<T extends { stamp: number }>(map: Map<string, T>, max?: number)` and import where needed; if a map entry has no timestamp, use insertion order and drop the first 25%).

**Acceptance**:
- `test/extras.test.ts`: new case `linkExtraSkillDirs is idempotent under concurrent double-load` — call `linkExtraSkillDirs` twice on a temp dir fixture; second call must report the same entries as `skipped` (not `errors`).
- `rg -n "discoverSkills\(" src/ test/` → zero hits.
- `test/log.test.ts`: a `LogClient` whose `app.log` rejects → no unhandled rejection (assert via `process.on("unhandledRejection")` spy or by awaiting a tick and asserting the spy console.error was called).

**QA**:
```bash
bun test test/extras.test.ts test/log.test.ts test/index.test.ts
tsc --noEmit
rg -n "discoverSkills\(" src/ test/ ; true
```
Evidence: `.sisyphus/evidence/t12-audit.txt`.

**Commit**: `fix: skills symlink race, visible log failures, dead export, map eviction`

---

#### T13. README contract rewrite

**Files**: EDIT `README.md`

**Changes** (exact line anchors from the current README):
1. **L55-58** — replace "returns one of seven families by `modelID` substring (no provider gate)" with the new contract: nine families (`claude | gpt | gemini | kimi | glm | grok | minimax | openrouter-generic | fallback`) detected by anchored token segmentation (no substring collisions), still no provider gate. State the token rule briefly and link `src/models/resolveFamily.ts`.
2. **L135-137** — keep the "per-agent `fallback_models` fully replaces the global chain" statement (unchanged behavior) but note the chain is used per-agent by the fallback dispatcher for both primary and child sessions.
3. **L143-145** — config layers: add `subagents` to the shallow-merged list alongside `fallback`/`sampling`.
4. **L147-151** — "astrocode handles all three" → "astrocode handles `session.error`, `message.updated`, `message.part.updated` (RetryPart) and `session.status` retries".
5. **L153-157** — replace the `terminal_quota`/`non_terminal` + single `sameModelRetried` description with the new decision table: terminal (incl. 429/402 without `retry-after`, `FreeUsageLimitError`, `GoUsageLimitError`, `quota_exceeded`, `credit_balance_exhausted`, Z.ai `1113/1308-1321`, `weight_exceeds_budget`) → rotate immediately, provider-aware (different provider first); transient → up to `same_model_max_retries` (default 2) same-model retries while the wait is ≤ `same_model_max_wait_seconds` (default 300s), otherwise rotate immediately. Rotations are never cooldown-throttled; `max_attempts` (default 3) caps rotations per session.
6. **L165-167** — `effectiveCooldownSeconds` now applies to same-model retries only, and resets after a successful resubmit.
7. **L169-171** — the "Known gap: ProviderModelNotFoundError" note: update to say `model.?not.?found`/`unknown.?(model|provider)`/`no such model`/`404` are treated as retryable and rotate the chain; the remaining gap is provider auth errors (`ProviderAuthError`) which do NOT rotate (correct: switching model won't fix a bad key).
8. **L203-210** — idle continuation: sends `agent` and the fallback model, non-blocking.
9. **L292-295** — **full rewrite**: "Set `agents.<name>.model` in `astrocode.jsonc`… Resolution order for every agent entry: `agents.<name>.model` → `subagents.inherit_parent_model` gate → global `astrocode.model ?? opencode.jsonc model`. Subagents NEVER inherit the parent agent's model when `subagents.inherit_parent_model` is `false` (the default) — each one gets its own configured model or the global model. Set `"subagents": { "inherit_parent_model": true }` to restore the old inherit-from-parent behavior." Remove the "otherwise the primary agent's model" sentence entirely.
10. Add a short **Config reference** snippet showing `subagents.inherit_parent_model`, `fallback.same_model_max_retries`, `fallback.same_model_max_wait_seconds` with defaults.

**Acceptance**: `rg -n "seven families|inherit the primary|sameModelRetried" README.md` → zero hits; `rg -n "subagents.inherit_parent_model" README.md` ≥ 2 hits.

**QA**:
```bash
rg -n "seven families|the primary agent's model|sameModelRetried" README.md ; true
rg -n "subagents.inherit_parent_model|same_model_max_retries|grok" README.md
```
Evidence: `.sisyphus/evidence/t13-readme.txt` (both command outputs).

**Commit**: `docs(readme): new fallback, model-cascade and family contracts`

---

#### T14. Final gate — full suite + typecheck + regression walk

**Files**: none (verification only); failures route back to the owning T-item.

**QA** (agent-executed, exact):
```bash
bun test
tsc --noEmit
rg -n "indexOf\(\"/\"\)" src/            # only src/models/model-id.ts
rg -n "discoverSkills\(" src/ test/ ; true  # zero
rg -n "getGuards\(" src/                # exactly one call site
rg -n "hasSameModelRetried|markSameModelRetried|resetSameModelRetried" src/ test/ ; true  # zero
rg -n "resetFailures\(" src/            # at least one CALLER in src/fallback/index.ts
```
All commands must exit 0 (the `; true` ones are allowed to print nothing). `bun test` must show 0 failures across all 17+ test files (incl. new `test/model-id.test.ts`).

Evidence: `.sisyphus/evidence/t14-final-gate.txt` (full `bun test` summary + `tsc` output + all rg outputs).

**Commit**: none (verification only). If fixes were needed, each goes back to its T-item's commit message.

---

## Dependency Matrix

| Task | Depends on | Blocks | Wave |
|---|---|---|---|
| T1 model-id | — | T9, T11 | 1 |
| T2 classify | — | T9 | 1 |
| T3 resolveFamily | — | T10 | 1 |
| T4 resolveVersion | — | T13 | 1 |
| T5 guards | — | T13 | 1 |
| T6 grok/minimax | T3 (union) | T13 | 1 |
| T7 config fields | — | T9, T10 | 2 |
| T8 state | — | T9 | 2 |
| T9 orchestrator | T1, T2, T7, T8 | T10, T11 | 2 |
| T10 model cascade | T3, T7, T9 | T13 | 3 |
| T11 event surfaces | T1, T9 | T13 | 3 |
| T12 audit | T8 (evict helper) | T13 | 4 |
| T13 README | T2-T12 | T14 | 4 |
| T14 gate | all | — | 4 |

**Critical path**: T2 → T9 → T10 → T13 → T14.
**Parallel groups**: Wave 1 = {T1,T2,T3,T4,T5} then T6. Wave 2 = T7 ∥ T8, then T9. Wave 3 = T10 ∥ T11.

---

## Verification Gates (run after every T-item and at the end)

```bash
bun test          # 0 failures
tsc --noEmit      # 0 errors
```

Per-T QA commands above are ADDITIVE to these two gates. Evidence for each T-item lands in `.sisyphus/evidence/tN-*.txt` (create the directory if absent: `mkdir -p .sisyphus/evidence`).

---

## Rollback

Every T-item is a standalone commit. Revert order if something breaks in the field: T11 → T10 → T9 → T8 → T2 (the classifier is the riskiest behavioral change; `git revert` of its commit restores the old conservative behavior while keeping the structural work). The `subagents.inherit_parent_model` flag is the user-facing escape hatch for T10 (no revert needed — set `true`).
