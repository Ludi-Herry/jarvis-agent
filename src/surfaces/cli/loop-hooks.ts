import type { HookRunner } from '../../capabilities/index.js';

export type LoadHookRunnerForGoal = (hookPath: string, index: number) => Promise<HookRunner | undefined>;

export function createGoalHookResolver(input: {
  globalHooks?: HookRunner;
  hookPathByIndex: Map<number, string>;
  load: LoadHookRunnerForGoal;
}): (index: number) => Promise<HookRunner | undefined> {
  const cache = new Map<string, HookRunner>();

  return async (index) => {
    const hookPath = input.hookPathByIndex.get(index);
    if (hookPath === undefined) return input.globalHooks;

    const cached = cache.get(hookPath);
    if (cached !== undefined) return cached;

    const hooks = await input.load(hookPath, index);
    if (hooks === undefined) throw new Error(`hook map index ${index} produced no hooks: ${hookPath}`);
    cache.set(hookPath, hooks);
    return hooks;
  };
}

export async function preloadGoalHookOverrides(
  resolveHooks: (index: number) => Promise<HookRunner | undefined>,
  indexes: Iterable<number>,
): Promise<void> {
  for (const index of indexes) await resolveHooks(index);
}
