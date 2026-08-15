import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('loop CLI unattended worktree write wiring', () => {
  it('injects the write root only into per-goal parallel gates', async () => {
    const source = await readFile('src/surfaces/cli/loop-cli.ts', 'utf8');

    const sharedGate = source.indexOf('const gate = new DefaultPermissionGate({ approver })');
    const goalCwd = source.indexOf('const goalCwd = await goalCwdFor');
    const goalGate = source.indexOf('const goalGate = headless');
    const headlessApprover = source.indexOf('approver: createApprovalEventApprover({', goalGate);
    const headlessSession = source.indexOf('sessionId: goalId', headlessApprover);
    const parallelGate = source.indexOf(': parallelMode', goalGate);
    const worktreeWriteRoot = source.indexOf('goalWorktreeWriteRoot: effectiveUnattended ? goalCwd : undefined', parallelGate);
    const runGoalGate = source.indexOf('gate: goalGate');
    const goalRunCwd = source.indexOf('cwd: goalCwd');

    for (const index of [
      sharedGate, goalCwd, goalGate, headlessApprover, headlessSession,
      parallelGate, worktreeWriteRoot, runGoalGate, goalRunCwd,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(goalGate).toBeGreaterThan(goalCwd);
    expect(headlessApprover).toBeGreaterThan(goalGate);
    expect(headlessSession).toBeGreaterThan(headlessApprover);
    expect(worktreeWriteRoot).toBeGreaterThan(parallelGate);
    expect(goalGate).toBeLessThan(runGoalGate);
  });
});
