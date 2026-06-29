import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRole,
  loadRoster,
  rosterCatalog,
  type AgentRole,
} from '../../../src/capabilities/subagents/roster.js';

let dir: string;

async function writeRole(name: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'ROLE.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-roster-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadRoster', () => {
  it('parses a role: frontmatter fields + markdown body as systemPrompt', async () => {
    await writeRole(
      'researcher',
      [
        'name: researcher',
        'description: dig through the codebase and report a summary',
        'model: doubao-seed-2.1-pro',
        'reasoningEffort: low',
        'capability: [read-only]',
        'tools: [read, grep]',
        'isolation: read-only',
        'maxTurns: 8',
      ].join('\n'),
      'You are a focused researcher. Return a concise summary.',
    );
    const roles = await loadRoster(dir);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toEqual({
      name: 'researcher',
      description: 'dig through the codebase and report a summary',
      systemPrompt: 'You are a focused researcher. Return a concise summary.',
      model: 'doubao-seed-2.1-pro',
      reasoningEffort: 'low',
      capability: ['read-only'],
      tools: ['read', 'grep'],
      isolation: 'read-only',
      maxTurns: 8,
    } satisfies AgentRole);
  });

  it('falls back to the folder name when name is absent, and leaves optionals undefined', async () => {
    await writeRole('helper', 'description: a helper', 'BODY');
    const [role] = await loadRoster(dir);
    expect(role.name).toBe('helper');
    expect(role.systemPrompt).toBe('BODY');
    expect(role.model).toBeUndefined();
    expect(role.capability).toBeUndefined();
    expect(role.maxTurns).toBeUndefined();
  });

  it('drops invalid enum values rather than trusting them', async () => {
    await writeRole(
      'bad',
      [
        'description: d',
        'reasoningEffort: ludicrous', // not a ThinkingEffort
        'capability: [read-only, sudo, network]', // sudo is bogus
        'isolation: yolo', // not an Isolation
        'maxTurns: -3', // not a positive int
      ].join('\n'),
      'B',
    );
    const [role] = await loadRoster(dir);
    expect(role.reasoningEffort).toBeUndefined();
    expect(role.capability).toEqual(['read-only', 'network']); // bogus 'sudo' filtered out
    expect(role.isolation).toBeUndefined();
    expect(role.maxTurns).toBeUndefined();
  });

  it('returns [] for a missing directory and skips folders without ROLE.md', async () => {
    expect(await loadRoster(join(dir, 'does-not-exist'))).toEqual([]);
    await mkdir(join(dir, 'empty-folder'), { recursive: true });
    expect(await loadRoster(dir)).toEqual([]);
  });

  it('sorts roles by folder name for a stable order', async () => {
    await writeRole('zeta', 'description: z', 'Z');
    await writeRole('alpha', 'description: a', 'A');
    expect((await loadRoster(dir)).map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('rosterCatalog / findRole', () => {
  const roles: AgentRole[] = [
    { name: 'researcher', description: 'dig and summarize', systemPrompt: 'p1' },
    { name: 'critic', description: 'find flaws', systemPrompt: 'p2' },
  ];

  it('rosterCatalog lists name: description per line', () => {
    expect(rosterCatalog(roles)).toBe('- researcher: dig and summarize\n- critic: find flaws');
    expect(rosterCatalog([])).toBe('');
  });

  it('findRole returns the exact match or undefined', () => {
    expect(findRole(roles, 'critic')?.systemPrompt).toBe('p2');
    expect(findRole(roles, 'missing')).toBeUndefined();
  });
});
