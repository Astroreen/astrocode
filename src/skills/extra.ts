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
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";

// Priority for `skills.extraDirs` sources. Deliberately BELOW user-opencode (30)
// so a user-authored skill of the same name is never shadowed by a bridged
// cache copy.
export const EXTRA_SKILL_PRIORITY = 25;

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
// see" their skills. This scans the standard skill dirs; the plugin turns each
// skill into a slash command whose template embeds the full SKILL.md body
// (oh-my-openagent parity): `<skill-instruction>` wraps the body, the user's
// trailing args land in `<user-request>$ARGUMENTS</user-request>`, and the
// whole thing becomes one user message.

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

// Resolve a path to its physical location, tolerating broken links/permissions.
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function discoverSkillsWithPriority(sources: SkillSource[]): DiscoveredSkill[] {
  const winners = new Map<string, DiscoveredSkill>();
  const losers = new Map<string, { label: string; priority: number }>();
  // Real path of every accepted SKILL.md -> skill name. Two sources can reach
  // the SAME physical skill (e.g. `skills.extraDirs` bridging a cache dir that
  // was also symlinked into ~/.config/opencode/skills). Without this, the
  // second sighting looks like a name collision and the higher-priority copy
  // silently shadows the first — even though they are one file.
  const realpaths = new Map<string, string>();

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

        // Already accepted under its physical path (possibly from another
        // source): same skill, not a collision. Keep the first (highest
        // priority encountered) and stay quiet.
        const real = realpathOrSelf(skillFile);
        if (realpaths.has(real)) continue;

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
          realpaths.set(real, fm.name);
          continue;
        }
        if (source.priority > (existing.priority ?? 0)) {
          losers.set(fm.name, {
            label: existing.source ?? "",
            priority: existing.priority ?? 0,
          });
          realpaths.delete(realpathOrSelf(existing.location));
          winners.set(fm.name, candidate);
          realpaths.set(real, fm.name);
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
    log.warn(
      `skill collision: ${name} — kept ${winner.source}(${winner.priority}), dropped ${loser.label}(${loser.priority})`,
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

// ---------------------------------------------------------------------------
// Skill → slash-command template (oh-my-openagent parity).
//
// oh-my wraps the skill body in `<skill-instruction>` and puts the trailing
// `/cmd args` text in `<user-request>`, so the model sees one user message:
// skill prompt first, the user's actual request last. opencode substitutes
// `$ARGUMENTS` in command templates before creating the user message.

/** Drop YAML frontmatter (`--- ... ---`) from a SKILL.md body. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(raw);
  if (!match) return raw;
  return raw.slice(match[0].length);
}

/** Fallback when the SKILL.md body cannot be read: point at the skill tool. */
export function thinSkillCommandTemplate(name: string): string {
  return (
    `Load the "${name}" skill by calling the skill tool ` +
    `(name: "${name}"), then follow its instructions.\n\n$ARGUMENTS`
  );
}

/**
 * Full-body command template: skill prompt + user's trailing args in
 * `<user-request>`. Falls back to the thin skill-tool instruction when the
 * file is missing/empty (best-effort, never throws).
 */
export function skillCommandTemplate(skill: DiscoveredSkill): string {
  let body = "";
  try {
    body = stripFrontmatter(readFileSync(skill.location, "utf8")).trim();
  } catch {
    body = "";
  }
  if (!body) return thinSkillCommandTemplate(skill.name);
  return (
    `<skill-instruction>\n${body}\n</skill-instruction>\n\n` +
    `<user-request>\n$ARGUMENTS\n</user-request>`
  );
}