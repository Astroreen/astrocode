// Builtin commands ported from oh-my-openagent (docs/porting-plan.md decision #2).
//
// Ported to astrocode's REAL tool surface (decision #5):
//   - `call_omo_agent(...)` / `task(category=, load_skills=, run_in_background=)` →
//     `task(subagent_type=, description=, prompt=)` (synchronous, no background params)
//   - `background_output` / `background_cancel` → removed (delegation is synchronous)
//   - `TodoWrite` → `todowrite`
//   - `Task(subagent_type="plan")` → `task(subagent_type="prometheus")` (astrocode's planner)
//   - LSP names → real lower_snake tools (`lsp_goto_definition`, `lsp_find_references`,
//     `lsp_symbols`, `lsp_diagnostics`)
//   - `lsp_prepare_rename` / `lsp_rename` → not available; use `lsp_find_references` + `edit`
//   - `$SESSION_ID` / `$TIMESTAMP` → not supported by opencode commands; dropped
//   - team-mode / Codex-harness sections → preserved as HTML comments (never deleted)
//
// Injected via the plugin's `config` hook, exactly like oh-my-openagent's own
// `loadBuiltinCommands` (which spread definitions into the opencode config).

export interface BuiltinCommandDefinition {
  template: string;
  description?: string;
  agent?: string;
  subtask?: boolean;
}

const HEADER = `<!--` + ` astrocode builtin command (ported from oh-my-openagent)` + ` -->`;

export const GOAL_TEMPLATE = `${HEADER}
You are setting a session Goal — a persistent objective pursued until paused, cleared, or completed.

## How Goal Works In astrocode

1. The goal stays active for this session.
2. Track progress with the \`todowrite\` tool: decompose the objective into explicit todos and keep them current at every turn.
3. Clear the goal only after a completion audit confirms the objective is met.
4. pause / resume / clear are handled by re-running this command with an argument.

<!-- astrocode: oh-my-openagent's automatic idle-continuation hook is NOT implemented here.
     The original relied on the harness injecting a continuation prompt whenever the session
     went idle, plus an update_goal({ status: "complete" }) tool to self-complete. astrocode
     has neither, so the goal is pursued within the normal turn flow and tracked via todos.
     If idle-continuation is ever added, restore:
       - auto-injected continuation prompt on idle
       - update_goal({ status: "complete" }) self-completion
-->

## Rules

- Focus on completing the objective fully, not partially.
- Each turn should make meaningful progress toward the goal.
- If stuck, try materially different approaches; after 3 consecutive failures stop, revert, document, and consult the \`oracle\` agent.
- Keep todos updated in real time.

## Commands

- /goal <objective>  - Set or replace the active goal
- /goal              - Show the current goal
- /goal pause        - Pause the active goal
- /goal resume       - Resume a paused goal
- /goal clear        - Clear the current goal

## Your Task

Parse the arguments below. The format is \`<objective>\` or one of: pause, resume, clear.`;

export const STOP_CONTINUATION_TEMPLATE = `${HEADER}
Stop all continuation mechanisms for the current session.

<!-- astrocode: none of the original continuation mechanisms exist here, so this command is a
     deliberate no-op kept for compatibility. The original stopped:
       1. todo-continuation-enforcer (auto-continue incomplete tasks when idle)
       2. Ralph Loop
       3. session Goal auto-continuation
       4. project boulder state
     If any of these are ever implemented, wire this command to actually halt them.
-->

## Current behavior

astrocode does not auto-continue a session when it goes idle, so there is nothing to stop.
Manual control is already the default: work proceeds only while you keep prompting.

Use this command to explicitly confirm that no automated continuation is active.`;

