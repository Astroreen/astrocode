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

export function discoverSkills(dirs: string[]): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    let entries: string[];
    try {
      if (!existsSync(dir)) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const skillDir = join(dir, entry);
        if (!statSync(skillDir).isDirectory()) continue;
        const skillFile = join(skillDir, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const fm = parseFrontmatter(readFileSync(skillFile, "utf8"), entry);
        if (!fm.name || seen.has(fm.name)) continue;
        seen.add(fm.name);
        found.push({
          name: fm.name,
          description: fm.description ?? "",
          location: skillFile,
        });
      } catch {
        continue;
      }
    }
  }
  return found;
}

export function standardSkillDirs(projectDirs: string[]): string[] {
  const home = homedir();
  const dirs: string[] = [];
  for (const project of projectDirs) {
    if (typeof project !== "string" || !project.trim()) continue;
    dirs.push(join(project, ".opencode", "skills"));
    dirs.push(join(project, ".claude", "skills"));
    dirs.push(join(project, ".agents", "skills"));
  }
  dirs.push(join(home, ".config", "opencode", "skills"));
  dirs.push(join(home, ".claude", "skills"));
  dirs.push(join(home, ".agents", "skills"));
  return dirs;
}