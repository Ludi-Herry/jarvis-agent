import { describe, expect, it } from 'vitest';
import { createGoalHookResolver, preloadGoalHookOverrides } from '../../src/surfaces/cli/loop-hooks.js';
import type { HookRunner } from '../../src/capabilities/index.js';

const globalHooks = fakeHooks();
const goalHooks = fakeHooks();

describe('createGoalHookResolver', () => {
  it('uses global hooks when a goal has no per-goal override', async () => {
    const resolveHooks = createGoalHookResolver({
      globalHooks,
      hookPathByIndex: new Map([[1, 'C:\\trusted\\goal-hooks.json']]),
      load: async () => goalHooks,
    });

    await expect(resolveHooks(0)).resolves.toBe(globalHooks);
    await expect(resolveHooks(1)).resolves.toBe(goalHooks);
  });

  it('caches per-goal hook runners by hook path', async () => {
    let loads = 0;
    const resolveHooks = createGoalHookResolver({
      hookPathByIndex: new Map([
        [0, 'C:\\trusted\\shared-hooks.json'],
        [1, 'C:\\trusted\\shared-hooks.json'],
      ]),
      load: async () => {
        loads++;
        return goalHooks;
      },
    });

    await expect(resolveHooks(0)).resolves.toBe(goalHooks);
    await expect(resolveHooks(1)).resolves.toBe(goalHooks);
    expect(loads).toBe(1);
  });

  it('fails closed when an explicit per-goal hook path resolves to no hooks', async () => {
    const resolveHooks = createGoalHookResolver({
      hookPathByIndex: new Map([[0, 'C:\\trusted\\empty-hooks.json']]),
      load: async () => undefined,
    });

    await expect(resolveHooks(0)).rejects.toThrow(/produced no hooks/);
  });

  it('preloads every per-goal override so malformed hook configs fail before loop state is written', async () => {
    const loaded: number[] = [];
    const resolveHooks = createGoalHookResolver({
      hookPathByIndex: new Map([
        [0, 'C:\\trusted\\a.json'],
        [2, 'C:\\trusted\\b.json'],
      ]),
      load: async (_path, index) => {
        loaded.push(index);
        return goalHooks;
      },
    });

    await preloadGoalHookOverrides(resolveHooks, [0, 2]);

    expect(loaded).toEqual([0, 2]);
  });

  it('fails closed while preloading a bad per-goal hook runner', async () => {
    const resolveHooks = createGoalHookResolver({
      hookPathByIndex: new Map([[0, 'C:\\trusted\\bad.json']]),
      load: async () => undefined,
    });

    await expect(preloadGoalHookOverrides(resolveHooks, [0])).rejects.toThrow(/produced no hooks/);
  });
});

function fakeHooks(): HookRunner {
  return {
    preToolUse: async () => ({ blocked: false, reason: '' }),
    postToolUse: async () => undefined,
    roundStart: async () => undefined,
    roundEnd: async () => undefined,
    sessionStart: async () => undefined,
    sessionEnd: async () => undefined,
  };
}