export const HANDOFF_TEMPLATE = `${HEADER}
# Handoff Command

## Purpose

Use /handoff when:
- The current session context is getting too long and quality is degrading
- You want to start fresh while preserving essential context from this session
- The context window is approaching capacity

This creates a detailed context summary that can be used to continue work in a new session.

---

# PHASE 0: VALIDATE REQUEST

Before proceeding, confirm:
- [ ] There is meaningful work or context in this session to preserve
- [ ] The user wants a handoff summary (not just asking about it)

If the session is nearly empty or has no meaningful context, say so and stop.

---

# PHASE 0.5: SOURCE OF TRUTH (MANDATORY FIRST STEP)

The conversation history is the only authoritative record of what the user originally asked.
Do NOT reconstruct the first request from memory — long sessions truncate or summarize early
messages, so memory is unreliable.

Rules:
- Quote the user's requests verbatim from the conversation; do not paraphrase or "tidy up".
- Do not skip this step even if you feel you remember the first request.
- If the original request is not visible in the remaining context, state that explicitly in the
  USER REQUESTS (AS-IS) section rather than guessing.

---

# PHASE 1: GATHER PROGRAMMATIC CONTEXT

Use real tools to gather concrete data:

1. \`todoread()\` - current task progress
2. \`bash\` with \`git diff --stat HEAD~10..HEAD\` - recent file changes
3. \`bash\` with \`git status --porcelain\` - uncommitted changes

Analyze the outputs to understand:
- What work was completed
- What tasks remain (include todo state)
- What decisions were made
- What files were modified (include git diff/stat + status)
- What patterns, constraints, or preferences were established

---

# PHASE 2: EXTRACT CONTEXT

Write the summary from first person ("I did...", "I told you...").

Focus on:
- Capabilities and behavior, not file-by-file implementation details
- What matters for continuing the work
- Avoiding excessive implementation detail (variable names, storage keys, constants) unless critical
- USER REQUESTS (AS-IS) must be verbatim (do not paraphrase, do not invent)
- EXPLICIT CONSTRAINTS must be verbatim only

---

# PHASE 3: FORMAT OUTPUT

Generate a handoff summary using this exact format:

\`\`\`
HANDOFF CONTEXT
===============

USER REQUESTS (AS-IS)
---------------------
- [Exact verbatim user requests - NOT paraphrased]

GOAL
----
[One sentence describing what should be done next]

WORK COMPLETED
--------------
- [First person bullets of what was done]
- [Include specific file paths when relevant]
- [Note key implementation decisions]

CURRENT STATE
-------------
- [Current state of the codebase or task]
- [Build/test status if applicable]
- [Any environment or configuration state]

PENDING TASKS
-------------
- [Tasks planned but not completed]
- [Next logical steps]
- [Blockers or issues encountered]
- [Current todo state from todoread()]

KEY FILES
---------
- [path/to/file] - [brief role description]
(Maximum 10 files, prioritized by importance)

IMPORTANT DECISIONS
-------------------
- [Technical decisions and why]
- [Trade-offs considered]
- [Patterns or conventions established]

EXPLICIT CONSTRAINTS
--------------------
- [Verbatim constraints only - from user or AGENTS.md]
- If none, write: None

CONTEXT FOR CONTINUATION
------------------------
- [What the next session needs to know]
- [Warnings or gotchas]
- [References to documentation if relevant]
\`\`\`

Rules for the summary:
- Plain text with bullets
- No markdown \`#\` headers (use the dash format above)
- No bold, italic, or code fences within content
- Use workspace-relative paths
- USER REQUESTS (AS-IS) and EXPLICIT CONSTRAINTS must be verbatim only

---

# PHASE 4: PROVIDE INSTRUCTIONS

After generating the summary, instruct the user:

\`\`\`
---

TO CONTINUE IN A NEW SESSION:

1. Start a new session in opencode
2. Paste the HANDOFF CONTEXT above as your first message
3. Add your request: "Continue from the handoff context above. [Your next task]"
\`\`\`

---

# IMPORTANT CONSTRAINTS

- DO NOT attempt to programmatically create sessions (no such tool for agents)
- DO provide a self-contained summary that works without this session
- DO include workspace-relative file paths
- DO NOT include secrets (API keys, credentials)
- DO NOT exceed 10 files in KEY FILES
- DO keep GOAL to a single sentence or short paragraph

# EXECUTE NOW

Begin by gathering programmatic context, then synthesize the handoff summary.`;

