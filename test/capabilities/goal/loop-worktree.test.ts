import { lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertWorktreeRootOutsideCwd, createGoalWorktree, resolveExistingGoalWorktree } from '../../../src/capabilities/goal/index.js';
import { grepTool, readTool, writeTool } from '../../../src/core/tools/builtins.js';
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

  it('links host node_modules into a newly created goal worktree when dependencies exist', async () => {
    const base = await mkdtemp(join(tmpdir(), 'jarvis-worktree-'));
    const repo = join(base, 'repo');
    const root = join(base, 'worktrees');
    const expected = join(root, 'loop_one', 'g2');
    await mkdir(join(repo, 'node_modules'), { recursive: true });

    const path = await createGoalWorktree({
      shellPath: 'bash',
      cwd: repo,
      root,
      loopId: 'loop:one',
      index: 2,
      runCommand: async (): Promise<ExecResult> => {
        await mkdir(expected, { recursive: true });
        return ok;
      },
    });

    const linked = join(path, 'node_modules');
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await realpath(linked)).toBe(await realpath(join(repo, 'node_modules')));
  });

  it('does not let file tools follow the dependency link back into the host checkout', async () => {
    const base = await mkdtemp(join(tmpdir(), 'jarvis-worktree-'));
    const repo = join(base, 'repo');
    const root = join(base, 'worktrees');
    const expected = join(root, 'loop_one', 'g2');
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'host-only.txt'), 'host dependency data', 'utf8');

    const path = await createGoalWorktree({
      shellPath: 'bash',
      cwd: repo,
      root,
      loopId: 'loop:one',
      index: 2,
      runCommand: async (): Promise<ExecResult> => {
        await mkdir(expected, { recursive: true });
        return ok;
      },
    });

    const read = await readTool.run({ path: 'node_modules/host-only.txt' }, { cwd: path });
    const write = await writeTool.run({ path: 'node_modules/host-only.txt', content: 'pwned', createOnly: true }, { cwd: path });
    const grep = await grepTool.run({ pattern: 'host', path: 'node_modules' }, { cwd: path });

    expect(read.error).toMatch(/outside the project root/);
    expect(read.content).toBe('');
    expect(write.error).toMatch(/outside the project root/);
    expect(grep.error).toMatch(/outside the project root/);
  });

  it('resolves an existing goal worktree without creating a replacement on resume', async () => {
    const base = await mkdtemp(join(tmpdir(), 'jarvis-worktree-'));
    const repo = join(base, 'repo');
    const root = join(base, 'worktrees');
    const expected = join(root, 'loop_one', 'g2');
    await mkdir(repo, { recursive: true });
    await mkdir(expected, { recursive: true });

    await expect(resolveExistingGoalWorktree({ root, cwd: repo, loopId: 'loop:one', index: 2 })).resolves.toBe(expected);
  });

  it('fails closed when a resumed goal worktree is missing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'jarvis-worktree-'));
    const repo = join(base, 'repo');
    const root = join(base, 'worktrees');
    await mkdir(repo, { recursive: true });

    await expect(resolveExistingGoalWorktree({ root, cwd: repo, loopId: 'loop:one', index: 2 })).rejects.toThrow(/missing resumed worktree/);
  });
});
