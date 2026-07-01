import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertResumeHookMapMatches,
  buildLoopHookPlan,
  loadLoopHookMap,
  parseLoopHookMap,
} from '../../../src/capabilities/goal/loop-hook-config.js';

describe('parseLoopHookMap', () => {
  it('parses strict per-index hook overrides', () => {
    expect(
      parseLoopHookMap(
        JSON.stringify({
          goals: [
            { index: 0, hookPath: 'C:\\trusted\\hooks-a.json' },
            { index: 2, hookPath: 'C:\\trusted\\hooks-b.json' },
          ],
        }),
      ),
    ).toEqual({
      goals: [
        { index: 0, hookPath: 'C:\\trusted\\hooks-a.json' },
        { index: 2, hookPath: 'C:\\trusted\\hooks-b.json' },
      ],
    });
  });

  it.each([
    ['bad json', 'not-json{'],
    ['top-level array', '[]'],
    ['unknown top-level key', JSON.stringify({ goals: [], extra: true })],
    ['missing goals', JSON.stringify({})],
    ['goals is not array', JSON.stringify({ goals: {} })],
    ['entry is not object', JSON.stringify({ goals: [1] })],
    ['unknown entry key', JSON.stringify({ goals: [{ index: 0, hookPath: 'C:\\trusted\\hooks.json', extra: true }] })],
    ['negative index', JSON.stringify({ goals: [{ index: -1, hookPath: 'C:\\trusted\\hooks.json' }] })],
    ['fractional index', JSON.stringify({ goals: [{ index: 1.5, hookPath: 'C:\\trusted\\hooks.json' }] })],
    ['blank hook path', JSON.stringify({ goals: [{ index: 1, hookPath: '   ' }] })],
    ['duplicate index', JSON.stringify({ goals: [{ index: 1, hookPath: 'a' }, { index: 1, hookPath: 'b' }] })],
  ])('throws for %s', (_label, text) => {
    expect(() => parseLoopHookMap(text)).toThrow();
  });
});

describe('loadLoopHookMap trust boundary', () => {
  const cwd = join(tmpdir(), 'jarvis-loop-repo');
  const mapOutside = join(tmpdir(), 'loop-hooks.json');
  const mapInside = join(cwd, 'loop-hooks.json');
  const hookOutside = join(tmpdir(), 'goal-hooks.json');
  const hookInside = join(cwd, 'goal-hooks.json');

  it('loads a trusted map and canonicalizes per-goal hook paths outside cwd', async () => {
    const loaded = await loadLoopHookMap({
      path: mapOutside,
      cwd,
      readText: async (p) =>
        p === resolve(mapOutside)
          ? JSON.stringify({ goals: [{ index: 0, hookPath: hookOutside }] })
          : null,
      realpath: async (p) => resolve(p),
    });

    expect(loaded).toEqual({
      path: resolve(mapOutside),
      goals: [{ index: 0, hookPath: resolve(hookOutside) }],
    });
  });

  it('refuses a map path that canonicalizes inside cwd', async () => {
    await expect(
      loadLoopHookMap({
        path: mapOutside,
        cwd,
        readText: async () => JSON.stringify({ goals: [] }),
        realpath: async (p) => (p === mapOutside ? mapInside : resolve(p)),
      }),
    ).rejects.toThrow(/inside the working directory/);
  });

  it('refuses a per-goal hook path that canonicalizes inside cwd', async () => {
    await expect(
      loadLoopHookMap({
        path: mapOutside,
        cwd,
        readText: async () => JSON.stringify({ goals: [{ index: 0, hookPath: hookOutside }] }),
        realpath: async (p) => (p === hookOutside ? hookInside : resolve(p)),
      }),
    ).rejects.toThrow(/hook path is inside the working directory/);
  });

  it('fails loudly when the explicit map or hook file cannot be resolved', async () => {
    await expect(
      loadLoopHookMap({
        path: mapOutside,
        cwd,
        readText: async () => null,
        realpath: async () => null,
      }),
    ).rejects.toThrow(/cannot be read/);

    await expect(
      loadLoopHookMap({
        path: mapOutside,
        cwd,
        readText: async () => JSON.stringify({ goals: [{ index: 0, hookPath: hookOutside }] }),
        realpath: async (p) => (p === mapOutside ? resolve(p) : null),
      }),
    ).rejects.toThrow(/hook path cannot be read/);
  });
});

describe('buildLoopHookPlan', () => {
  it('maps only configured goal indices and reports override count', () => {
    const plan = buildLoopHookPlan({
      objectivesCount: 3,
      map: { goals: [{ index: 1, hookPath: 'C:\\trusted\\hooks.json' }] },
    });

    expect(plan.overrideCount).toBe(1);
    expect(plan.hookPathByIndex.get(0)).toBeUndefined();
    expect(plan.hookPathByIndex.get(1)).toBe('C:\\trusted\\hooks.json');
    expect(plan.hookPathByIndex.get(2)).toBeUndefined();
  });

  it('fails closed when an override points past the objective queue', () => {
    expect(() =>
      buildLoopHookPlan({
        objectivesCount: 1,
        map: { goals: [{ index: 3, hookPath: 'C:\\trusted\\hooks.json' }] },
      }),
    ).toThrow(/out of range/);
  });
});

describe('assertResumeHookMapMatches', () => {
  it('fails closed when a loop created with hook-map is resumed without it', () => {
    expect(() => assertResumeHookMapMatches('C:\\trusted\\map.json', undefined)).toThrow(/requires --hook-map/);
  });

  it('fails closed when resume uses a different hook-map path', () => {
    expect(() => assertResumeHookMapMatches('C:\\trusted\\map-a.json', 'C:\\trusted\\map-b.json')).toThrow(/does not match/);
  });

  it('fails closed when resume has no recorded hook-map and no trusted current hook-map', () => {
    expect(() => assertResumeHookMapMatches(undefined, undefined)).toThrow(/resume requires --hook-map/);
  });

  it('allows resume with a trusted current hook-map when no hook-map was recorded', () => {
    expect(() => assertResumeHookMapMatches(undefined, 'C:\\trusted\\empty-map.json')).not.toThrow();
  });
});