export const START_WORK_TEMPLATE = `${HEADER}
You are starting an Atlas work session.

## ARGUMENTS

- \`/start-work [plan-name]\`
  - \`plan-name\` (optional): name or partial match of the plan to start

## WHAT TO DO

1. **Find available plans**: search for Prometheus-generated plan files under \`.sisyphus/plans/\`.

2. **Decision logic**:
   - If the user named a plan: match it (exact or partial).
   - If exactly one plan exists: auto-select it.
   - If multiple plans exist: list them with timestamps and ask the user to select.
   - If none exist: tell the user to run \`/prometheus\` (planning) first.

3. **Read the FULL plan file** before delegating any tasks.

4. **Set the goal + register todos (MANDATORY)**, immediately after reading the plan,
   BEFORE starting any work. Skipping either is a defect.
   - Set the session goal: plan name and path, concrete end state, phase/task counts, and how
     completion is verified.
   - Decompose every plan task into granular, implementation-level todos and register ALL of
     them with \`todowrite\`, grouped phase by phase. Keep them current: mark in_progress when
     work dispatches and completed immediately after its verification passes — never
     batch-complete, never run unregistered work.

   How to break down:
   - Each plan checkbox item must split into concrete sub-tasks.
   - Each sub-task must name: file to modify, what to change, expected behavior, how to verify.
   - "implement feature X" is NOT acceptable; "add validateToken() to src/auth/middleware.ts that
     checks JWT expiry and returns 401" IS.

<!-- astrocode: oh-my-openagent's session/boulder/worktree/PR machinery is NOT implemented.
     The original additionally required:
       - reading and updating .omo/boulder.json (active_plan, session_ids, worktree_path)
       - --worktree <path> setup via git worktree add
       - --make-pr / --ship delivery modes (push branch, open PR, merge gates)
       - .omo/ ledger + goal tooling (create_goal)
     astrocode tracks the active plan via todos and the normal git flow instead. If worktree
     or PR delivery modes are ever added, restore those sections here.
-->

## CRITICAL

- Read the FULL plan file before delegating any tasks.
- Follow atlas orchestration: delegate work with \`task(...)\`, verify every delegated result,
  never implement code yourself when a specialist fits.
- If a task needs a skill, name it in the delegation prompt's CONTEXT so the subagent loads it
  with its own \`skill\` tool call.

## EXECUTE NOW

Locate the plan, register the goal + todos, then begin executing task by task.`;

