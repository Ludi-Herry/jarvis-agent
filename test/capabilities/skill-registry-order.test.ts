import { describe, it, expect, vi } from 'vitest';

// Mock readdir to hand back entries in a DELIBERATELY non-sorted order, so the test actually bites:
// a real-FS test can't prove the sort on NTFS (which already returns entries name-sorted). readFile
// returns a minimal SKILL.md whose name echoes the folder, so loadSkills produces one skill each.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(async () =>
      ['charlie', 'bravo', 'alpha'].map((name) => ({
        name,
        isDirectory: () => true,
        isFile: () => false,
      })),
    ),
    readFile: vi.fn(async (p: string) => {
      const name = /([^/\\]+)[/\\]SKILL\.md$/.exec(String(p))?.[1] ?? 'unknown';
      return `---\nname: ${name}\ndescription: d\ntriggers: []\n---\nbody`;
    }),
  };
});

import { loadSkills } from '../../src/capabilities/skills/skill-registry.js';

describe('loadSkills ordering', () => {
  it('sorts skills by folder name regardless of the order readdir returns them', async () => {
    const skills = await loadSkills('/any');
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'bravo', 'charlie']); // readdir gave c,b,a
  });
});
