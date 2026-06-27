import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry, loadSkills } from '../../src/capabilities/skills/skill-registry.js';

let dir: string;

async function writeSkill(name: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-skills-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadSkills', () => {
  it('parses each skill folder; falls back to the folder name when name is absent', async () => {
    await writeSkill(
      'git-commit',
      'name: git-commit\ndescription: write a commit\ntriggers: [commit, 提交]',
      'COMMIT BODY',
    );
    const skills = await loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: 'git-commit',
      description: 'write a commit',
      triggers: ['commit', '提交'],
      body: 'COMMIT BODY',
    });
  });

  it('returns [] for a missing directory and skips folders without SKILL.md', async () => {
    expect(await loadSkills(join(dir, 'does-not-exist'))).toEqual([]);
    await mkdir(join(dir, 'empty-folder'), { recursive: true });
    expect(await loadSkills(dir)).toEqual([]);
  });
});

describe('SkillRegistry', () => {
  it('catalog lists name: description; empty registry yields an empty string', async () => {
    expect(new SkillRegistry([]).catalog()).toBe('');
    await writeSkill('git-commit', 'name: git-commit\ndescription: write a commit\ntriggers: [commit]', 'B');
    const reg = await SkillRegistry.load(dir);
    expect(reg.catalog()).toContain('git-commit: write a commit');
  });

  it('activates a skill only when a trigger appears in the message (case-insensitive)', async () => {
    await writeSkill('git-commit', 'name: git-commit\ndescription: d\ntriggers: [commit, 提交]', 'B');
    const reg = await SkillRegistry.load(dir);
    expect(reg.activate('帮我写个 COMMIT message').map((s) => s.name)).toEqual(['git-commit']);
    expect(reg.activate('帮我提交代码').map((s) => s.name)).toEqual(['git-commit']);
    expect(reg.activate('今天天气怎么样')).toEqual([]);
  });

  it('discloses the body only for a relevant message — the §5.6 token difference', async () => {
    await writeSkill(
      'git-commit',
      'name: git-commit\ndescription: write a commit\ntriggers: [commit]',
      'FULL-COMMIT-RULES-BODY',
    );
    const reg = await SkillRegistry.load(dir);

    const relevant = reg.systemAddendum('help me write a commit message');
    const unrelated = reg.systemAddendum('what is the weather today');

    // both carry the cheap L1 catalog…
    expect(relevant).toContain('git-commit: write a commit');
    expect(unrelated).toContain('git-commit: write a commit');
    // …but only the relevant turn pays for the expensive L2 body
    expect(relevant).toContain('FULL-COMMIT-RULES-BODY');
    expect(unrelated).not.toContain('FULL-COMMIT-RULES-BODY');
    expect(relevant.length).toBeGreaterThan(unrelated.length);
  });

  it('yields an empty addendum when no skills are installed (folds in harmlessly)', () => {
    expect(new SkillRegistry([]).systemAddendum('write a commit')).toBe('');
  });
});
