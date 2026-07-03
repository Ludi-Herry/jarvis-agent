import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('loop CLI unattended worktree write wiring', () => {
  it('injects the write root only into per-goal parallel gates', async () => {
    const source = await readFile('src/surfaces/cli/loop-cli.ts', 'utf8');

    expect(source).toContain('const gate = new DefaultPermissionGate({ approver })');
    expect(source).toContain('const goalGate = parallelMode');
    expect(source).toContain('goalWorktreeWriteRoot: unattended ? goalCwd : undefined');
    expect(source).toContain('gate: goalGate');
    expect(source).toContain('cwd: goalCwd');
    expect(source.indexOf('const goalGate = parallelMode')).toBeGreaterThan(source.indexOf('const goalCwd = await goalCwdFor'));
    expect(source.indexOf('goalWorktreeWriteRoot: unattended ? goalCwd : undefined')).toBeLessThan(source.indexOf('gate: goalGate'));
  });
});
