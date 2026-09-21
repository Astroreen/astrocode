// Persona registry: reads the shipped `agents/*.md` files and turns them into
// opencode AgentConfig entries the plugin injects via the `config` hook. This is
// how oh-my-openagent owned its agents programmatically, and it means a project
// needs ONLY the plugin entry — no copying/symlinking `agents/` into
// `.opencode/agents/`.
//
// Native override mapping (user requirement):
//   - opencode's builtin `build` primary agent  -> the Sisyphus orchestrator
//   - opencode's builtin `plan`  primary agent  -> the Prometheus planner
//
// Colors are taken from DEFAULT_COLORS (oh-my-openagent-style palette) and can be
// overridden per agent by the astrocode config file.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PersonaDefinition {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  temperature?: number;
  color?: string;
  tools?: Record<string, boolean>;
  permission?: {
    edit?: "ask" | "allow" | "deny";
    bash?: "ask" | "allow" | "deny";
  };
  prompt: string;
}

// Distinct per-agent colors (oh-my-openagent uses a hex color per agent).
export const DEFAULT_COLORS: Record<string, string> = {
  sisyphus: "#00CED1",
  "sisyphus-junior": "#16A085",
  hephaestus: "#FF6B35",
  atlas: "#3498DB",
  prometheus: "#9B59B6",
  oracle: "#E74C3C",
  explore: "#2ECC71",
  librarian: "#1ABC9C",
  metis: "#F1C40F",
  momus: "#E67E22",
  "multimodal-looker": "#E91E63",
};

// Display names, copied from oh-my-openagent's own AGENT_DISPLAY_NAMES map
// (dist/index.js `packages/omo-opencode/src/shared/agent-display-names.ts`).
// Fidelity matters: astrocode registers agents under these keys so opencode's UI
// (TAB switcher, @ menu, session header) shows exactly the names oh-my shows.
export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  sisyphus: "Sisyphus - ultraworker",
  hephaestus: "Hephaestus - Deep Agent",
  prometheus: "Prometheus - Plan Builder",
  atlas: "Atlas - Plan Executor",
  "sisyphus-junior": "Sisyphus-Junior",
  metis: "Metis - Plan Consultant",
  momus: "Momus - Plan Critic",
  oracle: "oracle",
  librarian: "librarian",
  explore: "explore",
  "multimodal-looker": "multimodal-looker",
};

export function getAgentDisplayName(key: string): string {
  const exact = AGENT_DISPLAY_NAMES[key];
  if (exact !== undefined) return exact;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(AGENT_DISPLAY_NAMES)) {
    if (k.toLowerCase() === lower) return v;
  }
  return key;
}

// Reverse lookup: display name (or anything case-insensitively matching one) ->
// canonical persona key. Lets config files use either name interchangeably.
export function getAgentConfigKey(name: string): string {
  if (AGENT_DISPLAY_NAMES[name] !== undefined) return name;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(AGENT_DISPLAY_NAMES)) {
    if (v.toLowerCase() === lower) return k;
  }
  return name;
}

// The default agent oh-my sets (its `applyDefaultAgent` falls back to the
// Sisyphus display name), which is how `build` ends up "replaced" by Sisyphus.
export const DEFAULT_AGENT = getAgentDisplayName("sisyphus");

// opencode's builtin primary agents that oh-my demotes to hidden subagents once
// the plugin owns the roster (`build: { mode: "subagent", hidden: true }`).
export const DEMOTED_NATIVE_AGENTS = ["build", "plan"] as const;

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function coerce(value: string): unknown {
  const unquoted = stripQuotes(value);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (unquoted !== "" && !Number.isNaN(Number(unquoted))) return Number(unquoted);
  return unquoted;
}

export function parsePersonaMarkdown(name: string, raw: string): PersonaDefinition {
  const parsed = parseFrontmatter(raw);
  const fm = parsed.data;

  const tools =
    fm.tools && typeof fm.tools === "object"
      ? (fm.tools as Record<string, boolean>)
      : undefined;

  const description =
    typeof fm.description === "string" && fm.description.length > 0
      ? fm.description
      : `astrocode agent: ${name}`;

  const rawMode = typeof fm.mode === "string" ? fm.mode : "all";
  const mode: PersonaDefinition["mode"] =
    rawMode === "primary" || rawMode === "subagent" ? rawMode : "all";

  return {
    name,
    description,
    mode,
    temperature: typeof fm.temperature === "number" ? fm.temperature : undefined,
    color: typeof fm.color === "string" ? fm.color : DEFAULT_COLORS[name],
    tools,
    prompt: parsed.body.trim(),
  };
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data: {}, body: raw };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: raw };

  const data: Record<string, unknown> = {};
  let nestedKey: string | undefined;
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indented = /^\s+/.test(line);
    if (indented && nestedKey) {
      const nestedMatch = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (nestedMatch) {
        const bucket = (data[nestedKey] as Record<string, unknown>) ?? {};
        bucket[nestedMatch[1]] = coerce(nestedMatch[2]);
        data[nestedKey] = bucket;
      }
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (value.trim() === "") {
      nestedKey = key;
      data[key] = {};
    } else {
      nestedKey = undefined;
      data[key] = coerce(value);
    }
  }

  const body = lines.slice(end + 1).join("\n");
  return { data, body };
}

// Reads every `agents/*.md` under `agentsDir` and returns definitions keyed by
// file name (without extension).
export function loadPersonas(agentsDir: string): Record<string, PersonaDefinition> {
  const out: Record<string, PersonaDefinition> = {};
  let entries: string[] = [];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    try {
      const raw = readFileSync(join(agentsDir, entry), "utf8");
      out[name] = parsePersonaMarkdown(name, raw);
    } catch {
      // ignore unreadable persona
    }
  }
  return out;
}

// Remap the shipped persona keys (file names) to opencode agent config entries
// keyed by oh-my display names, with per-agent model/color overrides applied.
export function toAgentConfigs(
  personas: Record<string, PersonaDefinition>,
  settingsFor: (
    key: string,
    displayName: string,
  ) => { model?: string; color?: string } | undefined,
): Record<string, PersonaDefinition & { model?: string }> {
  const out: Record<string, PersonaDefinition & { model?: string }> = {};
  for (const [key, persona] of Object.entries(personas)) {
    const displayName = getAgentDisplayName(key);
    const settings = settingsFor(key, displayName);
    const entry: PersonaDefinition & { model?: string } = {
      ...persona,
      name: displayName,
      color: settings?.color ?? persona.color ?? DEFAULT_COLORS[key],
    };
    if (settings?.model) entry.model = settings.model;
    out[displayName] = entry;
  }
  return out;
}