export const REFACTOR_TEMPLATE = `${HEADER}
# Intelligent Refactor Command

## Usage

\`\`\`
/refactor <refactoring-target> [--scope=<file|module|project>] [--strategy=<safe|aggressive>]

Arguments:
  refactoring-target: What to refactor. Can be:
    - File path: src/auth/handler.ts
    - Symbol name: "AuthService class"
    - Pattern: "all functions using deprecated API"
    - Description: "extract validation logic into separate module"

Options:
  --scope: Refactoring scope (default: module)
    - file: Single file only
    - module: Module/directory scope
    - project: Entire codebase

  --strategy: Risk tolerance (default: safe)
    - safe: Conservative, maximum test coverage required
    - aggressive: Allow broader changes with adequate coverage
\`\`\`

## What This Command Does

Performs intelligent, deterministic refactoring with full codebase awareness:
1. Understands your intent
2. Maps the codebase before touching anything
3. Assesses risk and determines a verification strategy
4. Plans meticulously (Prometheus)
5. Executes precisely with LSP and AST-grep
6. Verifies constantly

<!-- astrocode: the original shipped a Codex-harness compatibility table translating
     call_omo_agent/task/background_output/team_* into Codex multi_agent_v1.* tools. astrocode
     targets opencode only, so that table is not needed. If a Codex target is ever added,
     restore it here.
-->

---

# PHASE 0: INTENT GATE (MANDATORY FIRST STEP)

**BEFORE ANY ACTION, classify and validate the request.**

## Step 0.1: Parse Request Type

| Signal | Classification | Action |
|--------|----------------|--------|
| Specific file/symbol | Explicit | Proceed to codebase analysis |
| "Refactor X to Y" | Clear transformation | Proceed to codebase analysis |
| "Improve", "Clean up" | Open-ended | **MUST ask**: "What specific improvement?" |
| Ambiguous scope | Uncertain | **MUST ask**: "Which modules/files?" |
| Missing context | Incomplete | **MUST ask**: "What's the desired outcome?" |

## Step 0.2: Validate Understanding

- [ ] Target is clearly identified
- [ ] Desired outcome is understood
- [ ] Scope is defined (file/module/project)
- [ ] Success criteria can be articulated

If ANY of the above is unclear, ASK using the clarification protocol below:

\`\`\`
I want to make sure I understand the refactoring goal correctly.

**What I understood**: [interpretation]
**What I'm unsure about**: [specific ambiguity]

Options I see:
1. [Option A] - [implications]
2. [Option B] - [implications]

**My recommendation**: [suggestion with reasoning]

Should I proceed with [recommendation], or would you prefer differently?
\`\`\`

## Step 0.3: Create Initial Todos

IMMEDIATELY after understanding the request, register phase todos with \`todowrite\`:
PHASE 1 codebase analysis, PHASE 2 codemap, PHASE 3 test assessment, PHASE 4 plan,
PHASE 5 execution, PHASE 6 final verification.

---

# PHASE 1: CODEBASE ANALYSIS

Mark phase-1 in_progress. Fire parallel investigation via \`task(...)\` (synchronous; issue the
independent calls together in one message):

\`\`\`
task(subagent_type="explore", description="Find refactor target", prompt="Find all occurrences
and definitions of [TARGET]. Report file paths, line numbers, usage patterns.")

task(subagent_type="explore", description="Find dependencies", prompt="Find all code that
imports, uses, or depends on [TARGET]. Report dependency chains and import graphs.")

task(subagent_type="explore", description="Find conventions", prompt="Find similar code patterns
to [TARGET]. Report analogous implementations and established conventions.")

task(subagent_type="explore", description="Find tests", prompt="Find all test files related to
[TARGET]. Report test file paths, case names, coverage indicators.")

task(subagent_type="explore", description="Find architecture", prompt="Find architectural
patterns and module organization around [TARGET]. Report module boundaries and design patterns.")
\`\`\`

Use direct tools for precision:
- \`lsp_goto_definition\` - where is it defined
- \`lsp_find_references\` - all usages across the workspace
- \`lsp_symbols\` - file/workspace outline and symbol search
- \`lsp_diagnostics\` - current errors/warnings before you start
- \`grep\` / \`glob\` - text and file discovery
- the \`ast-grep\` skill (load it via the \`skill\` tool) for structural patterns

Mark phase-1 completed after results are collected.

---

# PHASE 2: BUILD CODEMAP

Mark phase-2 in_progress. Construct, based on Phase 1:

\`\`\`
## CODEMAP: [TARGET]

### Core Files (Direct Impact)
- path/to/file.ts:L10-L50 - Primary definition
- path/to/file2.ts:L25 - Key usage

### Dependency Graph
[TARGET]
- imports from: module-a (types), module-b (utils)
- imported by: consumer-1.ts, consumer-2.ts, consumer-3.ts
- used by: handler.ts (direct call), service.ts (dependency injection)

### Impact Zones
| Zone | Risk Level | Files Affected | Test Coverage |
|------|------------|----------------|---------------|
| Core | HIGH | 3 files | 85% |
| Consumers | MEDIUM | 8 files | 70% |
| Edge | LOW | 2 files | 50% |

### Established Patterns
- Pattern A: [description] - used in N places
- Pattern B: [description] - established convention
\`\`\`

Identify constraints: MUST follow existing patterns, MUST NOT break critical dependencies,
safe-to-change zones, changes requiring migration. Mark phase-2 completed.

---

# PHASE 3: TEST ASSESSMENT

Mark phase-3 in_progress.

Detect test infrastructure (\`bash\`): inspect package.json scripts, pytest/pyproject, go tests.
Analyze coverage for the target via \`task(subagent_type="explore", prompt="Analyze test coverage
for [TARGET]: which test files cover it, what cases exist, integration tests, edge cases,
estimated coverage %") - use it synchronously.

| Coverage | Strategy |
|----------|----------|
| HIGH (>80%) | Run existing tests after each step |
| MEDIUM (50-80%) | Run tests + add safety assertions |
| LOW (<50%) | **PAUSE**: propose adding tests first |
| NONE | **BLOCK**: refuse aggressive refactoring |

If coverage is LOW/NONE, ask the user which approach they prefer (add tests first / proceed with
caution / abort).

Document a verification plan: test command, type check, lsp_diagnostics checkpoints after each
step, and explicit regression indicators. Mark phase-3 completed.

---

# PHASE 4: PLAN GENERATION

Mark phase-4 in_progress. Delegate to astrocode's planner:

\`\`\`
task(subagent_type="prometheus", description="Refactor plan", prompt="Create a detailed
refactoring plan.

## Refactoring Goal
[User's original request]

## Codemap (from Phase 2)
[Insert codemap]

## Test Coverage (from Phase 3)
[Insert verification plan]

## Constraints
- MUST follow existing patterns: [list]
- MUST NOT break: [critical paths]
- MUST run tests after each step

## Requirements
1. Break down into atomic refactoring steps
2. Each step independently verifiable
3. Order steps by dependency
4. Specify exact files and line ranges per step
5. Include a rollback strategy per step
6. Define commit checkpoints")
\`\`\`

Review and validate the plan (completeness, safety, order, verification), then register each step
as granular todos. Mark phase-4 completed.

---

# PHASE 5: EXECUTE REFACTORING

Mark phase-5 in_progress.

For EACH step:
- Pre-step: mark todo in_progress, read the current file state, confirm lsp_diagnostics baseline.
- Execute:
  - Symbol renames: use \`lsp_find_references\` to enumerate every usage, then apply precise
    \`edit\` changes (there is no LSP rename tool available).
  - Pattern transformations: preview with the \`ast-grep\` skill before applying.
  - Structural changes: use \`edit\` with exact surrounding context.
- Post-step (MANDATORY): \`lsp_diagnostics\` on changed files (clean or same as baseline), run the
  test command, run the type check.
- Completion: verification passes -> mark todo completed; fails -> STOP AND FIX.

Failure recovery: STOP, REVERT the failed change, DIAGNOSE, then either fix and retry, skip if
optional, consult \`oracle\`, or ask the user. NEVER proceed with broken tests.

Commit checkpoints after each logical group of changes.

---

# PHASE 6: FINAL VERIFICATION

Mark phase-6 in_progress.

- Full test suite
- Full type check
- Lint
- Build (if applicable)
- \`lsp_diagnostics\` on every changed file

Generate a summary: what changed, files modified, verification results (tests/type/lint/build),
and a no-regressions statement. Mark phase-6 completed.

---

# CRITICAL RULES

## NEVER DO
- Skip lsp_diagnostics after changes
- Proceed with failing tests
- Make changes without understanding impact
- Use \`as any\`, \`@ts-ignore\`, \`@ts-expect-error\`
- Delete tests to make them pass
- Commit broken code
- Refactor without understanding existing patterns

## ALWAYS DO
- Understand before changing
- Preview structural rewrites before applying
- Verify after every change
- Follow existing codebase patterns
- Keep todos updated in real time
- Commit at logical checkpoints
- Report issues immediately

## ABORT CONDITIONS
Stop and consult the user if: test coverage is zero for the target, changes would break a public
API, scope is unclear, 3 consecutive verification failures occur, or user constraints are violated.

---

# Tool Usage Philosophy

## LSP Tools
- \`lsp_goto_definition\` to grasp context
- \`lsp_find_references\` for impact analysis before modifying
- \`lsp_symbols\` for outlines and symbol search
- \`lsp_diagnostics\` continuously after changes

## AST-Grep
Use the \`ast-grep\` skill helper (or the \`sg\` CLI) for structural transformations.
Always preview first, review, then execute.

## Agents
- \`explore\`: codebase pattern discovery
- \`prometheus\`: detailed refactoring plan generation
- \`oracle\`: read-only consultation for complex architectural decisions and debugging
- \`librarian\`: use proactively for deprecated methods or library migration; query official docs
  and OSS examples for modern replacements

## Deprecated Code & Library Migration
1. Fire \`librarian\` to find the recommended modern alternative
2. DO NOT auto-upgrade to the latest version unless the user explicitly requests migration
3. If migration is requested, fetch latest API docs via \`librarian\` before changing code

---

**Remember: Refactoring without tests is reckless. Refactoring without understanding is destructive.**

<user-request>
$ARGUMENTS
</user-request>`;

