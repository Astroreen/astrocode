// Child (subagent) session registry — the 80/20 of oh-my-openagent's
// `subagentSessions` Set (features/claude-code-session-state/state.ts) and
// SessionCategoryRegistry (shared/session-category-registry.ts). See
// docs/porting-plan.md, "Fallback module design".
//
// opencode's built-in `task` tool creates a child session with `parentID` set
// (packages/opencode/src/tool/task.ts: `sessions.create({ parentID, agent })`),
// and the `session.created` event carries that full Session. So children can be
// tracked for free, with no extra API calls.
//
// Children need different fallback treatment than the main session:
//   - a child whose delegation prompt is synthetic-only still needs a retry
//     payload (see collectLastUserText in ./index.ts);
//   - a child with no fallback chain must be aborted on a terminal quota error,
//     otherwise the parent's `task` tool call blocks until its own timeout.
//
// Process-local: a plugin restart forgets children, which is acceptable (the
// same trade-off the attempt state in ./state.ts makes).

import { evictOldestByStamp } from "./state";

interface ChildSessionState {
  agent?: string;
}

const children = new Map<string, ChildSessionState>();

export function registerChildSession(sessionID: string, agent?: string): void {
  children.set(sessionID, { agent });
  evictOldestByStamp(children);
}

// Returns true when `info` describes a child session (i.e. carries a non-empty
// `parentID`), registering it. Tolerant of unexpected shapes: a missing/invalid
// `parentID` is treated as "not a child" rather than throwing.
export function registerChildSessionFromInfo(info: unknown): boolean {
  if (!info || typeof info !== "object") return false;
  const record = info as Record<string, unknown>;

  const id = record.id;
  const parentID = record.parentID;
  if (typeof id !== "string" || id.length === 0) return false;
  if (typeof parentID !== "string" || parentID.length === 0) return false;

  const agent = typeof record.agent === "string" ? record.agent : undefined;
  registerChildSession(id, agent);
  return true;
}

export function isChildSession(sessionID: string): boolean {
  return children.has(sessionID);
}

export function getChildSessionAgent(sessionID: string): string | undefined {
  return children.get(sessionID)?.agent;
}

export function unregisterChildSession(sessionID: string): void {
  children.delete(sessionID);
}

export function clearChildSessions(): void {
  children.clear();
}
