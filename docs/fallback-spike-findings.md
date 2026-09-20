# SPIKE — Model-Fallback Feasibility (Task 11)

> **SUPERSEDED (2026-09): the "not possible" conclusion below is WRONG.** The plugin *can*
> implement real mid-task failover. The mechanism actually used (see `docs/porting-plan.md`
> § "Fallback module design" and the shipped `src/fallback/` module): the `event` hook fires on
> `session.error`, a retryable error is classified, and `client.session.prompt(...)` resubmits
> the last user turn on the **same session** with a different model — opencode preserves the
> full conversation history server-side, so work continues instead of restarting. The
> OpenRouter `options.models` passthrough hack described later in this file was never needed.
> Read the rest of this document as historical investigation only.

> Scope: this document investigates **model-availability failover** — what happens (or could
> happen) when a specific model/provider is down, rate-limited, or refuses a request, and
> whether astrocode's plugin can automatically retry with a different model.
>
> **This is a different concept from AD-3's "fallback" family** (the defensive-prompting
> classification applied to unrecognized models in `resolveFamily.ts` / `guards.ts`). The two
> share a word only. Nothing in `src/models/resolveFamily.ts` or `src/prompts/guards.ts` is
> touched or reinterpreted by this SPIKE.

## 1. Hooks surface re-verified

Re-read the full `Hooks` interface from
`~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (2026-09-19). Complete
enumeration and relevance to model-fallback:

| Hook | Fires | Exposes settable `model`? | Relevant? |
|---|---|---|---|
| `event` | after various runtime events | no | no |
| `config` | plugin load time (static) | no | no |
| `tool` / `tool.definition` | tool registration/definition | no | no |
| `auth` | provider auth flow | no | no |
| `chat.message` | on new message | no (model is read-only input) | no |
| `chat.params` | before dispatch | no — output is `{temperature, topP, topK, options}` only | partial (see §3) |
| `chat.headers` | before dispatch | no — output is `{headers}` only | no |
| `permission.ask` | permission prompt | no | no |
| `command.execute.before` / `tool.execute.before` / `tool.execute.after` / `shell.env` | tool-call lifecycle | no | no |
| `experimental.chat.messages.transform` | before dispatch | no — output is `{messages}` | no |
| `experimental.chat.system.transform` | before dispatch | no — output is `{system}` | no |
| `experimental.session.compacting` | compaction | no | no |
| `experimental.text.complete` | inline completion | no | no |

**Finding**: no hook in this surface fires *after* a model call errors/fails, and no hook
exposes `model` as a **settable** output field anywhere — every hook that receives `model`
receives it only as a fixed input. There is no `onError`, `chat.error`, `chat.retry`, or
similarly-shaped hook.

**Conclusion**: a genuine plugin-hook-based "detect model X failed, resubmit to model Y"
mechanism is **not possible** via the public `@opencode-ai/plugin` API. This is exhaustive
(every hook was enumerated), not a gap in available information.

## 2. Official config schema re-confirmed

Fetched fresh this session: `curl -sL https://opencode.ai/config.json` → HTTP 200, 39039
bytes (2026-09-19T10:5xZ). `grep -iE "fallback|retry|onError|on_error"` on the raw schema →
**0 matches**. Re-confirms opencode core exposes no native `fallback`/`fallback_models`/retry
concept in `Config`.

## 3. New discovery — untyped `options` passthrough fields

Walking the schema's `$defs`, two **untyped** (`{"type": "object"}`) passthrough bags exist
natively, requiring no plugin:

- `$defs.ProviderConfig.properties.models.<modelID>.properties.options`
- `$defs.AgentConfig.properties.options`

By contrast, `$defs.ProviderConfig.properties.options` (provider-level, not per-model) IS
strongly typed (`apiKey`, `baseURL`, `enterpriseUrl`, `setCacheKey`, `timeout`,
`headerTimeout`, ...). The per-model and per-agent `options` fields being bare untyped objects
suggests (**UNVERIFIED** — opencode core is a closed-source Go binary, no source access to
confirm) that they are passthrough bags merged into the underlying AI-SDK provider call.

**Hypothesis (unverified)**: if opencode forwards a model's/agent's `options` object verbatim
into the OpenRouter provider request body, a user could set
`options: { models: [...] }` on an OpenRouter model/agent entry in `opencode.jsonc` to activate
OpenRouter's own native model-array fallback (§5) — with **zero plugin code**. This is the most
promising lever found in this SPIKE, but it is not empirically confirmed here (would require a
live session + request capture, e.g. via `ASTROCODE_DUMP` or an HTTP proxy, which is out of
scope for this docs-only SPIKE — recommended as a fast follow-up, e.g. during Task 8's
integration QA).

`chat.params`'s `output.options: Record<string, any>` (per-request, not persistent config) is
the same shape of passthrough bag and carries the same unverified hypothesis, but scoped to a
single hook invocation rather than static config.

## 4. OMO's own `model_fallback` / `fallback_models` / `runtime_fallback` (reference only)

`~/.cache/opencode/node_modules/oh-my-openagent/dist/oh-my-opencode.schema.json` defines (NOT
copied into astrocode — reference for shape only, per Must-NOT):

- `model_fallback: boolean` — global toggle (line 96)
- `fallback_models` — per-agent, `anyOf[string, string[], [{model, reasoning}]]` (line 108,
  repeated per agent block at lines 571, 1034, 1497, 1963, 2426, 2889, 3352, 3815, 4278, 4741,
  5204, 5667, 6130, 6594, 7155)
