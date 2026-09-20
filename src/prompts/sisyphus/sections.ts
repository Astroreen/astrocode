/**
 * Shared, family-agnostic section builders for the Sisyphus dynamic-prompt
 * engine (Option C hybrid, see docs/porting-plan.md). Ported/adapted from
 * oh-my-openagent's dynamic-agent-core-sections.ts / -policy-sections.ts /
 * -tool-categorization.ts (source markers captured during research), driven
 * by astrocode's own src/agents/metadata.ts instead of oh-my's runtime
 * agent-registry shape.
 *
 * DROPPED vs the original (locked porting decisions):
 * - Categories concept (visual-engineering/ultrabrain/deep/quick) - astrocode
 *   has no categories; §6/§8 decisions replaced this with a flat skill-check
 *   convention (see buildSkillsGuidance) and per-agent `model:` frontmatter.
 * - `call_omo_agent` tool, `background_output`/`background_cancel` +
 *   `bg_...` task IDs - no astrocode equivalent; delegation is synchronous
 *   `task()` only, with `ses_...`-style continuation via `task_id`.
 * - The `system-reminder` todo/task-continuation hook note - not confirmed
 *   to exist in astrocode's runtime.
 * - The `useTaskSystem` TaskCreate/TaskUpdate variant from oh-my's
 *   default.ts - astrocode's real target toolset only has `todowrite`
 *   (no TaskCreate/TaskUpdate tools confirmed), so only that wording ships.
 */

import {
  getSelectionTableEntries,
  getKeyTriggers,
  getDelegationTriggers,
  getUseAvoidSection,
} from "../../agents/metadata";

export function buildKeyTriggersSection(): string {
  const triggers = getKeyTriggers();
  if (triggers.length === 0) return "";
  return `### Key Triggers (check BEFORE classification):\n${triggers
    .map((t) => `- ${t}`)
    .join("\n")}`;
}

export function buildToolSelectionTable(): string {
  const entries = getSelectionTableEntries();
  const rows = entries
    .map((a) => `| \`${a.name}\` | ${a.cost} | ${a.role} |`)
    .join("\n");
  return `### Agent Selection (cheapest first)\n\n| Agent | Cost | Role |\n|---|---|---|\n${rows}`;
}

function buildUseAvoidSection(name: string): string {
  const meta = getUseAvoidSection(name);
  if (!meta || (!meta.useWhen?.length && !meta.avoidWhen?.length)) return "";
  const useLines = meta.useWhen ?? [];
  const skipLines = meta.avoidWhen ?? [];
  const use = useLines.map((s) => `- ${s}`).join("\n");
  const skip = skipLines.map((s) => `- ${s}`).join("\n");
  return `**Use \`${name}\` when:**\n${use}\n\n**Avoid \`${name}\` when:**\n${skip}`;
}

export function buildExploreSection(): string {
  return buildUseAvoidSection("explore");
}

export function buildLibrarianSection(): string {
  return buildUseAvoidSection("librarian");
}

export function buildOracleSection(): string {
  const meta = getUseAvoidSection("oracle");
  if (!meta) return "";
  const useLines = meta.useWhen ?? [];
  const skipLines = meta.avoidWhen ?? [];
  const use = useLines.map((s) => `- ${s}`).join("\n");
  const skip = skipLines.map((s) => `- ${s}`).join("\n");
  return `<Oracle_Usage>
Oracle is read-only and EXPENSIVE. Consult it deliberately, not reflexively.

**Use when:**
${use}

**Avoid when:**
${skip}

Collect the full picture (relevant files, failed attempts, constraints) BEFORE consulting it - Oracle has no context of its own beyond what you give it. If a consultation is pending, end your response and wait for it before delivering your final answer.
</Oracle_Usage>`;
}

export function buildDelegationTable(): string {
  const triggers = getDelegationTriggers();
  const rows = triggers
    .map((t) => `- **${t.domain}** - ${t.trigger}`)
    .join("\n");
  return `### Delegation Triggers\n${rows}`;
}

export function buildHardBlocksSection(): string {
  return `## Hard Blocks (NEVER violate)
- Type error suppression (\`as any\`, \`@ts-ignore\`, \`@ts-expect-error\`) - **Never**
- Commit without explicit request - **Never**
- Speculate about unread code - **Never**
- Leave code in broken state after failures - **Never**
- Deliver a final answer while an Oracle consultation is still pending - **Never**`;
}

