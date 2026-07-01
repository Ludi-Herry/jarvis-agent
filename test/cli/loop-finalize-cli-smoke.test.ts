import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  it('cancels merge mode unless the exact confirmation phrase is typed', async () => {
    const fixture = await setupMergeFixture('L-cancel-merge');
    try {
      const result = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--merge'], fixture.cwd, 'yes\n');

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('cancelled');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('applies a confirmed merge proposal from a verified worktree and writes audit JSONL', async () => {
    const fixture = await setupMergeFixture('L-apply-merge');
    try {
      const result = await runFinalizeCli(
        ['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--merge'],
        fixture.cwd,
        `merge ${fixture.loopId}\n`,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('merge-applied');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\nworktree\n');
      const audit = await readFile(join(fixture.cwd, 'data', 'loops', `${fixture.loopId}.finalize.jsonl`), 'utf8');
      expect(audit).toContain('"t":"merge-confirmed"');
      expect(audit).toContain('"t":"merge-applied"');
      expect(audit).toContain('"index":0');
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops a confirmed merge when the main cwd is dirty', async () => {
    const fixture = await setupMergeFixture('L-main-dirty');
    try {
      await writeFile(join(fixture.cwd, 'manual.txt'), 'draft\n', 'utf8');

      const result = await runFinalizeCli(
        ['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--merge'],
        fixture.cwd,
        `merge ${fixture.loopId}\n`,
      );

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('main cwd is dirty');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('prints a parked report when the verified worktree is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-finalize-cwd-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'jarvis-finalize-worktrees-'));
    try {
      const loopId = 'L-missing-worktree';
      await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
      await writeLoopLog(cwd, loopId);

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
      await writeLoopLog(cwd, loopId);
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

async function setupMergeFixture(loopId: string): Promise<{
  cwd: string;
  worktreeRoot: string;
  loopId: string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-finalize-cwd-'));
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'jarvis-finalize-worktrees-'));
  try {
    await runGit(cwd, ['init']);
    await runGit(cwd, ['config', 'user.name', 'Jarvis Test']);
    await runGit(cwd, ['config', 'user.email', 'jarvis@example.test']);
    await runGit(cwd, ['config', 'core.autocrlf', 'false']);
    await writeFile(join(cwd, '.gitignore'), '/data/\n', 'utf8');
    await writeFile(join(cwd, 'file.txt'), 'base\n', 'utf8');
    await runGit(cwd, ['add', '.gitignore', 'file.txt']);
    await runGit(cwd, ['commit', '-m', 'init']);

    const worktreePath = join(worktreeRoot, loopId, 'g0');
    await mkdir(dirname(worktreePath), { recursive: true });
    await runGit(cwd, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
    await writeFile(join(worktreePath, 'file.txt'), 'base\nworktree\n', 'utf8');
    await writeLoopLog(cwd, loopId);

    return {
      cwd,
      worktreeRoot,
      loopId,
      cleanup: async () => {
        await rm(cwd, { recursive: true, force: true });
        await rm(worktreeRoot, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await rm(cwd, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
    throw err;
  }
}

async function writeLoopLog(cwd: string, loopId: string): Promise<void> {
  await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
  await writeFile(
    join(cwd, 'data', 'loops', `${loopId}.jsonl`),
    serializeLoopRecord({ t: 'loop-created', id: loopId, contract: CONTRACT, objectives: ['inspect README'], createdAt: 't0' }) +
      serializeLoopRecord({ t: 'goal-started', index: 0, goalId: 'g0', at: 't1' }) +
      serializeLoopRecord({ t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't2' }),
    'utf8',
  );
}

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

function runFinalizeCli(args: string[], cwd: string, input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  child.stdin?.end(input);

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

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${output}`));
    });
  });
}
