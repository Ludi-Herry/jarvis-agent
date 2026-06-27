/**
 * SkillRegistry — three-level progressive disclosure (plan §3.7).
 *
 * The point is to spend tokens only when a skill is relevant:
 *  - L1 (cheap, always): a catalog of name + description, injected every turn so the model
 *    knows what skills exist.
 *  - L2 (expensive, on demand): a skill's full SKILL.md body, injected ONLY when the user's
 *    message trips one of its triggers.
 *  - L3 (scripts/refs): not needed by git-commit in A phase.
 *
 * A-phase matching is deterministic keyword containment (testable, no model round-trip):
 * `triggers` in the frontmatter decide L2 activation. A later milestone can swap in
 * model-driven invocation without changing the catalog/body shape.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

export interface Skill {
  name: string;
  /** One line shown in the L1 catalog — tells the model WHEN the skill applies. */
  description: string;
  /** Keywords whose presence in a user message activates L2 (case-insensitive). */
  triggers: string[];
  /** The full SKILL.md body (L2). */
  body: string;
}

/** Scan `dir` for `<dir>/<skill>/SKILL.md` and parse each into a {@link Skill}. A missing
 *  directory yields `[]` (no skills installed is not an error); a folder without a SKILL.md
 *  is skipped. */
export async function loadSkills(dir: string): Promise<Skill[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return []; // no skills dir → no skills, not an error

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8').catch(() => null);
    if (text === null) continue;
    const { frontmatter, body } = parseFrontmatter(text);
    skills.push({
      name: asString(frontmatter.name) || entry.name,
      description: asString(frontmatter.description),
      triggers: asArray(frontmatter.triggers),
      body,
    });
  }
  return skills;
}

export class SkillRegistry {
  constructor(private readonly skills: Skill[]) {}

  static async load(dir: string): Promise<SkillRegistry> {
    return new SkillRegistry(await loadSkills(dir));
  }

  list(): readonly Skill[] {
    return this.skills;
  }

  /** L1: the always-injected directory. `''` when no skills are installed. */
  catalog(): string {
    if (this.skills.length === 0) return '';
    const lines = this.skills.map((s) => `- ${s.name}: ${s.description}`);
    return `## 可用技能（相关时其完整说明会自动加载）\n${lines.join('\n')}`;
  }

  /** Skills whose triggers appear (case-insensitive) in `text`. */
  activate(text: string): Skill[] {
    const haystack = text.toLowerCase();
    return this.skills.filter((s) => s.triggers.some((t) => haystack.includes(t.toLowerCase())));
  }

  /**
   * The per-turn system addendum: the L1 catalog plus the L2 body of every skill the message
   * activates. `''` when no skills are installed, so callers can fold it in unconditionally.
   * This is the disclosure boundary the acceptance measures: a relevant message yields a
   * longer addendum (catalog + body); an unrelated one yields just the catalog.
   */
  systemAddendum(text: string): string {
    if (this.skills.length === 0) return '';
    const parts = [this.catalog()];
    for (const skill of this.activate(text)) {
      parts.push(`## 技能：${skill.name}\n${skill.body}`);
    }
    return parts.join('\n\n');
  }
}

function asString(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v : '';
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  return typeof v === 'string' && v !== '' ? [v] : [];
}