export const REMOVE_AI_SLOPS_TEMPLATE = `${HEADER}
# Remove AI Slops Command

## What this command does
Analyzes all files changed in the current branch (compared to the parent), removes AI-generated
code smells, then critically reviews the changes to ensure safety and behavior preservation.
Fixes any issues found during review.

<!-- astrocode: the original shipped a Codex-harness tool-compatibility table (call_omo_agent /
     task / background_output / team_* -> Codex multi_agent_v1.*). astrocode targets opencode
     only; restore that table here if a Codex target is ever added.
-->

## Step 0: Task Planning

Use \`todowrite\` to create the task list:
1. Get changed files from the branch
2. Remove AI slops on each file
3. Critically review all changes
4. Fix any issues found

## Role Definition
You are a senior code quality engineer specialized in identifying and removing AI-generated code
patterns while preserving original functionality. Deep expertise in code review, refactoring
safety, and behavioral preservation.

## Process

### Phase 1: Identify Changed Files
Detect the repository base branch dynamically, then list changed files:

\`\`\`bash
BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
git diff $(git merge-base "$BASE_BRANCH" HEAD)..HEAD --name-only
\`\`\`

If the symbolic-ref lookup is unavailable, detect the base branch from the repo's configured
remote default; only fall back to \`main\` as a last resort.

### Phase 2: AI Slop Removal
If a \`remove-ai-slops\` skill is installed, load it once via the \`skill\` tool and apply its
detection criteria. Otherwise apply the criteria defined by this command directly.

For each changed file, delegate the removal with the real task tool, naming the skill in the
prompt's CONTEXT so the subagent loads it itself:

\`\`\`
task(subagent_type="hephaestus", description="Remove AI slops from {filename}", prompt="CONTEXT:
load the remove-ai-slops skill via the skill tool before starting. GOAL: remove AI-generated
slops from this file while preserving behavior. FILE: {file_path}")
\`\`\`

Issue the per-file calls together in one message to run them concurrently.

Before each pass, save a file-specific rollback artifact capturing only the delta of the
slop-removal pass (e.g. generate a per-file patch and reverse-apply on failure). Do NOT use
\`git checkout -- {file_path}\` — that would discard pre-existing branch changes.

### Phase 3: Critical Review
After the removal passes, review with this checklist:

**Safety Verification**
- [ ] No functional logic accidentally removed
- [ ] All error handling preserved
- [ ] Type hints remain correct and complete
- [ ] Import statements still valid
- [ ] No breaking changes to public APIs

**Behavior Preservation**
- [ ] Return values unchanged
- [ ] Side effects unchanged
- [ ] Exception behavior unchanged
- [ ] Edge case handling preserved

**Code Quality**
- [ ] Removed changes are genuinely AI slop (not intentional patterns)
- [ ] Remaining code follows project conventions
- [ ] No orphaned code or dead references

### Phase 4: Fix Issues
If issues are found:
1. Identify the specific problem
2. Explain why it is a problem
3. Revert only the slop-removal delta using the saved per-file patch (or equivalent reverse-apply)
4. Remove any remaining slops by editing the file yourself, per-file
5. Verify the fix introduces no new issues

## Output Format

\`\`\`
## AI Slop Removal Summary

### Files Processed
- file1.ts: X changes
- file2.ts: Y changes

### Critical Review Results
- Safety: PASS/FAIL
- Behavior: PASS/FAIL
- Quality: PASS/FAIL

### Issues Found & Fixed
1. [Issue] -> [Fix applied]

### Final Status
[CLEAN / ISSUES FIXED / REQUIRES ATTENTION]
\`\`\`

## Quality Assurance
- NEVER remove code that serves a functional purpose
- ALWAYS verify changes compile/parse correctly
- ALWAYS preserve test coverage
- If uncertain, err on the side of keeping the original code

<!-- astrocode: the original also shipped a team-mode addendum (slop-squad team with category
     members, team_create/team_task_create/team_send_message/team_shutdown_request, and an
     external reviewer task). astrocode has no team_* tools, so that addendum is not applied.
     The non-team review loop above is the supported path. To restore team mode, re-add the
     addendum and a teamModeEnabled config gate.
-->`;

