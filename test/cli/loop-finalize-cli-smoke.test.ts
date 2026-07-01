import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeLoopRecord, type LoopContract } from '../../src/capabilities/goal/index.js';

const CONTRACT: LoopContract = {
  maxGoals: 2,
  maxTotalTokens: 1000,
  maxWallClockMs: 60_000,
  maxConsecutiveBlocked: 3,
  cnvWindow: 3,
  cnvThreshold: 3,
  perGoalBudget: { maxRounds: 1 },
};

describe('loop finalize CLI smoke', () => {
  it('rejects merge mode as report-only without touching files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-finalize-cwd-'));
    try {
      await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
      const sentinel = join(cwd, 'sentinel.txt');
      await writeFile(sentinel, 'keep', 'utf8');

      const result = await runFinalizeCli(['--loop', 'L1', '--merge'], cwd);

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('report-only');
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prints a parked report when the verified worktree is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-finalize-cwd-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'jarvis-finalize-worktrees-'));
    try {
      const loopId = 'L-missing-worktree';
      await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
      await writeFile(
        join(cwd, 'data', 'loops', `${loopId}.jsonl`),
        serializeLoopRecord({ t: 'loop-created', id: loopId, contract: CONTRACT, objectives: ['inspect README'], createdAt: 't0' }) +
          serializeLoopRecord({ t: 'goal-started', index: 0, goalId: 'g0', at: 't1' }) +
          serializeLoopRecord({ t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't2' }),
        'utf8',
      );

      const before = await listTree(cwd);
      const result = await runFinalizeCli(['--loop', loopId, '--worktree-root', worktreeRoot], cwd);
      const after = await listTree(cwd);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Loop finalize report');
      expect(result.stdout).toContain('park');
      expect(result.stdout).toContain('missing-worktree');
      expect(result.stdout).toContain('Merge proposals: 0');
      expect(after).toEqual(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a goal worktree path resolves back inside cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-finalize-cwd-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'jarvis-finalize-worktrees-'));
    try {
      const loopId = 'L-symlink-worktree';
      await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
      await writeFile(
        join(cwd, 'data', 'loops', `${loopId}.jsonl`),
        serializeLoopRecord({ t: 'loop-created', id: loopId, contract: CONTRACT, objectives: ['inspect README'], createdAt: 't0' }) +
          serializeLoopRecord({ t: 'goal-started', index: 0, goalId: 'g0', at: 't1' }) +
          serializeLoopRecord({ t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't2' }),
        'utf8',
      );
      await mkdir(join(worktreeRoot, loopId), { recursive: true });
      await symlink(cwd, join(worktreeRoot, loopId, 'g0'), 'junction');

      const result = await runFinalizeCli(['--loop', loopId, '--worktree-root', worktreeRoot], cwd);

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('must stay outside');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });
});

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      out.push(path.slice(root.length + 1).replace(/\\/g, '/'));
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return out.sort();
}

function runFinalizeCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.ARK_API_KEY;
  const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli/loop-finalize-cli.ts'), ...args], {
    cwd,
    env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('loop finalize CLI timed out'));
    }, 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}
