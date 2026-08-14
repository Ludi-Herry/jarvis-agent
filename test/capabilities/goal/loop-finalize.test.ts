import { describe, expect, it } from 'vitest';
import { buildLoopFinalizeReport, type FinalizeWorktreeStatus, type LoopFinalizeGoalEvidence } from '../../../src/capabilities/goal/index.js';
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
  trackedDiffHash: diffHash(path),
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

    const report = buildLoopFinalizeReport(
      records,
      new Map([
        [0, trackedDiff('wt/g0')],
        [1, clean('wt/g1')],
        [2, untracked('wt/g2')],
        [3, clean('wt/g3')],
        [4, clean('wt/g4')],
      ]),
      evidence([verified('g0', 'a', 'wt/g0'), verified('g2', 'c', 'wt/g2'), verified('g4', 'e', 'wt/g4')]),
    );

    expect(report.loopId).toBe('L');
    expect(report.proposals).toEqual([{ index: 0, goalId: 'g0', worktreePath: 'wt/g0', worktreeDiffHash: 'diff:wt/g0' }]);
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

    const report = buildLoopFinalizeReport(
      records,
      new Map([[1, {
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
      }]]),
      evidence([verified('g1', 'b', 'wt/g1')]),
    );

    expect(report.proposals).toEqual([]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'park', 'missing-verdict'],
      [1, 'park', 'missing-worktree'],
    ]);
  });

  it('parks an index whose latest attempt started after an older verified finish', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0-old', at: 't1' },
      { t: 'goal-finished', index: 0, goalId: 'g0-old', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' },
      { t: 'goal-started', index: 0, goalId: 'g0-retry', at: 't3' },
    ];

    const report = buildLoopFinalizeReport(
      records,
      new Map([[0, trackedDiff('wt/g0')]]),
      evidence([verified('g0-old', 'a', 'wt/g0')]),
    );

    expect(report.proposals).toEqual([]);
    expect(report.items.map((item) => [item.index, item.goalId, item.decision, item.reason])).toEqual([
      [0, 'g0-retry', 'park', 'missing-verdict'],
    ]);
  });

  it('parks loop-only verified claims when goal evidence is missing or mismatched', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a', 'b'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' },
      { t: 'goal-started', index: 1, goalId: 'g1', at: 't3' },
      { t: 'goal-finished', index: 1, goalId: 'g1', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't4' },
    ];

    const report = buildLoopFinalizeReport(
      records,
      new Map([
        [0, trackedDiff('wt/g0')],
        [1, trackedDiff('wt/g1')],
      ]),
      evidence([{ goalId: 'g1', objective: 'b', sessionId: 'g1', sessionCwd: 'wt/g1', state: 'blocked', outcome: 'couldNotVerify' }]),
    );

    expect(report.proposals).toEqual([]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'park', 'missing-goal-evidence'],
      [1, 'park', 'goal-mismatch'],
    ]);
  });

  it('parks verified goals when the current worktree diff hash differs from the verified diff hash', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' },
    ];

    const report = buildLoopFinalizeReport(
      records,
      new Map([[0, trackedDiff('wt/g0')]]),
      evidence([{ ...verified('g0', 'a', 'wt/g0'), worktreeDiffHash: 'old-verified-diff' }]),
    );

    expect(report.proposals).toEqual([]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'park', 'goal-mismatch'],
    ]);
  });

  it('parks human-reviewed verified goals until matching audit evidence is present', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a', 'b'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 2, tokens: 10, at: 't2' },
      { t: 'goal-started', index: 1, goalId: 'g1', at: 't3' },
      { t: 'goal-finished', index: 1, goalId: 'g1', state: 'complete', outcome: 'verified', rounds: 2, tokens: 10, at: 't4' },
    ];

    const report = buildLoopFinalizeReport(
      records,
      new Map([
        [0, trackedDiff('wt/g0')],
        [1, trackedDiff('wt/g1')],
      ]),
      evidence([
        { ...verified('g0', 'a', 'wt/g0'), requiresHumanReviewAudit: true, hasHumanReviewAudit: false },
        { ...verified('g1', 'b', 'wt/g1'), requiresHumanReviewAudit: true, hasHumanReviewAudit: true },
      ]),
    );

    expect(report.proposals).toEqual([{ index: 1, goalId: 'g1', worktreePath: 'wt/g1', worktreeDiffHash: 'diff:wt/g1' }]);
    expect(report.items.map((item) => [item.index, item.decision, item.reason])).toEqual([
      [0, 'park', 'missing-human-review-audit'],
      [1, 'proposal', 'verified-mergeable'],
    ]);
  });

  it('parks verified goals when session receipts are unavailable or a tool effect is pending', () => {
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['legacy', 'pending'], createdAt: 't0' },
      { t: 'goal-started', index: 0, goalId: 'g0', at: 't1' },
      { t: 'goal-finished', index: 0, goalId: 'g0', state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't2' },
      { t: 'goal-started', index: 1, goalId: 'g1', at: 't3' },
      { t: 'goal-finished', index: 1, goalId: 'g1', state: 'complete', outcome: 'verified', rounds: 1, tokens: 1, at: 't4' },
    ];

    const report = buildLoopFinalizeReport(
      records,
      new Map([[0, trackedDiff('wt/g0')], [1, trackedDiff('wt/g1')]]),
      evidence([
        { ...verified('g0', 'legacy', 'wt/g0'), sessionFormat: 'v1', sessionPendingTools: 0 },
        { ...verified('g1', 'pending', 'wt/g1'), sessionPendingTools: 1 },
      ]),
    );

    expect(report.proposals).toEqual([]);
    expect(report.items.map((item) => [item.index, item.reason])).toEqual([
      [0, 'session-receipts-unavailable'],
      [1, 'pending-tool-effects'],
    ]);
  });
});

function verified(goalId: string, objective: string, sessionCwd: string): LoopFinalizeGoalEvidence {
  return {
    goalId,
    objective,
    sessionId: goalId,
    sessionCwd,
    sessionFormat: 'v2',
    sessionPendingTools: 0,
    worktreeDiffHash: diffHash(sessionCwd),
    state: 'complete',
    outcome: 'verified',
  };
}

function evidence(items: LoopFinalizeGoalEvidence[]): Map<string, LoopFinalizeGoalEvidence> {
  return new Map(items.map((item) => [item.goalId, item]));
}

function diffHash(path: string): string {
  return `diff:${path}`;
}
