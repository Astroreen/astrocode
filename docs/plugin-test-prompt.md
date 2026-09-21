# astrocode — full plugin test prompt

Copy everything inside the fenced block below into a fresh opencode session **in the astrocode
repo** (or any project with the plugin entry + `astrocode.jsonc`), then let the agent run.
It exercises every shipped feature and prints the exact commands you can use to verify each one.

---

```text
You are testing the astrocode plugin end-to-end. Do NOT change repo code. Work through the
checks below in order, run the verification commands yourself with `bash`, and report a final
PASS/FAIL table with the evidence you observed. Stop and report if a check fails, rather than
guessing.

CONTEXT
- Repo: astrocode (plugin + personas). Config: `.opencode/opencode.jsonc` (plugin entry),
  `.opencode/astrocode.jsonc` (plugin's own settings).
- Main model: anthropic/claude-sonnet-4-6 (meridian proxy). Fallback model:
  openrouter/~deepseek/deepseek-flash-latest.

CHECK 1 — Agent roster + display names (TAB switcher)
Run: `opencode debug config > /tmp/oc.json 2>/tmp/oc.err; grep astrocode /tmp/oc.err`
Verify and report:
- The log line says `injected 11 agents ... default_agent="Sisyphus - ultraworker"`.
- These agent keys exist in `/tmp/oc.json`: "Sisyphus - ultraworker", "Hephaestus - Deep Agent",
  "Prometheus - Plan Builder", "Atlas - Plan Executor", "Sisyphus-Junior",
  "Metis - Plan Consultant", "Momus - Plan Critic", "oracle", "explore", "librarian",
  "multimodal-looker".
- `build` and `plan` are `mode:"subagent"` with `hidden:true`.
- `default_agent` equals "Sisyphus - ultraworker".

CHECK 2 — Per-agent colors
From `/tmp/oc.json`, report each agent's `color` and confirm they are all distinct hex values
(Sisyphus #00CED1, Hephaestus #FF6B35, Prometheus #9B59B6, Atlas #3498DB, Oracle #E74C3C,
Explore #2ECC71, Metis #F1C40F, Momus #E67E22, Multimodal-looker #E91E63).

CHECK 3 — Builtin commands injected
From `/tmp/oc.json` confirm `command` contains: goal, refactor, start-work, stop-continuation,
remove-ai-slops, handoff, hyperplan. Report whether `/start-work` has `agent` = "Atlas - Plan
Executor" and `subtask` = false.

CHECK 4 — Dynamic Sisyphus prompt injection (per family)
Set `ASTROCODE_DUMP=/tmp/astrocode-dump.json`, ask a trivial question (e.g. "reply with OK"),
then run: `tail -n 1 /tmp/astrocode-dump.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['family'], len(d['system']))"`
Report the detected `family` and the number of system segments. Confirm the family matches the
active model. (Claude → "claude".)
Then ask the agent to confirm it is Sisyphus and that its instructions include a "Key Triggers"
section and an "Agent Selection" table generated at runtime.

CHECK 5 — Guards for non-Claude families
`ASTROCODE_DUMP` stays on. Switch the session model to `openrouter/~deepseek/deepseek-flash-latest`,
send "reply with OK", and check the newest dump line's `family` is "openrouter-generic" and that
the system array now contains the anti-tool-loop guard text (`<tool_loop_guard>`) and the
`apply_patch` guidance. Report both.

CHECK 6 — Delegation + per-agent model (subagent)
Ask: "Delegate a read-only task to explore: list the files in src/agents and report their names."
Verify the agent uses `task(subagent_type="explore", ...)` (synchronous), and reports real file
names. Then run `opencode debug config` and confirm the `explore` agent exists and, if it has no
`model`, note that it inherits the primary model (expected).

CHECK 7 — Per-agent model override
Confirm from `/tmp/oc.json` that "Sisyphus - ultraworker", "Prometheus - Plan Builder" and
"Atlas - Plan Executor" each have `model: "anthropic/claude-sonnet-4-6"`.

CHECK 8 — Fallback config parsing
Run: `bun test test/config.test.ts test/fallback.test.ts` and report pass/fail counts.

CHECK 9 — Fallback classifier (unit)
In the same test run, confirm the classifier suite covers rate-limit, 5xx, Chinese quota wording,
Claude Code "session limit" wrapped in MessageAbortedError, and model-not-found. Report the
relevant test names that passed.

CHECK 10 — LIVE fallback (opt-in, manual)
To force a real fallback, temporarily set the Sisyphus model in `.opencode/astrocode.jsonc` to a
nonexistent model, e.g. `"model": "openrouter/definitely-not-a-real-model"`, restart opencode,
send any prompt, and watch stderr for a line like:
`[astrocode] fallback(message.updated): retry -> openrouter/~deepseek/deepseek-flash-latest`
The session should continue on deepseek flash instead of erroring out. Revert the model
afterwards. Report the exact log line you saw (or state it was not run).

CHECK 11 — Dynamic prompt re-injection after a fallback switch
If CHECK 10 ran, confirm the new dump line's `family` differs from before the switch
(e.g. "claude" → "openrouter-generic") — i.e. the Sisyphus prompt is rebuilt for the fallback
model rather than reusing the old family's text.

CHECK 12 — Commands are real
Run: `/goal test the plugin`, then `/stop-continuation`, then report what each command did and
that neither errored.

CHECK 13 — Unit + typecheck
Run: `bun test` and `bun run tsc --noEmit`. Report pass count and that tsc emits nothing.

FINAL OUTPUT
Produce a table: CHECK | WHAT WAS VERIFIED | RESULT (PASS/FAIL/SKIPPED) | EVIDENCE.
End with an overall verdict and any check you could not run and why.
```

---

## Notes for the human

- **Checks 1–9, 12, 13** need no special setup and are safe to run anytime.
- **Checks 10–11** intentionally break the primary model for a moment; revert
  `.opencode/astrocode.jsonc` afterwards.
- Fallback logs go to the opencode stderr stream, not into the chat. In a TUI you may need to
  launch opencode from a terminal to see them.
- `ASTROCODE_DUMP` writes one JSON line per system-transform call to the given path; unset it
  when done.
