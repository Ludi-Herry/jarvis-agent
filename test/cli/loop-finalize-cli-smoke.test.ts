import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashObjective, serializeGoalRecord, serializeLoopRecord, type LoopContract } from '../../src/capabilities/goal/index.js';
import { serializeRecord as serializeSessionRecord } from '../../src/runtime/session/session-store.js';

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
  }, 20_000);

  it('applies a confirmed merge proposal from a verified worktree and writes audit JSONL', async () => {
    const fixture = await setupMergeFixture('L-apply-merge');
    const externalDiffDir = await mkdtemp(join(tmpdir(), 'jarvis-external-diff-'));
    try {
      const marker = await installExternalDiffTrap(fixture.cwd, externalDiffDir);
      const result = await runFinalizeCli(
        ['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--merge'],
        fixture.cwd,
        `merge ${fixture.loopId}\n`,
      );

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('merge-applied');
      await expect(stat(marker)).rejects.toThrow();
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\nworktree\n');
      const audit = await readFile(join(fixture.cwd, 'data', 'loops', `${fixture.loopId}.finalize.jsonl`), 'utf8');
      expect(audit).toContain('"t":"merge-confirmed"');
      expect(audit).toContain('"t":"merge-applied"');
      expect(audit).toContain('"index":0');
    } finally {
      await fixture.cleanup();
      await rm(externalDiffDir, { recursive: true, force: true });
    }
  }, 20_000);

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

  it('cancels cleanup mode unless the exact confirmation phrase is typed', async () => {
    const fixture = await setupCleanWorktreeFixture('L-cancel-cleanup', { audit: true });
    try {
      const result = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--cleanup'], fixture.cwd, 'yes\n');

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('cleanup cancelled');
      await expect(stat(fixture.worktreePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes a clean audited worktree after cleanup confirmation and keeps logs', async () => {
    const fixture = await setupCleanWorktreeFixture('L-cleanup-remove', { audit: true });
    try {
      const loopLogPath = join(fixture.cwd, 'data', 'loops', `${fixture.loopId}.jsonl`);
      const auditPath = join(fixture.cwd, 'data', 'loops', `${fixture.loopId}.finalize.jsonl`);

      const result = await runFinalizeCli(
        ['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--cleanup'],
        fixture.cwd,
        `cleanup ${fixture.loopId}\n`,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('cleanup-removed');
      await expect(stat(fixture.worktreePath)).rejects.toThrow();
      await expect(readFile(loopLogPath, 'utf8')).resolves.toContain('"t":"loop-created"');
      const audit = await readFile(auditPath, 'utf8');
      expect(audit).toContain('"t":"merge-applied"');
      expect(audit).toContain('"t":"cleanup-confirmed"');
      expect(audit).toContain('"t":"cleanup-removed"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not remove a clean worktree without a merge-applied audit record', async () => {
    const fixture = await setupCleanWorktreeFixture('L-cleanup-no-audit', { audit: false });
    try {
      const result = await runFinalizeCli(
        ['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--cleanup'],
        fixture.cwd,
        `cleanup ${fixture.loopId}\n`,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cleanup candidates: 0');
      await expect(stat(fixture.worktreePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not remove an audited worktree that still has tracked changes', async () => {
    const fixture = await setupMergeFixture('L-cleanup-dirty');
    try {
      await writeFinalizeAudit(fixture.cwd, fixture.loopId, [
        { t: 'merge-applied', loopId: fixture.loopId, index: 0, goalId: 'g0', worktreePath: fixture.worktreePath, at: 't3' },
      ]);

      const result = await runFinalizeCli(
        ['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot, '--cleanup'],
        fixture.cwd,
        `cleanup ${fixture.loopId}\n`,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('dirty');
      expect(result.stdout).toContain('Cleanup candidates: 0');
      await expect(stat(fixture.worktreePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
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

  it('fails closed when the loop-created id does not match the requested loop file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-finalize-cwd-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'jarvis-finalize-worktrees-'));
    try {
      await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
      await writeFile(
        join(cwd, 'data', 'loops', 'L-file.jsonl'),
        serializeLoopRecord({ t: 'loop-created', id: 'L-header', contract: CONTRACT, objectives: ['inspect README'], createdAt: 't0' }),
        'utf8',
      );

      const result = await runFinalizeCli(['--loop', 'L-file', '--worktree-root', worktreeRoot], cwd);

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('loop log id mismatch');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('parks a forged verified goal log when recomputed verdict disagrees', async () => {
    const fixture = await setupMergeFixture('L-forged-goal-log');
    try {
      await writeForgedVerifiedGoalLog(fixture.cwd, 'g0');

      const result = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot], fixture.cwd);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('goal-mismatch');
      expect(result.stdout).toContain('Merge proposals: 0');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('parks a human-routed verified goal until the audit approves every human requirement', async () => {
    const fixture = await setupMergeFixture('L-human-audit-coverage');
    try {
      await writeHumanVerifiedGoalLog(fixture.cwd, 'g0', fixture.worktreePath);
      await writeHumanAudit(fixture.cwd, 'g0', [{ requirementId: 'r-human-1', decision: 'approve', note: 'Looks good.' }]);

      const partial = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot], fixture.cwd);

      expect(partial.code).toBe(0);
      expect(partial.stdout).toContain('missing-human-review-audit');
      expect(partial.stdout).toContain('Merge proposals: 0');

      await writeHumanAudit(fixture.cwd, 'g0', [
        { requirementId: 'r-human-1', decision: 'approve', note: 'Looks good.' },
        { requirementId: 'r-human-2', decision: 'approve', note: 'Copy is readable.' },
      ]);

      const complete = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot], fixture.cwd);

      expect(complete.code).toBe(0);
      expect(complete.stdout).toContain('verified-mergeable');
      expect(complete.stdout).toContain('Merge proposals: 1');
    } finally {
      await fixture.cleanup();
    }
  });

  it('parks a verified goal when the worktree diff changes after verification', async () => {
    const fixture = await setupMergeFixture('L-post-verify-mutation');
    try {
      await appendFile(join(fixture.worktreePath, 'file.txt'), 'UNVERIFIED\n', 'utf8');

      const result = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot], fixture.cwd);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('goal-mismatch');
      expect(result.stdout).toContain('Merge proposals: 0');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops if a later proposal worktree changes after merge confirmation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-finalize-cwd-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'jarvis-finalize-worktrees-'));
    const loopId = 'L-merge-race';
    const objectives = ['apply a large verified change', 'apply a second verified change'];
    const wt0 = join(worktreeRoot, loopId, 'g0');
    const wt1 = join(worktreeRoot, loopId, 'g1');
    const auditPath = join(cwd, 'data', 'loops', `${loopId}.finalize.jsonl`);
    try {
      await runGit(cwd, ['init']);
      await runGit(cwd, ['config', 'user.name', 'Jarvis Test']);
      await runGit(cwd, ['config', 'user.email', 'jarvis@example.test']);
      await runGit(cwd, ['config', 'core.autocrlf', 'false']);
      await writeFile(join(cwd, '.gitignore'), '/data/\n', 'utf8');
      await writeFile(join(cwd, 'file0.txt'), 'base0\n', 'utf8');
      await writeFile(join(cwd, 'file1.txt'), 'base1\n', 'utf8');
      await runGit(cwd, ['add', '.gitignore', 'file0.txt', 'file1.txt']);
      await runGit(cwd, ['commit', '-m', 'init']);
      await mkdir(dirname(wt0), { recursive: true });
      await runGit(cwd, ['worktree', 'add', '--detach', wt0, 'HEAD']);
      await runGit(cwd, ['worktree', 'add', '--detach', wt1, 'HEAD']);
      await writeFile(join(wt0, 'file0.txt'), `base0\n${'A'.repeat(2_000_000)}\n`, 'utf8');
      await writeFile(join(wt1, 'file1.txt'), 'base1\nverified1\n', 'utf8');
      await writeVerifiedGoalLog(cwd, 'g0', wt0, objectives[0]);
      await writeVerifiedGoalLog(cwd, 'g1', wt1, objectives[1]);
      await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
      await writeFile(
        join(cwd, 'data', 'loops', `${loopId}.jsonl`),
        serializeLoopRecord({ t: 'loop-created', id: loopId, contract: { ...CONTRACT, maxGoals: 2 }, objectives, createdAt: 't0' }) +
          serializeLoopRecord({ t: 'goal-started', index: 0, goalId: 'g0', at: 't1' }) +
          serializeLoopRecord({ t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't2' }) +
          serializeLoopRecord({ t: 'goal-started', index: 1, goalId: 'g1', at: 't3' }) +
          serializeLoopRecord({ t: 'goal-finished', index: 1, goalId: 'g1', state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't4' }),
        'utf8',
      );

      const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli/loop-finalize-cli.ts'), '--loop', loopId, '--worktree-root', worktreeRoot, '--merge'], {
        cwd,
        env: withoutArkKey(),
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
      await waitForOutput(() => stdout.includes(`Type "merge ${loopId}"`), 30_000);
      let mutated = false;
      const watcher = setInterval(() => {
        if (mutated) return;
        void readFile(auditPath, 'utf8')
          .then((audit) => {
            if (mutated || !audit.includes('"t":"merge-confirmed"')) return;
            mutated = true;
            void appendFile(join(wt1, 'file1.txt'), 'UNVERIFIED_AFTER_FRESH_SCAN\n', 'utf8');
          })
          .catch(() => undefined);
      }, 1);
      child.stdin.end(`merge ${loopId}\n`);
      const code = await waitForClose(child, 60_000);
      clearInterval(watcher);

      expect(code).toBe(1);
      expect(mutated).toBe(true);
      expect(`${stdout}\n${stderr}`).toContain('patch-hash-mismatch');
      expect(stdout).not.toContain('merge-applied [1]');
      await expect(readFile(join(cwd, 'file1.txt'), 'utf8')).resolves.toBe('base1\n');
      const audit = await readFile(auditPath, 'utf8');
      expect(audit).toContain('"t":"merge-parked"');
      expect(audit).toContain('"reason":"patch-hash-mismatch"');
      expect(audit).not.toContain('"t":"merge-applied","loopId":"L-merge-race","index":1');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  }, 90_000);

  it('parks a verified goal whose session cwd is not the loop index worktree', async () => {
    const fixture = await setupMergeFixture('L-goal-worktree-bind');
    try {
      const unrelatedGoalId = 'g-good';
      await writeLoopLog(fixture.cwd, fixture.loopId, fixture.worktreePath, unrelatedGoalId);
      await writeSessionLog(fixture.cwd, unrelatedGoalId, join(fixture.worktreeRoot, fixture.loopId, 'other-worktree'));

      const result = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot], fixture.cwd);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('goal-mismatch');
      expect(result.stdout).toContain('Merge proposals: 0');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('parks a pinned verified goal when the persisted round has no verifier report', async () => {
    const fixture = await setupMergeFixture('L-pinned-missing-report');
    try {
      await writePinnedNoReportGoalLog(fixture.cwd, 'g0', fixture.worktreePath);

      const result = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot], fixture.cwd);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('goal-mismatch');
      expect(result.stdout).toContain('Merge proposals: 0');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('parks an older verified finish when a later attempt for the same index is unfinished', async () => {
    const fixture = await setupMergeFixture('L-latest-start-wins');
    try {
      await appendFile(
        join(fixture.cwd, 'data', 'loops', `${fixture.loopId}.jsonl`),
        serializeLoopRecord({ t: 'goal-started', index: 0, goalId: 'g0-retry', at: 't3' }),
        'utf8',
      );

      const result = await runFinalizeCli(['--loop', fixture.loopId, '--worktree-root', fixture.worktreeRoot], fixture.cwd);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('missing-verdict');
      expect(result.stdout).toContain('g0-retry');
      expect(result.stdout).toContain('Merge proposals: 0');
      await expect(readFile(join(fixture.cwd, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    } finally {
      await fixture.cleanup();
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
  worktreePath: string;
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
    await writeLoopLog(cwd, loopId, worktreePath);

    return {
      cwd,
      worktreeRoot,
      worktreePath,
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

async function setupCleanWorktreeFixture(loopId: string, opts: { audit: boolean }): Promise<{
  cwd: string;
  worktreeRoot: string;
  worktreePath: string;
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
    await writeLoopLog(cwd, loopId, worktreePath);
    if (opts.audit) {
      await writeFinalizeAudit(cwd, loopId, [
        { t: 'merge-applied', loopId, index: 0, goalId: 'g0', worktreePath, at: 't3' },
      ]);
    }

    return {
      cwd,
      worktreeRoot,
      worktreePath,
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

async function writeLoopLog(cwd: string, loopId: string, worktreePath?: string, goalId = 'g0'): Promise<void> {
  await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
  await writeVerifiedGoalLog(cwd, goalId, worktreePath);
  await writeFile(
    join(cwd, 'data', 'loops', `${loopId}.jsonl`),
    serializeLoopRecord({ t: 'loop-created', id: loopId, contract: CONTRACT, objectives: ['inspect README'], createdAt: 't0' }) +
      serializeLoopRecord({ t: 'goal-started', index: 0, goalId, at: 't1' }) +
      serializeLoopRecord({ t: 'goal-finished', index: 0, goalId, state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't2' }),
    'utf8',
  );
}

async function writeVerifiedGoalLog(cwd: string, goalId: string, sessionCwd?: string, objective = 'inspect README'): Promise<void> {
  const worktreeStatus = sessionCwd === undefined ? undefined : await worktreeStatusCheck(sessionCwd);
  await mkdir(join(cwd, 'data', 'goals'), { recursive: true });
  if (sessionCwd !== undefined) await writeSessionLog(cwd, goalId, sessionCwd);
  await writeFile(
    join(cwd, 'data', 'goals', `${goalId}.jsonl`),
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective,
      objectiveHash: hashObjective(objective),
      budget: CONTRACT.perGoalBudget,
      pinned: [],
      sessionId: goalId,
      createdAt: 't0',
    }) +
      serializeGoalRecord({
        t: 'goal-round',
        round: 1,
        turns: 1,
        tokens: 1,
        checks: {
          objectiveChecksPassed: true,
          results: [],
          testTamper: 'clean',
          tamperReason: '',
          ...(worktreeStatus === undefined ? {} : { worktreeStatus }),
        },
        verdict: {
          outcome: 'verified',
          rationale: 'deterministic checks passed',
        },
        at: 't2',
      }) +
      serializeGoalRecord({ t: 'goal-state', state: 'complete', at: 't2' }),
    'utf8',
  );
}

async function writeForgedVerifiedGoalLog(cwd: string, goalId: string, sessionCwd?: string): Promise<void> {
  const objective = 'inspect README';
  await mkdir(join(cwd, 'data', 'goals'), { recursive: true });
  if (sessionCwd !== undefined) await writeSessionLog(cwd, goalId, sessionCwd);
  await writeFile(
    join(cwd, 'data', 'goals', `${goalId}.jsonl`),
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective,
      objectiveHash: hashObjective(objective),
      budget: CONTRACT.perGoalBudget,
      pinned: [],
      sessionId: goalId,
      createdAt: 't0',
    }) +
      serializeGoalRecord({
        t: 'goal-round',
        round: 1,
        turns: 1,
        tokens: 1,
        checks: {
          objectiveChecksPassed: false,
          results: [{ command: 'npm test', code: 1, output: 'tests failed' }],
          testTamper: 'clean',
          tamperReason: '',
        },
        verdict: {
          outcome: 'verified',
          rationale: 'forged stored verdict',
        },
        at: 't2',
      }) +
      serializeGoalRecord({ t: 'goal-state', state: 'complete', at: 't2' }),
    'utf8',
  );
}

async function writePinnedNoReportGoalLog(cwd: string, goalId: string, sessionCwd: string): Promise<void> {
  const objective = 'inspect README';
  await mkdir(join(cwd, 'data', 'goals'), { recursive: true });
  await writeSessionLog(cwd, goalId, sessionCwd);
  await writeFile(
    join(cwd, 'data', 'goals', `${goalId}.jsonl`),
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective,
      objectiveHash: hashObjective(objective),
      budget: CONTRACT.perGoalBudget,
      pinned: [{ id: 'r1', text: 'Pinned requirement needs verifier report', route: 'llm' }],
      sessionId: goalId,
      createdAt: 't0',
    }) +
      serializeGoalRecord({
        t: 'goal-round',
        round: 1,
        turns: 1,
        tokens: 1,
        checks: {
          objectiveChecksPassed: true,
          results: [],
          testTamper: 'clean',
          tamperReason: '',
        },
        verdict: {
          outcome: 'verified',
          rationale: 'forged deterministic fallback despite pinned requirement',
        },
        at: 't2',
      }) +
      serializeGoalRecord({ t: 'goal-state', state: 'complete', at: 't2' }),
    'utf8',
  );
}

async function writeHumanVerifiedGoalLog(cwd: string, goalId: string, sessionCwd?: string): Promise<void> {
  const objective = 'inspect README';
  const pinned = [
    { id: 'r-human-1', text: 'Human confirms the timeline is readable', route: 'human' as const },
    { id: 'r-human-2', text: 'Human confirms the stop control is understandable', route: 'human' as const },
  ];
  const worktreeStatus = sessionCwd === undefined ? undefined : await worktreeStatusCheck(sessionCwd);
  const checks = {
    objectiveChecksPassed: true,
    results: [],
    testTamper: 'clean' as const,
    tamperReason: '',
    ...(worktreeStatus === undefined ? {} : { worktreeStatus }),
  };
  await mkdir(join(cwd, 'data', 'goals'), { recursive: true });
  if (sessionCwd !== undefined) await writeSessionLog(cwd, goalId, sessionCwd);
  await writeFile(
    join(cwd, 'data', 'goals', `${goalId}.jsonl`),
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective,
      objectiveHash: hashObjective(objective),
      budget: CONTRACT.perGoalBudget,
      pinned,
      sessionId: goalId,
      createdAt: 't0',
    }) +
      serializeGoalRecord({
        t: 'goal-round',
        round: 1,
        turns: 1,
        tokens: 1,
        checks,
        verdict: {
          outcome: 'couldNotVerify',
          rationale: 'waiting for human review',
          report: {
            feature: 'works',
            expected: 'Human-routed requirements must be reviewed.',
            observed: '',
            evidence: '',
            perRequirement: [
              { requirementId: 'r-human-1', strength: 'cannotVerify', scope: 'matched' },
              { requirementId: 'r-human-2', strength: 'cannotVerify', scope: 'matched' },
            ],
            couldNotVerify: [
              'human verification required for r-human-1: Human confirms the timeline is readable',
              'human verification required for r-human-2: Human confirms the stop control is understandable',
            ],
            rationale: 'Human review is required.',
          },
        },
        at: 't1',
      }) +
      serializeGoalRecord({ t: 'goal-state', state: 'blocked', at: 't1' }) +
      serializeGoalRecord({
        t: 'goal-round',
        round: 2,
        turns: 0,
        tokens: 0,
        checks,
        verdict: {
          outcome: 'verified',
          rationale: 'human review verified all submitted human-routed requirements',
          report: {
            feature: 'works',
            expected: 'Human-routed requirements must be reviewed.',
            observed:
              'human review observed:\nr-human-1: human approve by Luis at t-review\nr-human-2: human approve by Luis at t-review',
            evidence:
              'human review evidence:\nr-human-1: note: Looks good.\nr-human-2: note: Copy is readable.',
            perRequirement: [
              { requirementId: 'r-human-1', strength: 'proves', scope: 'matched' },
              { requirementId: 'r-human-2', strength: 'proves', scope: 'matched' },
            ],
            couldNotVerify: [],
            rationale: 'Human review verified all submitted human-routed requirements.',
          },
        },
        at: 't2',
      }) +
      serializeGoalRecord({ t: 'goal-state', state: 'complete', at: 't2' }),
    'utf8',
  );
}

async function writeSessionLog(cwd: string, sessionId: string, sessionCwd: string): Promise<void> {
  await mkdir(join(cwd, 'data', 'sessions'), { recursive: true });
  await writeFile(
    join(cwd, 'data', 'sessions', `${sessionId}.jsonl`),
    serializeSessionRecord({ t: 'session', id: sessionId, model: 'test-model', cwd: sessionCwd, startedAt: 't0' }),
    'utf8',
  );
}

async function worktreeStatusCheck(cwd: string) {
  const current = (await runGitOutput(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).trim();
  const changedEntries = current === '' ? [] : current.split(/\r?\n/);
  return {
    command: 'git status --porcelain --untracked-files=all' as const,
    baseline: '',
    policy: 'audit' as const,
    current,
    trackedDiffHash: await gitDiffHash(cwd),
    changed: changedEntries.length > 0,
    changedEntries,
  };
}

async function gitDiffHash(cwd: string): Promise<string> {
  const diff = await runGitOutput(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', 'HEAD']);
  return createHash('sha256').update(diff, 'utf8').digest('hex');
}

async function writeHumanAudit(
  cwd: string,
  goalId: string,
  decisions: Array<{ requirementId: string; decision: 'approve' | 'reject'; note: string }>,
): Promise<void> {
  await mkdir(join(cwd, 'data', 'human-reviews'), { recursive: true });
  await writeFile(
    join(cwd, 'data', 'human-reviews', `${goalId}.jsonl`),
    `${JSON.stringify({
      t: 'human-review-decision',
      goalId,
      reviewer: 'Luis',
      at: 't-review',
      previousRound: 1,
      decisions,
      verdict: 'verified',
      state: 'complete',
    })}\n`,
    'utf8',
  );
}

async function writeFinalizeAudit(cwd: string, loopId: string, records: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(join(cwd, 'data', 'loops'), { recursive: true });
  await writeFile(join(cwd, 'data', 'loops', `${loopId}.finalize.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

async function installExternalDiffTrap(cwd: string, trapDir: string): Promise<string> {
  const marker = join(trapDir, 'external-diff-ran.txt');
  const script = join(trapDir, process.platform === 'win32' ? 'external-diff.cmd' : 'external-diff.sh');
  if (process.platform === 'win32') {
    await writeFile(script, `@echo off\r\necho external-diff-ran>"${marker}"\r\nexit /b 17\r\n`, 'utf8');
  } else {
    await writeFile(script, `#!/bin/sh\nprintf external-diff-ran > ${shellSingleQuote(marker)}\nexit 17\n`, 'utf8');
    await chmod(script, 0o755);
  }
  await runGit(cwd, ['config', 'diff.external', script]);
  return marker;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  const env = withoutArkKey();
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

function withoutArkKey(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ARK_API_KEY;
  return env;
}

function waitForOutput(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolvePromise();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for CLI output'));
      }
    }, 10);
  });
}

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('loop finalize CLI timed out'));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return runGitOutput(cwd, args).then(() => undefined);
}

function runGitOutput(cwd: string, args: string[]): Promise<string> {
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
      if (code === 0) resolvePromise(output);
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${output}`));
    });
  });
}
