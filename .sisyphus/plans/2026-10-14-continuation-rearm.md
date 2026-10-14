# Plan: continuation re-arm across fallback rotations

**Tree:** `/home/ilja/.gitworktree/fix-continuation-rearm` (branch `fix/continuation-rearm`) — ALL work happens in THIS worktree, never in `/home/ilja/Documents/astrocode`.
**Scope:** one PR, 2 commits, `bun test` green, `bun run typecheck` green.
**Bug (user's words):** "один пинок сгорел на мёртвой модели, mimo поработала и встала, второго пинка нет". Root cause: `pending_continuation` is one-shot — `consumePendingContinuation` (src/compaction/state.ts:154) clears it at the first `session.idle` even when the pinned generation afterwards dies and the fallback system rotates to another model. No second pin ever comes.
**Agreed fix (user-approved spec, implement verbatim):** the pin tracks the model's answer status. If the pinned model call fails and fallback rotates, the pin is re-armed and fires again at a later idle — until a generation reaches a clean answer, or the fallback chain is exhausted, or the user intervenes (message/abort), whichever comes first. Plus: enable todo-driven idle continuation in the project config to cover "model answered cleanly but stopped mid-task".

---

## 1. Mechanism (the contract)

Two booleans per session in `CompactionSessionState` (src/compaction/state.ts):

- `pending_continuation` (existing): "send the compaction-continuation pin at the next `session.idle`".
- `continuation_unacked` (NEW): "a compaction-continuation pin was sent and no clean generation has answered it yet". This is what makes re-arm conditional — a fallback rotation in a session that never compacted must NEVER produce a spurious "[astrocode] Context was compacted…" note.

### State-transition table (exhaustive — nothing outside this table touches the two flags)

| # | Event | Observed at | Action on flags |
|---|-------|-------------|-----------------|
| T1 | Compaction run starts, non-child session | src/compaction/run.ts:138-139 (UNCHANGED) | `pending_continuation = true` |
| T2 | Compaction summarizer failed | src/compaction/run.ts:177 (UNCHANGED) | `clearPendingContinuation` (arm only; unchanged) |
| T3 | Pin sent successfully at idle | src/index.ts idle seam, `cont.continued === true` | `continuation_unacked = true` |
| T4 | Fallback **rotation** — `decision.retry === true` (reasons `"retry"` and `"resubmit-failed"`) | `logDecision` choke point in src/index.ts (all 4 fallback seams) | if `continuation_unacked && !isChildSession` → `pending_continuation = true` (re-arm) |
| T5 | Fallback **stop** — `decision.reason` is `"chain-exhausted"` or `"no-fallback-models"` | same choke point | `pending_continuation = false` AND `continuation_unacked = false` (unconditional) |
| T6 | **Clean generation** — `message.updated` on assistant with `info.time.completed` finite and `info.error == null` | src/index.ts `message.updated` telemetry block, BEFORE `maybeCompactAtTurnBoundary` | if `continuation_unacked` → clear BOTH |
| T7 | **Genuine user message** — `chat.message` where `output.parts` has ≥1 part with `synthetic !== true` | src/index.ts `chat.message`, after the force-marker block | clear BOTH |
| T8 | **User abort** — `session.error` with `MessageAbortedError`/`AbortError` that is NOT our own dispatch abort | src/index.ts `session.error` abort block | clear BOTH (in addition to existing `recordAbort`) |
| T9 | Every other fallback decision (`disabled`, `not-retryable`, `same-model-retry`, `in-flight`, `no-user-message`, `error`, `bad-model-string`) | — | **no state change** |

Pin fire at idle (src/index.ts:473-491) keeps today's mutually-exclusive `if/else` (compaction pin first, todo pin in `else if`) plus two additions: the fallback-in-flight guard (below) and `markContinuationSent` after a successful send.

### Why this satisfies the agreed spec

- **Spec 1** (re-arm on rotation): T4.
- **Spec 2(a)** (clean generation → stop): T6 — a clean answer retires the intent, so a successful fallback resubmit can never be followed by a duplicate pin on an already-working session (the "pins an already-working session" case is exactly `T4 → clean resubmit → idle`, and T6 clears before that idle).
- **Spec 2(b)** (chain-exhausted / no-fallback-models → stop): T5. **The fallback chain length IS the cap** — no new config knob. Per-agent `agents.<name>.fallback_models` chains are respected automatically: `dispatchFallback` resolves the chain via `resolveFallbackModels` (src/fallback/index.ts:78) and its `"chain-exhausted"` outcome is computed from that resolved chain; the re-arm observes outcomes only, never chain contents.
- **Spec 2(c)** (user message / abort → clear entirely): T7 + T8.
- **Spec 3** (no double-fire): the flag fires only on a *later* idle, only while `continuation_unacked` — i.e. only if the resubmit did not reach a clean answer. Plus the fallback-in-flight guard closes the `session.error → dispatch → promptAsync` race (see §2.3).
- **Bounded loops:** re-arms happen only on rotations (bounded by chain exhaustion → T5); pin sends are additionally bounded by the pre-existing shared idle-continuation budget (`idleContinuation.max`, default 3, counted in `src/idle/continue.ts` `counts` — the compaction path already passes `max: astrocodeConfig.idleContinuation.max`).

---

## 2. Resolved design decisions (no open questions)

### 2.1 "Clean generation" signal — the real one, no invention
`message.updated` with `info.role === "assistant"`, `info.time.completed` a finite number, `info.error == null`. This is the codebase's own "finished clean assistant message" predicate — `captureAssistantUsage` (src/telemetry/log.ts:849-851) already defines `finished = time.completed !== undefined || info.error != null`; "clean" = finished AND `error == null`. Export that predicate as `isCleanAssistantCompletion(info: unknown): boolean` and use it. No other success signal exists (there is no success hook; `session.idle` fires after failures too).
Accepted edge: an auxiliary request (session-title generation shares the sessionID — see the freeze comment at src/index.ts:853-857) could theoretically clear `continuation_unacked`. Benign and rare (worst case = today's one-shot behavior); do NOT add message-id bookkeeping.

### 2.2 Where the state lives
Extend `src/compaction/state.ts` — the flag already lives there, the entry is per-session, bounded by the existing `COMPACTION_STATE_LIMIT` wholesale-clear eviction, and `resetCompactionState()` covers test teardown. No new module for state; the only new module is `src/compaction/rearm.ts` for the outcome→state glue (below). Process-local like everything else — a plugin restart forgets it (acceptable, documented in the file header comment block).

### 2.3 No double-fire with fallback's own resubmit
Two layers:
1. **Logical:** T6 — a resubmit that reaches a clean answer clears the intent, so no pin follows. A resubmit that fails without rotating leaves `pending_continuation` set from T4 → the pin fires at the next idle ("only if that resubmit also did not reach a clean answer"). A resubmit that fails and rotates re-arms again (chain continues).
2. **Race:** `dispatchFallback` holds `inFlight` (src/fallback/index.ts:65) across `collectLastUserText` + `abortSession` + `promptAsync`. If `session.idle` is delivered while a dispatch is mid-flight, today's code would consume the flag and `promptAsync` a pin *concurrently with the resubmit*. Guard: export `isFallbackDispatchInFlight(sessionID: string): boolean` from src/fallback/index.ts and at the top of the continuation block in the idle seam (AFTER the child-session return, so 10a3180's ordering is untouched) do: `if (isFallbackDispatchInFlight(target)) { log.info("continuation: fallback-in-flight; skip"); return; }` — do NOT consume anything; the next idle reconsiders.

### 2.4 Re-arm trigger point: on rotation (inside the fallback decision outcome), NOT on bare generation failure
Failure-without-rotation (`not-retryable`, `disabled`, `same-model-retry`, `resubmit` never attempted) does **not** re-arm (T9) — the burn is allowed. A not-retryable failure of a pin consumes the attempt without re-arm; a not-retryable failure *after* a rotation leaves the re-armed flag set so the pin fires at the next idle (exactly spec 3). Either way the loop is bounded by `idleContinuation.max` pin sends + chain exhaustion.
`"resubmit-failed"` (decision.retry true but `promptAsync` errored, src/fallback/index.ts:487) counts as a rotation: `recordAttempt` already advanced the chain and the model never got the note — the pin must reach it. T4 covers both `retry:true` reasons.

### 2.5 Self-abort discrimination (why T8 needs a marker)
`dispatchFallback` calls `abortSession` (src/fallback/index.ts:297) before every resubmit. If that programmatic abort surfaces as `session.error` + `MessageAbortedError`, T8 would wipe the flag that T4 just re-armed (the abort event is processed after the current handler returns) — the fix would eat itself. Marker: `markSelfAbort(sessionID, now?)` called inside `abortSession` before `client.session.abort`; the abort handler checks `takeSelfAbort(sessionID, now?)` (read-and-clear, 10s freshness window) and on hit skips BOTH `recordAbort` and the T8 clear (log.debug `continuation-rearm: ignored self-abort (fallback dispatch)`). Read-and-clear (not window-persistent) is deliberate: a double-emitted abort event degrades to "one missed re-pin" (today's behavior), never to a spurious pin over a real user abort.
Side benefit (no regression, strictly an intent fix): today a fallback's own abort poisons `recordAbort` and suppresses todo-continuation for `ABORT_WINDOW_MS`; the comment at src/index.ts:510-511 says that suppression is for *user* cancellation only. Skipping `recordAbort` on self-aborts implements the stated intent.

### 2.6 Two-level fallback chains
Nothing to implement: `resolveFallbackModels` (src/fallback/index.ts:78-88, per-agent fully replaces global) feeds `decideFallback`, and T4/T5 key off the resulting `FallbackDecision`. The chain-length cap therefore follows whichever chain the session's agent uses.

### 2.7 In-flight compaction wait (67f1c8d) and child-session guard (10a3180)
Both untouched. Idle-seam order stays: `touchSessionFallbackModel` → bounded in-flight-compaction wait → `maybeCompactAtIdle` → `isChildSession` return → **NEW fallback-in-flight guard** → continuation `if/else`. T4 is additionally gated `!isChildSession` (children never arm in `run.ts:138`, never pin; a re-arm would just be dead state — we skip it).

### 2.8 Dedup of idle-continuation vs compaction-continuation
Keep the mutually exclusive `if/else` at src/index.ts:476-491. Both notes push "continue the task"; firing both in one idle = two concurrent `promptAsync` generations. The compaction branch takes precedence (it is the rarer, stronger intent), the todo branch runs at idles where no compaction pin is owed. Re-armed pins flow through the compaction branch unchanged (same note text "Context was compacted…" — still accurate; the context *was* compacted, that is why the pin exists). `src/idle/continue.ts` is NOT touched at all.

### 2.9 Config default
Flip ONLY `.opencode/astrocode.jsonc` (`"idleContinuation": { "enabled": true, "max": 3 }`). Do NOT change `src/config/astrocode.ts` (`idleContinuation: { enabled: false }` stays; test/config.test.ts:124 asserts exactly that default). Justification: the compiled default is a safety valve for every other project that loads this plugin (HM-deployed `~/.config/opencode/plugins/` + other checkouts) — always-on todo-continuation silently re-prompts sessions there and the in-file comment says "Off by default to avoid loops". `astrocode.jsonc` is the runtime config for THIS setup and is the right place for the opt-in. The default-flip is explicitly out of scope.

### 2.10 Telemetry/log lines (mirror `compaction-continuation: ${reason}`)
| Line | Level | Where |
|------|-------|-------|
| `continuation-rearm: re-armed (fallback-rotation -> ${model})` | info | T4 effective re-arm |
| `continuation-rearm: rotation without unacked pin; no re-arm` | debug | T4 no-op |
| `continuation-rearm: stop (chain-exhausted)` / `continuation-rearm: stop (no-fallback-models)` | info | T5 |
| `continuation-rearm: stop (clean-answer)` | info | T6 |
| `continuation-rearm: cleared (user-message)` | info | T7 |
| `continuation-rearm: cleared (abort)` | info | T8 |
| `continuation-rearm: ignored self-abort (fallback dispatch)` | debug | T8 self-abort skip |
| `continuation: fallback-in-flight; skip` | info | idle-seam race guard |
| `compaction-continuation: ${cont.reason}` | info | unchanged (pin fire) |

Only log T5–T8 lines when a flag was actually set (keep the healthy path quiet, matching `logDecision`'s doctrine at src/index.ts:593-596).

---

## 3. Implementation todos

### T1 — State machine core (src/compaction/state.ts + unit tests)
**Files:** `src/compaction/state.ts`, `test/compaction.test.ts`.
**Changes:**
1. `CompactionSessionState` — add field:
   ```ts
   /**
    * A compaction-continuation pin was sent and has not yet been answered by a
    * clean generation. Re-arm source: set again by the fallback-rotation seam
    * while this holds. Cleared by a clean answer, chain exhaustion, a genuine
    * user message or an abort.
    */
  continuation_unacked: boolean;
   ```
2. `ensureCompactionState` initializer: `continuation_unacked: false`.
3. New exports (place next to `setPendingContinuation`/`consumePendingContinuation`):
   ```ts
   /** Mark the compaction-continuation pin as sent (awaiting a clean answer). */
   export function markContinuationSent(sessionID: string): void  // state.continuation_unacked = true
   /**
    * Re-arm after a fallback rotation. Only effective while a pin is unacked —
    * a rotation in a session that never got a pin must not fabricate one.
    * Returns true when the flag was armed.
    */
   export function rearmPendingContinuation(sessionID: string): boolean  // if (state?.continuation_unacked) { setPendingContinuation; return true } return false
   /** Clear the whole continuation intent (arm + unacked). */
   export function clearContinuationState(sessionID: string): void  // both = false
   /** True while a sent pin awaits its first clean answer. */
   export function continuationUnacked(sessionID: string): boolean
   ```
4. `compactionStateSnapshot` return type + body: add `pending_continuation: boolean` and `continuation_unacked: boolean` (default `false` when no state). No other snapshot fields change.
5. Update the `setPendingContinuation` docstring: armed by the compaction run OR by `rearmPendingContinuation` (fallback rotation).

**Tests** (new `describe("continuation re-arm state")` in test/compaction.test.ts, using the existing state imports):
1. `markContinuationSent` + `rearmPendingContinuation` → `true`, then `consumePendingContinuation` → `true` (re-armed pin is consumable exactly once), `continuationUnacked` still `true`.
2. `rearmPendingContinuation` without `markContinuationSent` → `false`, `consumePendingContinuation` → `false` (never a spurious pin).
3. `clearContinuationState` clears both: `consumePendingContinuation` → `false`, `continuationUnacked` → `false`, and a following `rearmPendingContinuation` → `false`.
4. Snapshot exposes both fields: seed via `setPendingContinuation` + `markContinuationSent`, assert `snapshot.pending_continuation === true && snapshot.continuation_unacked === true`; after clear both `false`.

**Acceptance:** both flags readable/writable through the 4 new functions; snapshot complete; no behavior change for existing fields (all prior compaction tests stay green).
**QA:** `bun test test/compaction.test.ts` (all green, incl. the 4 new).
**Commit:** C1.

### T2 — Outcome glue + predicates + self-abort + in-flight accessor
**Files:** `src/compaction/rearm.ts` (NEW), `src/telemetry/log.ts`, `src/fallback/state.ts`, `src/fallback/index.ts`, `test/fallback.test.ts`.
**Changes:**
1. **src/telemetry/log.ts** — next to `captureAssistantUsage`, export:
   ```ts
   /** Finished + no error: the observable "clean generation" signal (see captureAssistantUsage). */
   export function isCleanAssistantCompletion(info: unknown): boolean
   ```
   Implementation reuses the file-private `isPlainObject`/`asFiniteNumber`: `isPlainObject(info) && asFiniteNumber((isPlainObject(info.time) ? info.time : {}).completed) !== undefined && info.error == null`.
2. **src/fallback/state.ts** — module const `SELF_ABORT_WINDOW_MS = 10_000`; bounded `const selfAborts = new Map<string, number>()` (evict with the existing `evictOldestByStamp` on write); exports:
   ```ts
   /** Remember that THIS plugin aborted the session (fallback dispatch). */
   export function markSelfAbort(sessionID: string, now: number = Date.now()): void
   /** Read-and-clear: true iff marked within SELF_ABORT_WINDOW_MS. */
   export function takeSelfAbort(sessionID: string, now: number = Date.now()): boolean
   ```
   `clearAll()` also clears `selfAborts`.
3. **src/fallback/index.ts**:
   - `abortSession` (L297): first statement inside `try` (before the `Promise.race`) — `markSelfAbort(sessionID);` (import from `./state`).
   - Export: `export function isFallbackDispatchInFlight(sessionID: string): boolean { return inFlight.has(sessionID); }`.
   - NO re-arm logic here — fallback stays generic; outcomes are interpreted in index.ts (T3).
4. **src/compaction/rearm.ts** (NEW) — pure-ish glue, imports `log`, `isChildSession` (../fallback/subagent), and the T1 functions:
   ```ts
   import { log } from "../log";
   import { isChildSession } from "../fallback/subagent";
   import {
     clearContinuationState,
     continuationUnacked,
     getCompactionState,
     rearmPendingContinuation,
   } from "./state";

   export interface ContinuationFallbackOutcome {
     retry: boolean;
     reason: string;
     model?: string;
   }

   /**
    * T4/T5: a fallback decision retires or re-arms the compaction-continuation
    * pin. Rotation (retry:true) re-arms it while unacked; chain exhaustion stops
    * it; every other outcome is a no-op. Child sessions never re-arm (10a3180).
    */
   export function applyFallbackOutcomeToContinuation(
     sessionID: string,
     decision: ContinuationFallbackOutcome,
   ): void

   /** T7 predicate: any part with synthetic !== true counts as genuine user content. */
   export function hasNonSyntheticUserContent(parts: unknown): boolean
   ```
   `applyFallbackOutcomeToContinuation` body (exact rules):
   - `if (isChildSession(sessionID)) return;`
   - `if (decision.retry)` (covers `"retry"` and `"resubmit-failed"`): `rearmPendingContinuation(sessionID)` → true: `log.info(\`continuation-rearm: re-armed (fallback-rotation${decision.model ? \` -> ${decision.model}\` : ""})\`)`; false: `log.debug("continuation-rearm: rotation without unacked pin; no re-arm")`.
   - `else if (decision.reason === "chain-exhausted" || decision.reason === "no-fallback-models")`: if `continuationUnacked(sessionID) || getCompactionState(sessionID)?.pending_continuation` → `clearContinuationState(sessionID)` + `log.info(\`continuation-rearm: stop (${decision.reason})\`)`.
   - else: nothing.

**Tests** (extend test/fallback.test.ts `describe("dispatchFallback")` neighborhood with a new `describe("fallback dispatch self-abort + in-flight")`):
5. `takeSelfAbort` freshness/read-and-clear: `markSelfAbort("sa-1", 1000)` → `takeSelfAbort("sa-1", 5000)` → `true`; second call → `false`; `markSelfAbort("sa-2", 1000)` → `takeSelfAbort("sa-2", 1000 + 10_001)` → `false` (stale).
6. `dispatchFallback` marks a self-abort on the resubmit path: `clientWith([userMessage])` (existing helper pattern, L645), terminal-quota error → `dispatchFallback(...)` → `takeSelfAbort("sX")` → `true` (abort was called exactly once — also assert `calls.abort === 1`).
7. `isFallbackDispatchInFlight`: unknown session → `false`; during a dispatch whose `session.messages` returns a never-resolving promise (fire `dispatchFallback` without awaiting; poll the flag) → `true`.

**Acceptance:** re-arm glue and predicates are unit-testable without the plugin; fallback gains only the marker + accessor (no policy change — all existing fallback tests stay green).
**QA:** `bun test test/fallback.test.ts test/fallback-events.test.ts`.
**Commit:** C1.

### T3 — Plugin wiring (src/index.ts + plugin-level tests)
**Files:** `src/index.ts`, `test/index.test.ts`.
**Changes (5 hook points):**
1. **Imports:** add `markContinuationSent`, `clearContinuationState` to the `./compaction/state` import (L109-115); add `applyFallbackOutcomeToContinuation`, `hasNonSyntheticUserContent` from `./compaction/rearm`; add `isCleanAssistantCompletion` to `./telemetry/log`; add `isFallbackDispatchInFlight` to the `./fallback` import (or `./fallback/index` — follow the existing `dispatchFallback` import at L50); add `takeSelfAbort` to the `./fallback/state` import (L53).
2. **`logDecision` (L584-608)** — extend signature to `(hook: string, sessionID: string, decision: …)`; FIRST line of body: `applyFallbackOutcomeToContinuation(sessionID, decision);` then the existing logging. Update all 4 call sites to pass the target: L613 (`target`), L639 (`info.sessionID`), L668 (`target`), L687 (`target`).
3. **`session.idle` seam (L440-493)** — after `if (isChildSession(target)) return;` (L472), insert the race guard:
   ```ts
   // No double-fire with fallback's own resubmit: a dispatch in flight means a
   // rotation is being processed right now; do not consume anything, the next
   // idle reconsiders.
   if (isFallbackDispatchInFlight(target)) {
     log.info("continuation: fallback-in-flight; skip");
     return;
   }
   ```
   and in the compaction branch (L476-484) after `log.info(\`compaction-continuation: ${cont.reason}\`)`:
   ```ts
   // The pin is out: track that it now awaits a clean answer (re-arm source).
   if (cont.continued) markContinuationSent(target);
   ```
   The `else if (astrocodeConfig.idleContinuation.enabled)` todo branch is unchanged.
4. **`message.updated` telemetry block (L524-555)** — inside `if (info?.role === "assistant")`, after `captureAssistantUsage`/`recordUsageSpend`, BEFORE the `maybeCompactAtTurnBoundary` call (a compaction armed in the same handler must survive the clear — arm-after-clear ordering):
   ```ts
   // Clean answer: the model accepted the pin (or the resumed task) — retire
   // the continuation intent so no duplicate pin follows on a working session.
   const cleanSid = (info as { sessionID?: unknown })?.sessionID;
   if (
     typeof cleanSid === "string" &&
     isCleanAssistantCompletion(info) &&
     (continuationUnacked(cleanSid) || getCompactionState(cleanSid)?.pending_continuation)
   ) {
     clearContinuationState(cleanSid);
     log.info("continuation-rearm: stop (clean-answer)");
   }
   ```
   (needs `continuationUnacked` in the `./compaction/state` import too).
5. **`chat.message` (L709-755)** — after the force-marker `if/else if` block (ends L755), BEFORE `const state = getSessionModelState(sessionID); if (!state) return;` (L757):
   ```ts
   // T7: a genuine user message is manual intervention — drop the continuation
   // intent entirely. Synthetic-only turns (our pin, the fallback note,
   // subagent results) do not count.
   if (hasNonSyntheticUserContent(output?.parts)) {
     if (continuationUnacked(sessionID) || getCompactionState(sessionID)?.pending_continuation) {
       clearContinuationState(sessionID);
       log.info("continuation-rearm: cleared (user-message)");
     }
   }
   ```
6. **`session.error` abort block (L512-519)** — becomes:
   ```ts
   if (event.type === "session.error") {
     const errName = getErrorName(event.properties?.error);
     if (errName === "MessageAbortedError" || errName === "AbortError") {
       const sid = event.properties?.sessionID;
       if (sid) {
         if (takeSelfAbort(sid)) {
           // Our own fallback-dispatch abort (src/fallback abortSession): not a
           // user cancellation — must not suppress continuation or idle nudge.
           log.debug("continuation-rearm: ignored self-abort (fallback dispatch)");
         } else {
           recordAbort(sid);
           if (continuationUnacked(sid) || getCompactionState(sid)?.pending_continuation) {
             clearContinuationState(sid);
             log.info("continuation-rearm: cleared (abort)");
           }
         }
       }
     }
   }
   ```

**Plugin-level tests** (new `describe("continuation re-arm (fallback rotation)")` in test/index.test.ts) — copy the harness from `describe("astrocode plugin — RetryPart and status.next surfaces")` (L669-848): `clientWith([userMessage])` mock (record `calls.bodies: Record<string, unknown>[]`, one entry per `promptAsync`), `enabledOptions`-style second arg:
```ts
const options = {
  fallback: { enabled: true, models: CHAIN, cooldown_seconds: 0 },  // CHAIN = the 3-model list from L670
  compaction: { continue_after: true },
  idleContinuation: { enabled: true, max: 3 },
};
```
Seed helper per test: `setPendingContinuation(id); consumePendingContinuation(id); markContinuationSent(id);` (= pin sent, unacked). Use unique session ids per test; `beforeEach`: `clearAllSessionModels(); clearFallbackState(); clearChildSessions(); resetCompactionState(); resetIdleContinuationState();`.
Drive failures with `retryPartEvent(sessionID, attempt)` (the terminal FreeUsageLimitError helper at L717) unless noted. Assert pin sends by `calls.bodies[n].parts[0].text` prefix `"[astrocode] Context was compacted"` and pin model by `calls.bodies[n].model` (the pin carries `getLastFallbackModel` — after one rotation that is `{ providerID: "openrouter", modelID: "one/a" }`).

7. **"rotation re-arms; next idle re-pins on the fallback model"** — seed; fire `retryPartEvent("re-1", 1)` → `calls.bodies.length === 1` (fallback resubmit, `parts[0].text` starts with `"[astrocode fallback]"`); fire `session.idle` → `calls.bodies.length === 2`, `bodies[1].parts[0].text` starts with `"[astrocode] Context was compacted"`, `bodies[1].model` = `one/a` parsed.
8. **"clean answer after the rotation stops the loop"** — seed; `retryPartEvent("re-2", 1)`; then `message.updated` assistant `{ sessionID: "re-2", role: "assistant", time: { created: 1, completed: 2 } }` (no error); then `session.idle` → `calls.bodies.length === 1` (no pin); `continuationUnacked("re-2") === false`.
9. **"chain-exhausted stops the loop"** — seed + `recordAttempt("re-3", "openrouter/one/a")` and options `fallback.models: ["openrouter/one/a"]` (1-link chain ⇒ next rotation is impossible); `retryPartEvent("re-3", 1)` → `calls.bodies.length === 0` (no resubmit); `session.idle` → still `0` (no pin); `continuationUnacked("re-3") === false`, `consumePendingContinuation("re-3") === false`.
10. **"genuine user message clears the intent"** — seed; `chat.message` with `output.parts = [{ type: "text", text: "hi" }]` (no `synthetic` key); `session.idle` → `calls.bodies.length === 0`.
11. **"synthetic-only chat.message does not clear"** — seed; `chat.message` with `output.parts = [{ type: "text", synthetic: true, text: "[astrocode fallback] ..." }]`; `session.idle` → `calls.bodies.length === 1` (pin still fires).
12. **"user abort clears the intent"** — seed; `session.error` `{ sessionID, error: { name: "MessageAbortedError" } }` (no dispatch ran ⇒ no self-abort marker); `session.idle` → `calls.bodies.length === 0`.
13. **"self-abort does not eat the re-arm"** — seed; `retryPartEvent("re-6", 1)` (dispatch internally aborts ⇒ `markSelfAbort`); then the abort event it would cause: `session.error` `MessageAbortedError`; then `session.idle` → `calls.bodies.length === 2` (resubmit + pin).
14. **"fallback-in-flight guard: idle mid-dispatch does not consume the pin"** — client mock with `session.messages: () => new Promise(() => {})`; fire the error event WITHOUT awaiting to completion (`const p = hooks.event!(retryPartEvent("re-7", 1));`); immediately `await hooks.event!({ session.idle … })` → `calls.bodies.length === 0`; then `expect(consumePendingContinuation("re-7")).toBe(true)` (flag survived). `await Promise.race([p, new Promise(r => setTimeout(r, 50))])` to settle.
15. **"child session rotation never re-arms"** — `registerChildSession("re-8", "explore")` + seed; `retryPartEvent("re-8", 1)`; `session.idle` → `0` pin calls; `consumePendingContinuation("re-8") === false`.

**Acceptance:** every transition of §1's table is covered end-to-end through the real event hook; existing index.test.ts suites (child guard L612-665, abort window L287-313, chat.message pin L316-412, idle pin-refresh L414-443) unchanged and green.
**QA:** `bun test test/index.test.ts`.
**Commit:** C1.

### T4 — Project config: enable todo-driven idle continuation
**File:** `.opencode/astrocode.jsonc` (L413-418).
**Change:** `"idleContinuation": { "enabled": true, "max": 3 }` and rewrite the 2-line comment above it to: "On by default in this project: todo-driven continuation covers 'model answered cleanly but stopped mid-task'. Plugin default stays false (src/config/astrocode.ts) — opt-in per project to avoid loops. `max` caps sends per session (shared with the post-compaction pin budget); cooldown and failure caps are hardcoded (src/idle/constants.ts)."
**Must NOT:** touch `src/config/astrocode.ts`, `test/config.test.ts`, or add any key.
**Acceptance:** file parses (JSONC), `idleContinuation.enabled === true`; `bun test test/config.test.ts` still green (its default assertion targets the parser, not the project file).
**QA:** `bun test test/config.test.ts && rg -n '"enabled": true, "max": 3' .opencode/astrocode.jsonc`.
**Commit:** C2.

### T5 — Full verification, commits, push, PR
**Steps (exact order):**
1. `bun run typecheck` → 0 errors.
2. `bun test` → full suite green (write output to `/tmp/opencode/buntest-continuation-rearm.out` as evidence).
3. `git status` + `git diff` review — only the 8 files below.
4. Commit C1: `fix(compaction): re-arm the continuation pin across fallback rotations` — files: `src/compaction/state.ts`, `src/compaction/rearm.ts`, `src/telemetry/log.ts`, `src/fallback/state.ts`, `src/fallback/index.ts`, `src/index.ts`, `test/compaction.test.ts`, `test/fallback.test.ts`, `test/index.test.ts`.
5. Commit C2: `chore(config): enable todo-driven idle continuation` — file: `.opencode/astrocode.jsonc`.
6. `git push -u origin fix/continuation-rearm`, then `gh pr create` with a body containing: bug quote, the transition table summary, the stop-condition mapping (a/b/c), and the note "fallback chain length is the cap; no new config keys".
**Acceptance:** PR exists, CI-relevant commands green, commits conventional (`fix(compaction): …` / `chore(config): …`).
**QA:** `bun test` + `bun run typecheck` once more after commits; `git log --oneline -2` shows exactly C1, C2.

---

## 4. File inventory (every touched file)

| File | Action |
|------|--------|
| `src/compaction/state.ts` | extend (flag + 4 functions + snapshot) |
| `src/compaction/rearm.ts` | NEW (glue + T7 predicate) |
| `src/telemetry/log.ts` | extend (export `isCleanAssistantCompletion`) |
| `src/fallback/state.ts` | extend (self-abort marker) |
| `src/fallback/index.ts` | extend (`markSelfAbort` in `abortSession`, `isFallbackDispatchInFlight`) |
| `src/index.ts` | wire 5 hook points (idle guard + ack, logDecision, message.updated clear, chat.message clear, abort clear) |
| `.opencode/astrocode.jsonc` | flip `idleContinuation.enabled` |
| `test/compaction.test.ts`, `test/fallback.test.ts`, `test/index.test.ts` | new describes (15 cases total) |

**Explicitly untouched:** `src/idle/continue.ts`, `src/idle/constants.ts`, `src/compaction/run.ts`, `src/compaction/*` (rest), `src/fallback/config.ts`, `src/fallback/classify.ts`, `src/fallback/session-model.ts`, `src/config/astrocode.ts`, `test/idle.test.ts`, `test/config.test.ts`, everything in `/home/ilja/Documents/astrocode`.

## 5. Must-NOT-Have

- No new config keys of any kind (no re-arm cap, no extra toggles). The fallback chain length + the existing `idleContinuation.max` budget are the only bounds.
- No change to fallback policy: chain resolution, rotation, cooldowns, `pickFallbackModel`, resubmit note text — untouched.
- No change to `maybeContinueIdle` (note texts, backoff, todo-gating, abort window) — the pin path is reused as-is with `reason: "compaction"`.
- No re-arm for child (subagent) sessions (10a3180 stays).
- No spurious pin: `rearmPendingContinuation` without `continuation_unacked` must never arm (a session that never got a pin never sees "[astrocode] Context was compacted…").
- No state persistence across plugin restarts (process-local, like fallback/budget/compaction state).
- No change to the compiled default `idleContinuation.enabled` (stays `false`).
- No "consider/maybe" leftovers in code comments — comments state the decision.

## 6. Acceptance criteria (behavioral matrix)

| Pre-state | Event | Post-state / behavior |
|-----------|-------|----------------------|
| pin sent (unacked) | fallback rotation (`retry` / `resubmit-failed`) | flag re-armed → pin fires at next idle, on `getLastFallbackModel` |
| pin sent (unacked) | clean assistant completion | both flags clear → NO pin at next idle |
| pin sent (unacked) | `chain-exhausted` / `no-fallback-models` | both flags clear → NO pin |
| pin sent (unacked) | genuine user message | both flags clear → NO pin |
| pin sent (unacked) | user abort event | both flags clear → NO pin |
| pin sent (unacked) | our own dispatch abort event | state unchanged → pin still fires |
| no unacked pin | fallback rotation | nothing armed (no spurious note) |
| flag armed | idle while dispatch in flight | pin NOT sent, flag NOT consumed |
| flag armed | idle on a child session | nothing (10a3180) |
| flag armed | idle, clean settle | exactly one pin (existing `compaction-continuation: continued` log) |

End-to-end reproduction of the reported bug: compaction arms → idle pins a dead model → fallback rotates to mimo → **re-arm** → mimo's resubmit either (i) also fails/rotates → the pin keeps re-firing per the table until a clean answer or chain exhaustion, or (ii) answers cleanly but stops mid-task with todos open → `idleContinuation.enabled: true` pushes it. Neither "второго пинка нет" nor double-fire is possible.