export const HYPERPLAN_TEMPLATE = `${HEADER}
<!-- astrocode: /hyperplan is an adversarial multi-agent planning command built entirely on
     oh-my-openagent's team-mode (team_create / team_task_create / team_send_message / team_*),
     plus a bundled hyperplan skill and category members (unspecified-low, unspecified-high,
     ultrabrain, artistry, deep). astrocode deliberately does NOT implement team-mode or
     categories, so this command cannot run its original workflow.

     The original body is preserved below, commented, for a future port:

     You are running the /hyperplan command - adversarial multi-agent planning via team-mode.
     LOAD THE HYPERPLAN SKILL IMMEDIATELY: skill(name="hyperplan")
     After loading the skill, follow its 7-phase workflow EXACTLY using this user request.
     Roster contract: call team_create with category members unspecified-low, unspecified-high,
     ultrabrain, and artistry. Include deep only if the category is enabled; if disabled or
     unavailable, retry without that member and state the degraded roster.
     If team-mode is unavailable (team_* tools missing), instruct the user to enable it.

     End of preserved original body.
-->

# Hyperplan (astrocode fallback)

Team-mode is not available in astrocode, so run a single-agent adversarial planning pass instead:

1. Restate the planning request and the concrete end state.
2. Enumerate the strongest objections to the obvious approach (constraints, failure modes,
   blast radius, reversibility, cost).
3. Produce 2-3 competing plans, each with trade-offs.
4. Consult \`oracle\` (read-only, expensive) for the hardest architectural risks.
5. Have \`prometheus\` write the chosen plan to \`.sisyphus/plans/\`.
6. Summarize the decision, rejected alternatives, and open risks.

<user-request>
$ARGUMENTS
</user-request>`;

