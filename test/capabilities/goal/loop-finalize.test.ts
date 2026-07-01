import { describe, expect, it } from 'vitest';
import { buildLoopFinalizeReport, type FinalizeWorktreeStatus } from '../../../src/capabilities/goal/index.js';
import type { LoopContract, LoopRecord } from '../../../src/capabilities/goal/index.js';

const CONTRACT: LoopContract = {
  maxGoals: 10,
  maxTotalTokens: 1000,
  maxWallClockMs: 60_000,
  maxConsecutiveBlocked: 3,
  cnvWindow: 3,
  cnvThreshold: 3,
  perGoalBudget: { maxRounds: 3 },
};

const clean = (path: string): FinalizeWorktreeStatus => ({
  path,
  exists: true,
  clean: true,
  conflicted: false,
  status: '',
  diffStat: '',
});

const dirty = (path: string): FinalizeWorktreeStatus => ({
  path,
  exists: true,
  clean: false,
  conflicted: false,
  status: ' M file.txt',
  diffStat: ' file.txt | 1 +',
});

describe('buildLoopFinalizeReport', () => {
  it('proposes only logged verified goals whose worktree is clean', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a', 'b', 'c', 'd'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' },
      { t: 'goal-started', index: 1, goalId: 'g1', at: 't3' },
      { t: 'goal-finished', index: 1, goalId: 'g1', state: 'blocked', outcome: 'couldNotVerify', rounds: 1, tokens: 10, at: 't4' },
      { t: 'goal-started', index: 2, goalId: 'g2', at: 't5' },
      { t: 'goal-finished', index: 2, goalId: 'g2', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't6' },
      { t: 'goal-started', index: 3, goalId: 'g3', at: 't7' },
      { t: 'goal-finished', index: 3, goalId: 'g3', state: 'complete', outcome: 'rejected', rounds: 1, tokens: 10, at: 't8' },
    ];

    const report = buildLoopFinalizeReport(records, new Map([
      [0, clean('wt/g0')],
      [1, clean('wt/g1')],
      [2, dirty('wt/g2')],
      [3, clean('wt/g3')],
    ]));

    expect(report.loopId).toBe('L');
    expect(report.proposals).toEqual([{ index: 0, goalId: 'g0', worktreePath: 'wt/g0' }]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'proposal', 'verified-clean'],
      [1, 'park', 'could-not-verify'],
      [2, 'park', 'dirty'],
      [3, 'park', 'rejected'],
    ]);
  });

  it('parks missing verdicts and missing worktrees', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a', 'b'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-started', index: 1, goalId: 'g1', at: 't2' },
      { t: 'goal-finished', index: 1, goalId: 'g1', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't3' },
    ];

    const report = buildLoopFinalizeReport(records, new Map([[1, { path: 'wt/g1', exists: false, clean: false, conflicted: false, status: '', diffStat: '' }]]));

    expect(report.proposals).toEqual([]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'park', 'missing-verdict'],
      [1, 'park', 'missing-worktree'],
    ]);
  });
});
