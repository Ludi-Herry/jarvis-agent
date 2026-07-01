import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertWorktreeRootOutsideCwd, createGoalWorktree } from '../../../src/capabilities/goal/index.js';
import type { ExecResult } from '../../../src/core/tools/run-command.js';

const ok: ExecResult = { output: '', code: 0, timedOut: false, aborted: false, truncated: false };

describe('loop worktree helpers', () => {
  it('rejects a worktree root inside the repository cwd', async () => {
    const repo = resolve('C:/repo/project');
    await expect(assertWorktreeRootOutsideCwd(join(repo, 'data', 'worktrees'), repo)).rejects.toThrow(/outside/i);
  });

  it('normalizes symlink roots before applying the cwd boundary', async () => {
    const base = await mkdtemp(join(tmpdir(), 'jarvis-worktree-'));
    const repo = join(base, 'repo');
    const outside = join(base, 'outside');
    const link = join(outside, 'repo-link');
    await mkdir(repo, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(repo, link, 'junction');

    await expect(assertWorktreeRootOutsideCwd(join(link, 'parallel'), repo)).rejects.toThrow(/outside/i);
  });

  it('creates a detached git worktree under an outside root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'jarvis-worktree-'));
    const repo = join(base, 'repo');
    const root = join(base, 'worktrees');
    const calls: Array<{ command: string; cwd: string }> = [];
    await mkdir(repo, { recursive: true });

    const path = await createGoalWorktree({
      shellPath: 'bash',
      cwd: repo,
      root,
      loopId: 'loop:one',
      index: 2,
      runCommand: async (_shellPath, command, cwd): Promise<ExecResult> => {
        calls.push({ command, cwd });
        return ok;
      },
    });

    expect(path).toBe(join(root, 'loop_one', 'g2'));
    expect(calls).toEqual([{ cwd: repo, command: expect.stringContaining('git worktree add --detach') }]);
    expect(calls[0].command).toContain('HEAD');
  });
});
