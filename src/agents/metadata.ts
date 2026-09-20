/**
 * Static single-source-of-truth metadata for astrocode's built-in subagents.
 * Mirrors oh-my-openagent's `agent.metadata` concept (keyTrigger/cost/
 * useWhen/avoidWhen/triggers) per locked decision §7. Consumed by
 * src/prompts/sisyphus/dynamicSections.ts to generate Sisyphus's Key
 * Triggers / Tool Selection Table / Delegation Table at runtime instead of
 * duplicating this content by hand inside agents/sisyphus.md.
 *
 * Scope: only agents Sisyphus (agents/sisyphus.md) is expected to delegate
 * to. Sisyphus itself and atlas (alternate orchestrator persona) are
 * intentionally excluded — atlas is not a Sisyphus delegation target.
 */

export type AgentCost = "FREE" | "CHEAP" | "EXPENSIVE";

export interface AgentTrigger {
  domain: string;
  trigger: string;
}

export interface AgentMetadata {
  name: string;
  /** One-line role, used in the tool-selection table. */
  role: string;
  cost: AgentCost;
  /** 'utility' agents are excluded from the selection table (mirrors oh-my's filter). */
  category?: "utility";
  /** Short bullet shown in the "Key Triggers" section. */
  keyTrigger?: string;
  useWhen?: string[];
  avoidWhen?: string[];
  /** Rows for the Delegation Table. */
  triggers?: AgentTrigger[];
}

const COST_ORDER: Record<AgentCost, number> = {
  FREE: 0,
  CHEAP: 1,
  EXPENSIVE: 2,
};

export const AGENT_METADATA: Record<string, AgentMetadata> = {
  explore: {
    name: "explore",
    role: "Contextual grep for codebases - discovery, finding files, understanding patterns",
    cost: "CHEAP",
    keyTrigger: "2+ modules involved → fire `explore` agent",
    useWhen: [
      "Multiple files/modules need correlating before you can answer or act",
      "You don't yet know where the relevant code lives",
      "You need cross-validated (grep + LSP + glob) file-location evidence",
    ],
    avoidWhen: [
      "You already know the exact file/line to change",
      "The question is answerable from a single already-open file",
    ],
    triggers: [
      {
        domain: "Codebase search",
        trigger:
          "2+ modules involved, unclear file location, need contextual grep across files",
      },
    ],
  },
  librarian: {
    name: "librarian",
    role: "Reference grep for external docs, OSS repos, and web research",
    cost: "CHEAP",
    keyTrigger: "External library/source mentioned → fire `librarian` agent",
    useWhen: [
      "An external library, package, or public repo is mentioned",
      "You need official docs, implementation examples, or issue/PR history",
      "Multi-repo analysis or remote codebase search is required",
    ],
    avoidWhen: [
      "The question is only about this project's own code (use explore instead)",
      "You already have a cited, dated answer from a prior librarian call",
    ],
    triggers: [
      {
        domain: "External library / remote repo / docs",
        trigger: "External library, package, or public codebase mentioned",
      },
    ],
  },
  oracle: {
    name: "oracle",
    role: "Read-only high-IQ consultant for hard debugging and architecture",
    cost: "EXPENSIVE",
    keyTrigger:
      "Hard bug root-cause or high-difficulty design decision → consult `oracle`",
    useWhen: [
      "A bug's root cause isn't obvious after normal investigation",
      "A high-difficulty architecture or design decision needs a second opinion",
    ],
    avoidWhen: [
      "The fix or approach is already clear",
      "The question is a simple lookup explore/librarian can answer",
    ],
    triggers: [
      {
        domain: "Hard debugging / architecture",
        trigger:
          "Root cause unclear after investigation, or high-difficulty design decision needed",
      },
    ],
  },
  prometheus: {
    name: "prometheus",
    role: "Planning consultant - writes decision-complete work plans, never implements",
    cost: "CHEAP",
    triggers: [
      {
        domain: "Planning",
        trigger:
          'User wants a work plan written ("plan X", "how would you approach X") rather than immediate implementation',
      },
    ],
  },
  hephaestus: {
    name: "hephaestus",
    role: "Autonomous deep worker for complex, open-ended implementation tasks",
    cost: "EXPENSIVE",
    triggers: [
      {
        domain: "Autonomous deep implementation",
        trigger:
          "Multi-step, open-ended implementation that should run to completion without hand-holding",
      },
    ],
  },
  "sisyphus-junior": {
    name: "sisyphus-junior",
    role: "Focused task executor for direct, well-scoped implementation",
    cost: "CHEAP",
    triggers: [
      {
        domain: "Focused execution",
        trigger:
          "Task is already well-scoped and clear - just needs direct implementation",
      },
    ],
  },
  metis: {
    name: "metis",
    role: "Pre-planning consultant - analyzes intent and risk before a plan is written",
    cost: "CHEAP",
    triggers: [
      {
        domain: "Pre-planning risk analysis",
        trigger:
          "Before writing a plan for refactor / build-from-scratch / architecture work",
      },
    ],
  },
  momus: {
    name: "momus",
    role: "Plan reviewer - verifies a written plan is executable and well-referenced",
    cost: "CHEAP",
    triggers: [
      {
        domain: "Plan review",
        trigger:
          "A `.sisyphus/plans/*.md` file exists and needs executability verification before starting work",
      },
    ],
  },
  "multimodal-looker": {
    name: "multimodal-looker",
    role: "Media interpreter for images and documents",
    cost: "FREE",
    category: "utility",
    triggers: [
      {
        domain: "Media analysis",
        trigger: "Image, screenshot, or document is attached and needs interpretation",
      },
    ],
  },
};

/**
 * Delegation-table rows, sorted cheapest-first, utility agents excluded
 * (mirrors oh-my's buildToolSelectionTable filter).
 */
export function getSelectionTableEntries(): AgentMetadata[] {
  return Object.values(AGENT_METADATA)
    .filter((a) => a.category !== "utility")
    .sort((a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost]);
}

export function getKeyTriggers(): string[] {
  return Object.values(AGENT_METADATA)
    .map((a) => a.keyTrigger)
    .filter((t): t is string => Boolean(t));
}

export function getDelegationTriggers(): AgentTrigger[] {
  return Object.values(AGENT_METADATA).flatMap((a) => a.triggers ?? []);
}

export function getUseAvoidSection(
  name: string,
): Pick<AgentMetadata, "useWhen" | "avoidWhen"> | undefined {
  const meta = AGENT_METADATA[name];
  if (!meta) return undefined;
  return { useWhen: meta.useWhen, avoidWhen: meta.avoidWhen };
}
