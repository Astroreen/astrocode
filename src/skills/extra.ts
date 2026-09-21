// Extra skill directories.
//
// opencode's native skill discovery only scans:
//   .opencode/skills/, ~/.config/opencode/skills/,
//   .claude/skills/, ~/.claude/skills/, .agents/skills/, ~/.agents/skills/
// A plugin cannot register skills through typed config (no `skill` field in
// @opencode-ai/plugin or @opencode-ai/sdk). oh-my-openagent kept its own skill
// cache in ~/.cache/opencode/skills/ (e.g. security-research), which is why
// those skills "disappear" once oh-my is not the loader.
//
// astrocode bridges the gap: `skills.extraDirs` lists directories whose
// `<name>/SKILL.md` subdirectories are symlinked into the user skills dir, so
// opencode's native loader picks them up. Opt-in (empty by default), best-effort
// (never throws), and non-destructive (never overwrites an existing skill).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillLinkReport {
  linked: string[];
  skipped: string[];
  errors: string[];
}

export function defaultSkillsTargetDir(): string {
  return join(homedir(), ".config", "opencode", "skills");
}

export function linkExtraSkillDirs(
  extraDirs: string[],
  targetDir: string = defaultSkillsTargetDir(),
): SkillLinkReport {
  const report: SkillLinkReport = { linked: [], skipped: [], errors: [] };
  if (!Array.isArray(extraDirs) || extraDirs.length === 0) return report;

  for (const dir of extraDirs) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const source = dir.trim();
    let entries: string[];
    try {
      if (!existsSync(source)) continue;
      entries = readdirSync(source);
    } catch (err) {
      report.errors.push(`${source}: ${String(err)}`);
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(source, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
        if (!existsSync(join(skillDir, "SKILL.md"))) continue;

        const target = join(targetDir, entry);
        if (existsSync(target)) {
          report.skipped.push(entry);
          continue;
        }
        mkdirSync(targetDir, { recursive: true });
        symlinkSync(skillDir, target, "dir");
        report.linked.push(entry);
      } catch (err) {
        report.errors.push(`${entry}: ${String(err)}`);
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Skill discovery + slash-command bridge.
//
// opencode registers skills for the MODEL (the `skill` tool lists them), but a
// skill is not a slash command — so users who expect `/caveman` etc. "cannot
// see" their skills. This scans the standard skill dirs and returns the skill
// names/descriptions, which the plugin turns into thin commands that tell the
// model to load the skill via its own `skill` tool.

export interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
  source?: string;
  priority?: number;
}

export interface SkillSource {
  dir: string;
  priority: number;
  label: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(raw: string, fallbackName: string): Frontmatter {
  const fm: Frontmatter = {};
  if (!raw.startsWith("---")) return fm;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return fm;
  const block = raw.slice(3, end).split("\n");

  for (let i = 0; i < block.length; i++) {
    const line = block[i] ?? "";
    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = (match[2] ?? "").trim();

    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts: string[] = [];
      while (i + 1 < block.length) {
        const next = block[i + 1] ?? "";
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        if (next.trim() === "" && parts.length === 0) {
          i++;
          continue;
        }
        if (next.trim() === "") break;
        parts.push(next.trim());
        i++;
      }
      value = parts.join(" ");
    }

    value = value.replace(/^["']|["']$/g, "").trim();
    if (key === "name" && value) fm.name = value;
    if (key === "description" && value) fm.description = value;
  }

  if (!fm.name) fm.name = fallbackName;
  return fm;
}

export function discoverSkillsWithPriority(sources: SkillSource[]): DiscoveredSkill[] {
  const winners = new Map<string, DiscoveredSkill>();
  const losers = new Map<string, { label: string; priority: number }>();

  for (const source of sources) {
    if (!source || typeof source.dir !== "string" || !source.dir.trim()) continue;
    let entries: string[];
    try {
      if (!existsSync(source.dir)) continue;
      entries = readdirSync(source.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const skillDir = join(source.dir, entry);
        if (!statSync(skillDir).isDirectory()) continue;
        const skillFile = join(skillDir, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const fm = parseFrontmatter(readFileSync(skillFile, "utf8"), entry);
        if (!fm.name) continue;

        const candidate: DiscoveredSkill = {
          name: fm.name,
          description: fm.description ?? "",
          location: skillFile,
          source: source.label,
          priority: source.priority,
        };

        const existing = winners.get(fm.name);
        if (!existing) {
          winners.set(fm.name, candidate);
          continue;
        }
        if (source.priority > (existing.priority ?? 0)) {
          losers.set(fm.name, {
            label: existing.source ?? "",
            priority: existing.priority ?? 0,
          });
          winners.set(fm.name, candidate);
        } else {
          losers.set(fm.name, { label: source.label, priority: source.priority });
        }
      } catch {
        continue;
      }
    }
  }

  for (const [name, loser] of losers) {
    const winner = winners.get(name);
    if (!winner) continue;
    console.error(
      `[astrocode] skill collision: ${name} — kept ${winner.source}(${winner.priority}), dropped ${loser.label}(${loser.priority})`,
    );
  }

  return [...winners.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverSkills(dirs: string[]): DiscoveredSkill[] {
  const sources: SkillSource[] = [];
  for (let i = 0; i < dirs.length; i++) {
    sources.push({ dir: dirs[i] ?? "", priority: dirs.length - i, label: `dir-${i}` });
  }
  return discoverSkillsWithPriority(sources);
}

export function standardSkillSources(
  projectDirs: string[],
  bundledDir?: string,
): SkillSource[] {
  const home = homedir();
  const sources: SkillSource[] = [];
  for (const project of projectDirs) {
    if (typeof project !== "string" || !project.trim()) continue;
    sources.push({
      dir: join(project, ".opencode", "skills"),
      priority: 60,
      label: "project-opencode",
    });
    sources.push({
      dir: join(project, ".claude", "skills"),
      priority: 50,
      label: "project-claude",
    });
    sources.push({
      dir: join(project, ".agents", "skills"),
      priority: 40,
      label: "project-agents",
    });
  }
  sources.push({
    dir: join(home, ".config", "opencode", "skills"),
    priority: 30,
    label: "user-opencode",
  });
  sources.push({ dir: join(home, ".claude", "skills"), priority: 20, label: "user-claude" });
  sources.push({ dir: join(home, ".agents", "skills"), priority: 10, label: "user-agents" });
  if (bundledDir) {
    sources.push({ dir: bundledDir, priority: 5, label: "builtin" });
  }
  return sources;
}

export function standardSkillDirs(projectDirs: string[]): string[] {
  return standardSkillSources(projectDirs).map((source) => source.dir);
}