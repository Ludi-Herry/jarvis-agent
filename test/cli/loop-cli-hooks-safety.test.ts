import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('loop CLI per-goal hooks wiring', () => {
  it('loads a trusted hook-map, records it in the loop header, and passes selected hooks into runGoal', async () => {
    const source = await readFile('src/surfaces/cli/loop-cli.ts', 'utf8');

    expect(source).toContain('loadLoopHookMap');
    expect(source).toContain('buildLoopHookPlan');
    expect(source).toContain('assertResumeHookMapMatches');
    expect(source).toContain('preloadGoalHookOverrides');
    expect(source).toContain('hookMapPath: hookMap?.path');
    expect(source).toContain('createGoalHookResolver');
    expect(source).toContain('const goalHooks = await hooksForGoal(attempt.index)');
    expect(source).toContain('const goalHookOverride = hookPlan.hookPathByIndex.has(attempt.index)');
    expect(source).toContain('userHooksPath: false');
    expect(source).toContain('await runAdvisoryHook(goalHookOverride ? goalHooks?.sessionStart : undefined)');
    expect(source).toContain('await runAdvisoryHook(goalHookOverride ? goalHooks?.sessionEnd : undefined)');
    expect(source).toContain('hooks: goalHooks');
  });

  it('keeps parallel mode incompatible with any configured per-goal hook override', async () => {
    const source = await readFile('src/surfaces/cli/loop-cli.ts', 'utf8');

    expect(source).toContain('hookPlan.overrideCount > 0');
    expect(source).toContain('assertParallelHooksCompatible');
    expect(source.indexOf('assertParallelHooksCompatible(parallelMode')).toBeLessThan(source.indexOf('await loopStore.writeCreated'));
    expect(source.indexOf('await preloadGoalHookOverrides')).toBeLessThan(source.indexOf('await loopStore.writeCreated'));
  });
});
