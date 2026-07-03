import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertResumeGoalSetterRequirementsMatch,
  buildLoopGoalSetterRequirementsPlan,
  loadGoalSetterRequirementsPlan,
  loadLoopGoalSetterRequirementsMap,
  parseGoalSetterRequirementsPlan,
  parseLoopGoalSetterRequirementsMap,
} from '../../../src/capabilities/goal/goal-setter-requirements.js';

describe('goal-setter-authored requirements', () => {
  it('parses versioned requirements with sandbox, llm, and human routes', () => {
    const plan = parseGoalSetterRequirementsPlan(
      JSON.stringify({
        version: 1,
        heldOutCommands: ['node C:/trusted/assert-copy.js'],
        requirements: [
          { id: 'r1', text: 'status is inspectable', route: 'sandbox-command', command: 'git status --short' },
          { id: 'r2', text: 'copy reads clearly', route: 'llm' },
          { id: 'r3', text: 'operator approves visual polish', route: 'human' },
        ],
      }),
    );

    expect(plan).toEqual({
      version: 1,
      heldOutCommands: ['node C:/trusted/assert-copy.js'],
      requirements: [
        { id: 'r1', text: 'status is inspectable', route: 'sandbox-command', command: 'git status --short' },
        { id: 'r2', text: 'copy reads clearly', route: 'llm' },
        { id: 'r3', text: 'operator approves visual polish', route: 'human' },
      ],
    });
  });

  it('rejects invalid route and command combinations', () => {
    expect(() => parseGoalSetterRequirementsPlan(JSON.stringify({ version: 1, requirements: [] }))).toThrow(
      /requirements must not be empty/,
    );
    expect(() =>
      parseGoalSetterRequirementsPlan(
        JSON.stringify({ version: 1, requirements: [{ id: 'r1', text: 'bad', route: 'sandbox-command' }] }),
      ),
    ).toThrow(/command is required/);
    expect(() =>
      parseGoalSetterRequirementsPlan(
        JSON.stringify({ version: 1, requirements: [{ id: 'r1', text: 'bad', route: 'llm', command: 'git status --short' }] }),
      ),
    ).toThrow(/command is only allowed/);
    expect(() =>
      parseGoalSetterRequirementsPlan(
        JSON.stringify({ version: 1, requirements: [{ id: 'r1', text: 'bad', route: 'human', command: 'git status --short' }] }),
      ),
    ).toThrow(/command is only allowed/);
    expect(() =>
      parseGoalSetterRequirementsPlan(
        JSON.stringify({ version: 1, requirements: [{ id: 'r1', text: 'bad', route: 'sandbox-command', command: 'touch proof' }] }),
      ),
    ).toThrow(/outside sandbox inspection scope/);
    expect(() =>
      parseGoalSetterRequirementsPlan(
        JSON.stringify({
          version: 1,
          requirements: [
            { id: 'r1', text: 'a', route: 'human' },
            { id: 'r1', text: 'b', route: 'human' },
          ],
        }),
      ),
    ).toThrow(/duplicate/);
  });

  it('loads a trusted plan outside cwd, hashes normalized text, and rejects repo-controlled plans', async () => {
    const cwd = join(tmpdir(), 'jarvis-goal-setter-repo');
    const outside = join(tmpdir(), 'goal-setter-requirements.json');
    const inside = join(cwd, 'goal-setter-requirements.json');
    const text =
      '\uFEFF' +
      JSON.stringify({
        version: 1,
        heldOutCommands: ['node C:/trusted/assert-copy.js'],
        requirements: [
          { id: 'r1', text: 'status is inspectable', route: 'sandbox-command', command: 'git status --short' },
          { id: 'r2', text: 'copy reads clearly', route: 'llm' },
          { id: 'r3', text: 'operator approves visual polish', route: 'human' },
        ],
      });

    const loaded = await loadGoalSetterRequirementsPlan({
      path: outside,
      cwd,
      readText: async (p) => (p === resolve(outside) ? text : null),
      realpath: async (p) => resolve(p),
    });

    expect(loaded.path).toBe(resolve(outside));
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.hash).toBe(
      '720f17c9f0198b27640b0984da5b34b4c4f7a0980a3fc6219744911234486983',
    );
    expect(loaded.pinned).toEqual([
      { id: 'r1', text: 'status is inspectable', route: 'sandbox-command' },
      { id: 'r2', text: 'copy reads clearly', route: 'llm' },
      { id: 'r3', text: 'operator approves visual polish', route: 'human' },
    ]);
    expect(loaded.commands).toEqual([{ requirementId: 'r1', command: 'git status --short' }]);
    expect(loaded.heldOutCommands).toEqual(['node C:/trusted/assert-copy.js']);
    expect(loaded.routes.get('r1')).toBe('sandbox-command');
    expect(loaded.routes.get('r2')).toBe('llm');
    expect(loaded.routes.get('r3')).toBe('human');

    await expect(
      loadGoalSetterRequirementsPlan({
        path: outside,
        cwd,
        readText: async () => text,
        realpath: async (p) => (p === outside ? inside : resolve(p)),
      }),
    ).rejects.toThrow(/forbidden working tree|working directory/);
  });

  it('parses loop maps and builds per-goal route plans', () => {
    const map = parseLoopGoalSetterRequirementsMap(
      JSON.stringify({
        version: 1,
        goals: [
          {
            index: 0,
            heldOutCommands: ['node C:/trusted/assert-goal-0.js'],
            requirements: [
              { id: 'r1', text: 'status is inspectable', route: 'sandbox-command', command: 'git status --short' },
              { id: 'r2', text: 'copy reads clearly', route: 'llm' },
            ],
          },
          { index: 2, requirements: [{ id: 'r3', text: 'operator approves visual polish', route: 'human' }] },
        ],
      }),
    );

    const plan = buildLoopGoalSetterRequirementsPlan({ objectivesCount: 3, map });

    expect(plan.overrideCount).toBe(2);
    expect(plan.pinnedByIndex.get(0)).toEqual([
      { id: 'r1', text: 'status is inspectable', route: 'sandbox-command' },
      { id: 'r2', text: 'copy reads clearly', route: 'llm' },
    ]);
    expect(plan.commandsByIndex.get(0)).toEqual([{ requirementId: 'r1', command: 'git status --short' }]);
    expect(plan.heldOutCommandsByIndex.get(0)).toEqual(['node C:/trusted/assert-goal-0.js']);
    expect(plan.routesByIndex.get(2)?.get('r3')).toBe('human');
    expect(plan.pinnedByIndex.get(2)).toEqual([
      { id: 'r3', text: 'operator approves visual polish', route: 'human' },
    ]);
    expect(() =>
      buildLoopGoalSetterRequirementsPlan({ objectivesCount: 1, map: { version: 1, goals: [{ index: 2, requirements: [] }] } }),
    ).toThrow(/out of range/);
  });

  it('loads a trusted loop map outside cwd and computes a hash', async () => {
    const cwd = join(tmpdir(), 'jarvis-goal-setter-loop-repo');
    const outside = join(tmpdir(), 'goal-setter-loop-map.json');
    const text = JSON.stringify({
      version: 1,
      goals: [
        {
          index: 0,
          requirements: [{ id: 'r1', text: 'status is inspectable', route: 'sandbox-command', command: 'git status --short' }],
        },
      ],
    });

    const loaded = await loadLoopGoalSetterRequirementsMap({
      path: outside,
      cwd,
      readText: async (p) => (p === resolve(outside) ? text : null),
      realpath: async (p) => resolve(p),
    });

    expect(loaded.path).toBe(resolve(outside));
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.goals).toHaveLength(1);
  });

  it('fails closed when resume path or hash cannot prove the original trusted contract', () => {
    const recorded = { path: 'C:\\trusted\\requirements.json', hash: 'a'.repeat(64) };
    const same = { path: 'C:\\trusted\\requirements.json', hash: 'a'.repeat(64) };
    const differentPath = { path: 'C:\\trusted\\other.json', hash: 'a'.repeat(64) };
    const differentHash = { path: 'C:\\trusted\\requirements.json', hash: 'b'.repeat(64) };

    expect(() => assertResumeGoalSetterRequirementsMatch(undefined, undefined)).not.toThrow();
    expect(() => assertResumeGoalSetterRequirementsMatch(recorded, same)).not.toThrow();
    expect(() => assertResumeGoalSetterRequirementsMatch(recorded, undefined)).toThrow(/requires the same trusted/);
    expect(() => assertResumeGoalSetterRequirementsMatch(undefined, same)).toThrow(/missing original/);
    expect(() => assertResumeGoalSetterRequirementsMatch(recorded, differentPath)).toThrow(/path/);
    expect(() => assertResumeGoalSetterRequirementsMatch(recorded, differentHash)).toThrow(/hash/);
  });
});