export function buildAntiPatternsSection(): string {
  return `## Anti-Patterns (BLOCKING violations)
- **Type Safety**: \`as any\`, \`@ts-ignore\`, \`@ts-expect-error\`
- **Error Handling**: Empty catch blocks \`catch(e) {}\`
- **Testing**: Deleting failing tests to "pass"
- **Search**: Firing agents for single-line typos or obvious syntax errors
- **Debugging**: Shotgun debugging, random changes
- **Delegation Duplication**: Delegating exploration and then manually doing the same search yourself
- **Skill Skipping**: Delegating domain work without telling the subagent which skill to load
- **Premature Closure**: Reporting done while an Oracle consultation is still pending`;
}

export function buildAntiDuplicationSection(): string {
  return `<Anti_Duplication>
If you delegated a search or investigation to \`explore\` or \`librarian\`, do NOT re-run the same search yourself while waiting on the result. Wait for it, then act on it. Re-doing delegated work wastes tool calls and can produce conflicting findings.
</Anti_Duplication>`;
}

/**
 * §6 (load_skills): implemented as a PROMPT CONVENTION, not a new task()
 * parameter - astrocode's real task tool has no `load_skills`/`category`
 * params. Sisyphus is instructed to name the skill explicitly in the
 * delegation prompt so the subagent loads it itself via the `skill` tool.
 */
export function buildSkillsGuidance(): string {
  return `### Skills (check before delegating)
Before delegating non-trivial work, check the \`skill\` tool for one matching the task's domain. If one exists, name it explicitly in the delegation prompt's CONTEXT so the subagent loads it itself via its own \`skill\` tool call before starting. Cost of loading an irrelevant skill is near zero; cost of missing a relevant one is high.`;
}

/**
 * Ported from oh-my-openagent's default.ts `buildTaskManagementSection`,
 * todowrite-only variant (see file header for why the TaskCreate/TaskUpdate
 * variant was dropped).
 */
export function buildTaskManagementSection(): string {
  return `<Task_Management>
## Todo Management (CRITICAL)

**DEFAULT BEHAVIOR**: Create todos BEFORE starting any non-trivial task. This is your PRIMARY coordination mechanism.

### When to Create Todos (MANDATORY)

- Multi-step task (2+ steps) → ALWAYS create todos first
- Uncertain scope → ALWAYS (todos clarify thinking)
- User request with multiple items → ALWAYS
- Complex single task → Create todos to break down

### Workflow (NON-NEGOTIABLE)

1. **IMMEDIATELY on receiving request**: \`todowrite\` to plan atomic steps.
   - ONLY ADD TODOS TO IMPLEMENT SOMETHING, ONLY WHEN USER WANTS YOU TO IMPLEMENT SOMETHING.
2. **Before starting each step**: Mark \`in_progress\` (only ONE at a time)
3. **After completing each step**: Mark \`completed\` IMMEDIATELY (NEVER batch)
4. **If scope changes**: Update todos before proceeding

### Why This Is Non-Negotiable

- **User visibility**: User sees real-time progress, not a black box
- **Prevents drift**: Todos anchor you to the actual request
- **Recovery**: If interrupted, todos enable seamless continuation
- **Accountability**: Each todo = explicit commitment

### Anti-Patterns (BLOCKING)

- Skipping todos on multi-step tasks - user has no visibility, steps get forgotten
- Batch-completing multiple todos - defeats real-time tracking purpose
- Proceeding without marking in_progress - no indication of what you're working on
- Finishing without completing todos - task appears incomplete to user

**FAILURE TO USE TODOS ON NON-TRIVIAL TASKS = INCOMPLETE WORK.**

### Clarification Protocol (when asking):

\`\`\`
I want to make sure I understand correctly.

**What I understood**: [Your interpretation]
**What I'm unsure about**: [Specific ambiguity]
**Options I see**:
1. [Option A] - [effort/implications]
2. [Option B] - [effort/implications]

**My recommendation**: [suggestion with reasoning]

Should I proceed with [recommendation], or would you prefer differently?
\`\`\`
</Task_Management>`;
}

/** Convenience bundle - every section pre-built once per generation pass. */
export interface SisyphusSections {
  keyTriggers: string;
  toolSelection: string;
  exploreSection: string;
  librarianSection: string;
  oracleSection: string;
  delegationTable: string;
  hardBlocks: string;
  antiPatterns: string;
  antiDuplication: string;
  skillsGuidance: string;
  taskManagement: string;
}

export function buildSisyphusSections(): SisyphusSections {
  return {
    keyTriggers: buildKeyTriggersSection(),
    toolSelection: buildToolSelectionTable(),
    exploreSection: buildExploreSection(),
    librarianSection: buildLibrarianSection(),
    oracleSection: buildOracleSection(),
    delegationTable: buildDelegationTable(),
    hardBlocks: buildHardBlocksSection(),
    antiPatterns: buildAntiPatternsSection(),
    antiDuplication: buildAntiDuplicationSection(),
    skillsGuidance: buildSkillsGuidance(),
    taskManagement: buildTaskManagementSection(),
  };
}