export function buildBuiltinCommands(): Record<string, BuiltinCommandDefinition> {
  return {
    goal: {
      description:
        "(builtin) Set, show, pause, resume, or clear the active session goal",
      template: GOAL_TEMPLATE,
    },
    refactor: {
      description:
        "(builtin) Intelligent refactoring with LSP, AST-grep, codemap, and TDD verification",
      template: REFACTOR_TEMPLATE,
    },
    "start-work": {
      description: "(builtin) Start an Atlas work session from a Prometheus plan",
      agent: "atlas",
      subtask: false,
      template: START_WORK_TEMPLATE,
    },
    "stop-continuation": {
      description:
        "(builtin) Stop all continuation mechanisms for this session (no-op in astrocode)",
      template: STOP_CONTINUATION_TEMPLATE,
    },
    "remove-ai-slops": {
      description:
        "(builtin) Remove AI-generated code smells from branch changes and review the results",
      template: REMOVE_AI_SLOPS_TEMPLATE,
    },
    handoff: {
      description:
        "(builtin) Create a detailed context summary for continuing work in a new session",
      template: HANDOFF_TEMPLATE,
    },
    hyperplan: {
      description:
        "(builtin) Adversarial planning pass (team-mode unavailable; single-agent fallback)",
      template: HYPERPLAN_TEMPLATE,
    },
  };
}