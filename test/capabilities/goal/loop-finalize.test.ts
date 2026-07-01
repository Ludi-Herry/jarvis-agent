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
  hasTrackedChanges: false,
  hasUntracked: false,
  statusReadable: true,
  diffReadable: true,
  status: '',
  diffStat: '',
});

const trackedDiff = (path: string): FinalizeWorktreeStatus => ({
  path,
  exists: true,
  clean: false,
  conflicted: false,
  hasTrackedChanges: true,
  hasUntracked: false,
  statusReadable: true,
  diffReadable: true,
  status: ' M file.txt',
  diffStat: ' file.txt | 1 +',
});

const untracked = (path: string): FinalizeWorktreeStatus => ({
  path,
  exists: true,
  clean: false,
  conflicted: false,
  hasTrackedChanges: false,
  hasUntracked: true,
  statusReadable: true,
  diffReadable: true,
  status: '?? file.txt',
  diffStat: '',
});

describe('buildLoopFinalizeReport', () => {
  it('proposes only logged verified goals with mergeable tracked changes', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a', 'b', 'c', 'd', 'e'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' },
      { t: 'goal-started', index: 1, goalId: 'g1', at: 't3' },
      { t: 'goal-finished', index: 1, goalId: 'g1', state: 'blocked', outcome: 'couldNotVerify', rounds: 1, tokens: 10, at: 't4' },
      { t: 'goal-started', index: 2, goalId: 'g2', at: 't5' },
      { t: 'goal-finished', index: 2, goalId: 'g2', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't6' },
      { t: 'goal-started', index: 3, goalId: 'g3', at: 't7' },
      { t: 'goal-finished', index: 3, goalId: 'g3', state: 'complete', outcome: 'rejected', rounds: 1, tokens: 10, at: 't8' },
      { t: 'goal-started', index: 4, goalId: 'g4', at: 't9' },
      { t: 'goal-finished', index: 4, goalId: 'g4', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't10' },
    ];

    const report = buildLoopFinalizeReport(records, new Map([
      [0, trackedDiff('wt/g0')],
      [1, clean('wt/g1')],
      [2, untracked('wt/g2')],
      [3, clean('wt/g3')],
      [4, clean('wt/g4')],
    ]));

    expect(report.loopId).toBe('L');
    expect(report.proposals).toEqual([{ index: 0, goalId: 'g0', worktreePath: 'wt/g0' }]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'proposal', 'verified-mergeable'],
      [1, 'park', 'could-not-verify'],
      [2, 'park', 'dirty'],
      [3, 'park', 'rejected'],
      [4, 'park', 'no-diff'],
    ]);
  });

  it('parks missing verdicts and missing worktrees', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a', 'b'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-started', index: 1, goalId: 'g1', at: 't2' },
      { t: 'goal-finished', index: 1, goalId: 'g1', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't3' },
    ];

    const report = buildLoopFinalizeReport(records, new Map([[1, {
      path: 'wt/g1',
      exists: false,
      clean: false,
      conflicted: false,
      hasTrackedChanges: false,
      hasUntracked: false,
      statusReadable: false,
      diffReadable: false,
      status: '',
      diffStat: '',
    }]]));

    expect(report.proposals).toEqual([]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'park', 'missing-verdict'],
      [1, 'park', 'missing-worktree'],
    ]);
  });
});