- `runtime_fallback` — object (lines 7828–7866): `enabled: boolean`,
  `retry_on_errors: number[]`, `max_fallback_attempts: number (1-20)`, `cooldown_seconds:
  number`, `timeout_seconds: number`, `notify_on_fallback: boolean`,
  `restore_primary_after_cooldown: boolean`

**Conclusion**: since §1 proves the public plugin `Hooks` surface has no error/retry hook, OMO's
`runtime_fallback` retry semantics **cannot** be implemented through the public plugin API
alone — OMO must implement this inside its own custom agent-orchestration runtime, i.e. OMO
wraps/replaces more of the request lifecycle than a thin plugin can reach. This is exactly the
kind of heavy custom machinery (~5500 LOC class) this project's Must-NOT explicitly excludes
reimplementing. **A thin astrocode-style plugin structurally cannot replicate OMO's automatic
runtime retry-on-error behavior.**

## 5. OpenRouter's own native model-fallback (provider-level, no opencode involvement)

Fetched fresh: `https://openrouter.ai/docs/guides/routing/model-fallbacks` (HTTP 200,
2026-09-19). Confirmed:

- The `models` request-body parameter lets OpenRouter itself automatically try other models "if
  the primary model's providers are down, rate-limited, or refuse to reply due to content
  moderation."
- Example (from the docs):
  ```json
  {
    "model": "anthropic/claude-sonnet-latest",
    "models": ["deepseek/deepseek-chat", "z-ai/glm-4.6"]
  }
  ```
- A distinct `fallback`/`fallbacks` field also exists: cannot be combined with `models` (400
  error if both are sent); `fallbacks` accepts at most 3 entries.
- "To use the `models` array with the OpenAI SDK, include it in the `extra_body` parameter" —
  confirms this is a **provider-level / request-body** mechanism, entirely independent of any
  opencode plugin hook gap identified in §1.

## 6. Verdict: **PARTIAL**

- **NO** — a plugin-hook-based retry/interception mechanism (catch a failed model call, resubmit
  to a different model) is not feasible. The `Hooks` surface was enumerated exhaustively (§1)
  and contains no error/retry hook, nor any hook exposing a settable `model` field.
- **PARTIAL / promising-but-unverified** — native (non-experimental, no-plugin-required)
  `ProviderConfig.models.<id>.options` / `AgentConfig.options` passthrough fields exist in the
  official schema (§3) and could plausibly carry OpenRouter's own `models: [...]` fallback array
  (§5) straight through to the request — but this passthrough behavior is unverified against
  opencode's closed-source core in this docs-only SPIKE.

## 7. `getFallbackModel(family): string` — contract (documented, NOT implemented)

Per Acceptance Criteria for a YES/PARTIAL verdict, and per this task's Must-NOT (SPIKE is
investigation + documentation only — no implementation in `src/`):

```ts
/**
 * Returns the OpenRouter model ID (or "" if none configured) to retry with if the
 * primary model for `family` becomes unavailable (rate-limited / down / moderation-refused).
 *
 * NOT wired into src/index.ts by this SPIKE — design-only, for reference if the
 * options-passthrough hypothesis in §3 is later disproven empirically.
 *
 * If ever implemented, note it CANNOT be invoked from the current Hooks surface (per §1) —
 * there is no post-failure retry point available to a plugin. It would require wrapping the
 * request at the call site outside opencode's plugin API, which is out of this project's scope.
 */
declare function getFallbackModel(family: "claude" | "cheap-openrouter" | "fallback"): string;
```

## 8. Recommendation (practical — for README, Task 9)

**Primary recommendation**: configure OpenRouter-level fallback directly in
`opencode.jsonc`, no plugin code required (relies on the §3 passthrough hypothesis):

```jsonc
{
  "provider": {
    "openrouter": {
      "models": {
        "deepseek/deepseek-chat": {
          "options": {
            "models": ["z-ai/glm-4.6", "qwen/qwen-2.5-72b-instruct"]
          }
        }
      }
    }
  }
}
```

**Caveat**: this depends on opencode forwarding the model-level `options` object verbatim into
the OpenRouter provider request body — **unverified** in this SPIKE (no source access to the
closed-source Go core; docs-only investigation). Recommend the user empirically confirm this
(e.g. with `ASTROCODE_DUMP` and/or an HTTP-level capture) before depending on it in production.

**If passthrough does not work**: the only remaining lever is manually rotating the `model:`
string per-agent in `opencode.jsonc` when a provider is degraded — there is no automatic
runtime fallback achievable without changes to opencode core itself.

## 9. Evidence

- `~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` — full `Hooks` interface
  re-read 2026-09-19 (§1)
- `/tmp/opencode-config.json` — `https://opencode.ai/config.json` fetched fresh, HTTP 200, 39039
  bytes, 2026-09-19; 0 matches for `fallback|retry|onError` (§2); `$defs` walk found
  `ProviderConfig.models.<id>.options` / `AgentConfig.options` as untyped passthrough (§3)
- `~/.cache/opencode/node_modules/oh-my-openagent/dist/oh-my-opencode.schema.json` — lines 96
  (`model_fallback`), 108 + repeats (`fallback_models`), 7828–7866 (`runtime_fallback`) (§4)
- `https://openrouter.ai/docs/guides/routing/model-fallbacks` — fetched fresh, HTTP 200,
  2026-09-19 (§5)

## 10. Guardrail compliance

- No fallback retry logic implemented in `src/index.ts` or `src/models/resolveFamily.ts` — this
  SPIKE is documentation-only, per Must-NOT.
- `grep -riE "getFallbackModel|fallback_models|model_fallback" src/` → 0 matches (verified below).
