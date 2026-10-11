// Static registry of deprecated tool-name aliases (plan T5, workstream B).
//
// Claude-harness models hallucinate Claude Code tool names (Task_Create,
// TodoWrite, Agent, ...). Each entry here registers a REAL opencode tool under
// the legacy name that soft-redirects the model to the canonical tool — always
// a successful result, never an error part, never a side effect (except the
// T6 delegate bodies).
//
// The composition is a fixed constant: expanded only by editing this array.
// No dynamic construction, no session-time mutation — the tool schema set is
// stable for the whole bootstrap (prompt-cache prefix stays valid).
//
// Kinds:
//   redirect — execute returns success text telling the model to call the
//              canonical tool exactly once. No side effects.
//   delegate — execute will perform a real side effect via the SDK client
//              (T6). The T5 placeholder returns a no-instruction success text.
//
// Canonical targets are REAL opencode 1.18.x registry ids: todowrite, task,
// skill. There is no `todoread` tool in opencode — the read-side todo aliases
// (Task_Get/TaskGet/Task_List/TaskList/TodoRead) are delegates tagged
// `session-todos`; T6 implements them via the SDK session-todo route.
// TaskOutput/TaskStop delegate to child-session output/abort (T6).

import { getAgentDisplayName } from "../agents/personas";

export type AliasKind = "redirect" | "delegate";

export interface AliasDefinition {
  /** Registered tool name — a bare opencode registry key (never `task`). */
  name: string;
  /**
   * redirect: the canonical tool name the model must call instead.
   * delegate: a stable action tag describing the T6 side effect
   * (session-todos / child-output / child-abort) — not a tool name.
   */
  canonical: string;
  kind: AliasKind;
  /** Static model-visible description; one sentence, no dynamic content. */
  description: string;
  /**
   * Optional canonical-invocation hint appended to the redirect text
   * (redirect kind only), e.g. the planner subagent_type for plan-mode aliases.
   */
  hint?: string;
}

// The planner subagent registered by astrocode's config hook (see
// src/commands/index.ts: `task(subagent_type="Prometheus - Plan Builder")`).
function prometheusAgentName(): string {
  return getAgentDisplayName("prometheus");
}

function redirectDescription(canonical: string): string {
  return (
    `DEPRECATED ALIAS — do not call this tool; call \`${canonical}\` ` +
    `exactly once with your intended arguments instead.`
  );
}

function planModeDescription(): string {
  return (
    `DEPRECATED ALIAS — do not call this tool; call \`task\` exactly once ` +
    `with subagent_type "${prometheusAgentName()}" instead.`
  );
}

function delegateDescription(): string {
  return (
    `DEPRECATED ALIAS — do not call this tool; its effect is handled ` +
    `natively by the harness.`
  );
}

function planModeHint(): string {
  return `subagent_type: "${prometheusAgentName()}"`;
}

export const ALIAS_REGISTRY: readonly AliasDefinition[] = [
  // Claude Code todo/task CRUD names -> opencode todo tools.
  {
    name: "Task_Create",
    canonical: "todowrite",
    kind: "redirect",
    description: redirectDescription("todowrite"),
  },
  {
    name: "TaskCreate",
    canonical: "todowrite",
    kind: "redirect",
    description: redirectDescription("todowrite"),
  },
  {
    name: "Task_Update",
    canonical: "todowrite",
    kind: "redirect",
    description: redirectDescription("todowrite"),
  },
  {
    name: "TaskUpdate",
    canonical: "todowrite",
    kind: "redirect",
    description: redirectDescription("todowrite"),
  },
  // Read-side todo names: opencode has no read tool — delegate (T6 reads the
  // session todo list via the SDK and returns it as text).
  {
    name: "Task_Get",
    canonical: "session-todos",
    kind: "delegate",
    description: delegateDescription(),
  },
  {
    name: "TaskGet",
    canonical: "session-todos",
    kind: "delegate",
    description: delegateDescription(),
  },
  {
    name: "Task_List",
    canonical: "session-todos",
    kind: "delegate",
    description: delegateDescription(),
  },
  {
    name: "TaskList",
    canonical: "session-todos",
    kind: "delegate",
    description: delegateDescription(),
  },
  {
    name: "TodoWrite",
    canonical: "todowrite",
    kind: "redirect",
    description: redirectDescription("todowrite"),
  },
  {
    name: "TodoRead",
    canonical: "session-todos",
    kind: "delegate",
    description: delegateDescription(),
  },
  // Background-task control names: delegate to child-session side effects (T6).
  {
    name: "TaskOutput",
    canonical: "child-output",
    kind: "delegate",
    description: delegateDescription(),
  },
  {
    name: "TaskStop",
    canonical: "child-abort",
    kind: "delegate",
    description: delegateDescription(),
  },
  // Claude Code delegation names -> opencode native tools.
  //
  // NO `Skill` alias: a Claude-path proxy (opencode-claude-auth via meridian)
  // normalizes tool names by capitalizing the first letter, so opencode's
  // native `skill` tool and an alias named `Skill` both become `mcp_Skill` —
  // the API rejects the duplicate with `Tool mcp_Skill is already registered`
  // (HTTP 500). The native `skill` tool already covers the call, so no alias
  // is needed. `TodoWrite` is safe: it normalizes to `mcp_TodoWrite`, which
  // does NOT collide with `todowrite` -> `mcp_Todowrite`.
  {
    name: "Agent",
    canonical: "task",
    kind: "redirect",
    description: redirectDescription("task"),
  },
  // Plan-mode toggles -> the planner subagent (astrocode convention, see
  // src/commands/index.ts header).
  {
    name: "EnterPlanMode",
    canonical: "task",
    kind: "redirect",
    description: planModeDescription(),
    hint: planModeHint(),
  },
  {
    name: "ExitPlanMode",
    canonical: "task",
    kind: "redirect",
    description: planModeDescription(),
    hint: planModeHint(),
  },
];