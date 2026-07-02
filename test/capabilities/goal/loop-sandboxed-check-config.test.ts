import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function moduleUnderTest(): Promise<Record<string, unknown>> {
  return import('../../../src/capabilities/goal/sandboxed-check-config.js') as Promise<Record<string, unknown>>;
}

describe('loop sandbox check map', () => {
  it('parses per-index trusted sandbox checks and builds per-goal plans', async () => {
    const mod = await moduleUnderTest();
    const parseLoopSandboxCheckMap = mod.parseLoopSandboxCheckMap as (text: string) => {
      goals: Array<{ index: number; requirements: Array<{ id: string; text: string; command?: string }> }>;
    };
    const buildLoopSandboxCheckPlan = mod.buildLoopSandboxCheckPlan as (input: {
      objectivesCount: number;
      map?: { goals: Array<{ index: number; requirements: Array<{ id: string; text: string; command?: string }> }> };
    }) => {
      pinnedByIndex: Map<number, Array<{ id: string; text: string }>>;
      commandsByIndex: Map<number, Array<{ requirementId: string; command: string }>>;
      overrideCount: number;
    };

    const map = parseLoopSandboxCheckMap(
      JSON.stringify({
        goals: [
          {
            index: 0,
            requirements: [
              { id: 'r1', text: 'package exists', command: 'stat package.json' },
              { id: 'r2', text: 'human-only visual check' },
            ],
          },
          {
            index: 2,
            requirements: [{ id: 'r3', text: 'readme count', command: 'wc -l README.md' }],
          },
        ],
      }),
    );

    const plan = buildLoopSandboxCheckPlan({ objectivesCount: 3, map });

    expect(plan.overrideCount).toBe(2);
    expect(plan.pinnedByIndex.get(0)).toEqual([
      { id: 'r1', text: 'package exists' },
      { id: 'r2', text: 'human-only visual check' },
    ]);
    expect(plan.commandsByIndex.get(0)).toEqual([{ requirementId: 'r1', command: 'stat package.json' }]);
    expect(plan.commandsByIndex.get(2)).toEqual([{ requirementId: 'r3', command: 'wc -l README.md' }]);
    expect(plan.pinnedByIndex.has(1)).toBe(false);
  });

  it('rejects unsafe commands, duplicate indexes, and out-of-range indexes', async () => {
    const mod = await moduleUnderTest();
    const parseLoopSandboxCheckMap = mod.parseLoopSandboxCheckMap as (text: string) => unknown;
    const buildLoopSandboxCheckPlan = mod.buildLoopSandboxCheckPlan as (input: {
      objectivesCount: number;
      map?: { goals: Array<{ index: number; requirements: Array<{ id: string; text: string; command?: string }> }> };
    }) => unknown;

    expect(() =>
      parseLoopSandboxCheckMap(
        JSON.stringify({
          goals: [{ index: 0, requirements: [{ id: 'r1', text: 'unsafe', command: 'touch proof' }] }],
        }),
      ),
    ).toThrow(/outside sandbox inspection scope/);
    expect(() =>
      parseLoopSandboxCheckMap(
        JSON.stringify({
          goals: [
            { index: 1, requirements: [{ id: 'r1', text: 'a' }] },
            { index: 1, requirements: [{ id: 'r2', text: 'b' }] },
          ],
        }),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      buildLoopSandboxCheckPlan({
        objectivesCount: 1,
        map: { goals: [{ index: 2, requirements: [{ id: 'r1', text: 'a' }] }] },
      }),
    ).toThrow(/out of range/);
  });

  it('loads a trusted map outside cwd and refuses repo-controlled maps', async () => {
    const mod = await moduleUnderTest();
    const loadLoopSandboxCheckMap = mod.loadLoopSandboxCheckMap as (deps: {
      path: string;
      cwd: string;
      readText: (path: string) => Promise<string | null>;
      realpath?: (path: string) => Promise<string | null>;
    }) => Promise<{ path: string; goals: Array<{ index: number }> }>;

    const cwd = join(tmpdir(), 'jarvis-loop-sandbox-repo');
    const outside = join(tmpdir(), 'loop-sandbox-checks.json');
    const inside = join(cwd, 'loop-sandbox-checks.json');
    const text = JSON.stringify({
      goals: [{ index: 0, requirements: [{ id: 'r1', text: 'status', command: 'git status --short' }] }],
    });

    await expect(
      loadLoopSandboxCheckMap({
        path: outside,
        cwd,
        readText: async (p) => (p === resolve(outside) ? text : null),
        realpath: async (p) => resolve(p),
      }),
    ).resolves.toMatchObject({ path: resolve(outside), goals: [{ index: 0 }] });

    await expect(
      loadLoopSandboxCheckMap({
        path: outside,
        cwd,
        readText: async () => text,
        realpath: async (p) => (p === outside ? inside : resolve(p)),
      }),
    ).rejects.toThrow(/forbidden working tree|working directory/);
  });

  it('requires the same trusted sandbox-check-map on resume', async () => {
    const mod = await moduleUnderTest();
    const assertResumeSandboxCheckMapMatches = mod.assertResumeSandboxCheckMapMatches as (
      recordedPath: string | undefined,
      currentPath: string | undefined,
    ) => void;

    expect(() => assertResumeSandboxCheckMapMatches(undefined, undefined)).toThrow(/resume requires --sandbox-check-map/);
    expect(() => assertResumeSandboxCheckMapMatches('C:\\trusted\\map.json', undefined)).toThrow(/requires --sandbox-check-map/);
    expect(() => assertResumeSandboxCheckMapMatches('C:\\trusted\\map-a.json', 'C:\\trusted\\map-b.json')).toThrow(/does not match/);
    expect(() => assertResumeSandboxCheckMapMatches(undefined, 'C:\\trusted\\empty-map.json')).not.toThrow();
  });
});
