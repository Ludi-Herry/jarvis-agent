import { describe, expect, it } from 'vitest';
import {
  advanceMutationBarrier,
  buildRunPresentation,
  buildTimelineProjection,
  commitMutationThenRefresh,
  formatReviewNoteLength,
  reconcileReviewExpansion,
  reconcileExpandedTimeline,
  reviewDecisionKey,
  reviewDecisionKeys,
  reviewHistorySnapshot,
  reviewNoteFieldIdentity,
  reviewQueueSnapshot,
  settleSequencedRefresh,
  shouldApplyRefresh,
  timelineProjectionSnapshot,
} from '../../../src/surfaces/gui/assets/presentation.js';

const report = (overrides = {}) => ({
  status: {
    latestGoal: {
      id: 'g1',
      objective: 'Inspect the release evidence',
      state: 'active',
      recordedState: 'active',
      effectiveState: 'active',
    },
    latestGoalBudget: {
      goalId: 'g1',
      roundsUsed: 2,
      maxRounds: 8,
      totalTurns: 4,
      totalTokens: 1200,
    },
  },
  usage: {
    uniqueTotalTokens: 1000,
    goalTokens: 1200,
    loopTokens: 1400,
    coverage: 'partial',
  },
  ...overrides,
});

describe('G2.4 timeline projection', () => {
  const items = [
    { id: 'goal-g1', kind: 'goal', title: 'Goal g1' },
    { id: 'activity-goal:1', kind: 'goal', title: 'Goal started' },
    { id: 'activity-goal:2', kind: 'goal', title: 'Round finished' },
    { id: 'authority', kind: 'authority', title: '只读观测' },
  ];

  it('separates synthesized snapshots from persisted activity without losing order', () => {
    const projection = buildTimelineProjection(items, 1);

    expect(projection.snapshots.map((item) => item.id)).toEqual(['goal-g1', 'authority']);
    expect(projection.events.visible.map((item) => item.id)).toEqual(['activity-goal:1']);
    expect(projection.events.hidden.map((item) => item.id)).toEqual(['activity-goal:2']);
    expect(projection.events.total).toBe(2);
    expect([
      ...projection.snapshots,
      ...projection.events.visible,
      ...projection.events.hidden,
    ]).toHaveLength(items.length);
  });

  it('keeps an empty persisted stream explicit and supports a zero-item preview', () => {
    expect(buildTimelineProjection(items.filter((item) => !item.id.startsWith('activity-')), 12).events)
      .toEqual({ visible: [], hidden: [], total: 0 });
    expect(buildTimelineProjection(items, 0).events.visible).toEqual([]);
  });

  it('preserves disclosure state only for timeline items that still exist', () => {
    expect(reconcileExpandedTimeline(['a', 'c'], ['a', 'b'])).toEqual(['a']);
  });

  it('changes the projection snapshot only when timeline facts or summaries change', () => {
    expect(timelineProjectionSnapshot(items)).toBe(timelineProjectionSnapshot(JSON.parse(JSON.stringify(items))));
    expect(timelineProjectionSnapshot(items)).not.toBe(timelineProjectionSnapshot(items.slice(1)));
  });
});

describe('G2.2 run presentation', () => {
  it('puts pending human attention ahead of ordinary active status', () => {
    const view = buildRunPresentation(report(), { requested: false }, 3);

    expect(view.attention).toMatchObject({
      label: '3 项等待人工判断',
      tone: 'warn',
      href: '#human-review',
    });
    expect(view.state).toEqual({ label: '进行中', tone: 'info' });
    expect(view.budget).toMatchObject({ label: '2/8 轮', value: 2, max: 8 });
    expect(view.usage).toMatchObject({ unique: 1000, coverage: '部分', unmetered: '未知' });
  });

  it('makes unreadable emergency-stop state the highest-priority failure', () => {
    const view = buildRunPresentation(report(), { requested: false, unreadable: true }, 3);

    expect(view.state).toEqual({ label: '急停未知', tone: 'danger' });
    expect(view.attention).toMatchObject({ label: '急停状态无法读取', tone: 'danger' });
  });

  it('keeps requested stop ahead of reviews and reviews ahead of a blocked goal', () => {
    const blockedReport = report({
      status: {
        ...report().status,
        latestGoal: {
          ...report().status.latestGoal,
          effectiveState: 'blocked',
        },
      },
    });

    expect(buildRunPresentation(blockedReport, { requested: true }, 3).attention.label)
      .toBe('Jarvis 已收到急停请求');
    expect(buildRunPresentation(blockedReport, { requested: false }, 3).attention.label)
      .toBe('3 项等待人工判断');
    expect(buildRunPresentation(blockedReport, { requested: false }, 0).attention.label)
      .toBe('当前目标已阻塞');
  });

  it('keeps an effective interruption distinct from the recorded goal state', () => {
    const view = buildRunPresentation(report({
      status: {
        latestGoal: {
          id: 'g-stop',
          objective: 'Read the repository',
          state: 'active',
          recordedState: 'active',
          effectiveState: 'interrupted',
          effectiveReason: 'emergency-stop',
          effectiveSource: { kind: 'loop-halt', loopId: 'L-stop' },
        },
      },
    }), { requested: false }, 0);

    expect(view.state).toEqual({ label: '已中断', tone: 'warn' });
    expect(view.goal.meta).toContain('记录状态 进行中');
    expect(view.goal.meta).toContain('原因 emergency-stop');
    expect(view.goal.meta).toContain('Loop L-stop');
  });

  it('teaches the empty state without inventing runtime activity', () => {
    const view = buildRunPresentation(report({ status: {}, usage: report().usage }), { requested: false }, 0);

    expect(view.goal.title).toBe('当前没有运行中的目标');
    expect(view.state).toEqual({ label: '空闲', tone: 'neutral' });
    expect(view.budget).toMatchObject({ available: false, value: 0, max: 1 });
  });
});

describe('G2.3 review expansion projection', () => {
  it('opens only the first goal on initial render', () => {
    expect(reconcileReviewExpansion(['g1', 'g2'], [], false)).toEqual({
      expandedIds: ['g1'],
      initialized: true,
    });
  });

  it('keeps an intentionally collapsed queue collapsed across polling', () => {
    expect(reconcileReviewExpansion(['g1', 'g2'], [], true)).toEqual({
      expandedIds: [],
      initialized: true,
    });
  });

  it('prunes resolved goals and resets after the queue becomes empty', () => {
    expect(reconcileReviewExpansion(['g2'], ['g1', 'g2'], true)).toEqual({
      expandedIds: ['g2'],
      initialized: true,
    });
    expect(reconcileReviewExpansion([], ['g2'], true)).toEqual({
      expandedIds: [],
      initialized: false,
    });
  });

  it('uses collision-safe decision keys and prunes against current requirements', () => {
    expect(reviewDecisionKey('a:b', 'c')).not.toBe(reviewDecisionKey('a', 'b:c'));
    expect(reviewDecisionKeys([
      { goalId: 'g1', requirements: [{ requirementId: 'r1' }, { requirementId: 'r2' }] },
    ])).toEqual([
      reviewDecisionKey('g1', 'r1'),
      reviewDecisionKey('g1', 'r2'),
    ]);
  });

  it('gives every decision note a stable collision-safe form identity and length feedback', () => {
    expect(reviewNoteFieldIdentity('a-b', 'c')).not.toEqual(reviewNoteFieldIdentity('a', 'b-c'));
    expect(reviewNoteFieldIdentity('目标 1', '文案/确认')).toEqual(
      reviewNoteFieldIdentity('目标 1', '文案/确认'),
    );
    expect(reviewNoteFieldIdentity('目标 1', '文案/确认')).toMatchObject({
      id: expect.stringMatching(/^human-review-note-/u),
      name: expect.stringMatching(/^human-review-note-/u),
    });
    expect(formatReviewNoteLength('裁决备注', 1000)).toBe('4 / 1000');
  });

  it('changes the history snapshot only when persisted decisions or coverage change', () => {
    const history = { records: [{ goalId: 'g1', at: 't1' }], total: 1, coverage: 'complete', warnings: [] };
    expect(reviewHistorySnapshot(history)).toBe(reviewHistorySnapshot(JSON.parse(JSON.stringify(history))));
    expect(reviewHistorySnapshot(history)).not.toBe(reviewHistorySnapshot({
      ...history,
      coverage: 'partial',
      warnings: ['unreadable'],
    }));
  });

  it('changes the queue snapshot when authoritative review data changes', () => {
    const base = [{ goalId: 'g1', round: 1, requirements: [{ requirementId: 'r1', text: 'Check it' }] }];

    expect(reviewQueueSnapshot(base)).toBe(reviewQueueSnapshot(JSON.parse(JSON.stringify(base))));
    expect(reviewQueueSnapshot(base)).not.toBe(reviewQueueSnapshot([
      ...base,
      { goalId: 'g2', round: 1, requirements: [{ requirementId: 'r2', text: 'Check more' }] },
    ]));
    expect(reviewQueueSnapshot(base)).not.toBe(reviewQueueSnapshot([
      { goalId: 'g1', round: 2, requirements: [{ requirementId: 'r1', text: 'Check it' }] },
    ]));
  });

  it('rejects refresh responses older than the last applied sequence', () => {
    expect(shouldApplyRefresh(4, 5)).toBe(false);
    expect(shouldApplyRefresh(5, 5)).toBe(true);
    expect(shouldApplyRefresh(6, 5)).toBe(true);
  });

  it('invalidates an in-flight poll even when the post-mutation refresh fails', () => {
    const inFlightPoll = 5;
    const barrier = advanceMutationBarrier(inFlightPoll, 4);

    expect(barrier).toEqual({
      barrier: 6,
      refreshSequence: 6,
      appliedRefreshSequence: 6,
    });
    expect(shouldApplyRefresh(inFlightPoll, barrier.appliedRefreshSequence)).toBe(false);
    expect(shouldApplyRefresh(7, barrier.appliedRefreshSequence)).toBe(true);
  });

  it('never moves an applied refresh watermark backwards', () => {
    expect(advanceMutationBarrier(5, 9)).toEqual({
      barrier: 10,
      refreshSequence: 10,
      appliedRefreshSequence: 10,
    });
  });

  it('commits exactly once before a failed refresh and reports the refresh failure', async () => {
    const calls = [];
    const refreshError = new Error('status unavailable');
    let sequencing = { refreshSequence: 5, appliedRefreshSequence: 4 };
    const result = await commitMutationThenRefresh({
      request: async () => {
        calls.push('request');
        return { ok: true, status: 200 };
      },
      commit: () => {
        calls.push('commit');
        sequencing = advanceMutationBarrier(sequencing.refreshSequence, sequencing.appliedRefreshSequence);
      },
      refresh: async () => {
        calls.push('refresh');
        throw refreshError;
      },
    });

    expect(calls).toEqual(['request', 'commit', 'refresh']);
    expect(result).toEqual({ refreshError });
    expect(shouldApplyRefresh(5, sequencing.appliedRefreshSequence)).toBe(false);
  });

  it('does not commit or refresh after a rejected decision request', async () => {
    const calls = [];
    const sequencing = { refreshSequence: 5, appliedRefreshSequence: 4 };

    await expect(commitMutationThenRefresh({
      request: async () => ({ ok: false, status: 409 }),
      commit: () => calls.push('commit'),
      refresh: async () => calls.push('refresh'),
    })).rejects.toThrow('review 409');
    expect(calls).toEqual([]);
    expect(sequencing).toEqual({ refreshSequence: 5, appliedRefreshSequence: 4 });
  });

  it('silences a stale refresh error raised after a mutation barrier', async () => {
    let appliedSequence = 4;
    const result = await settleSequencedRefresh(
      5,
      async () => {
        appliedSequence = 6;
        throw new Error('old poll failed');
      },
      () => appliedSequence,
    );

    expect(result).toEqual({ accepted: false });
  });

  it('keeps a current refresh error visible', async () => {
    await expect(settleSequencedRefresh(
      6,
      async () => {
        throw new Error('current poll failed');
      },
      () => 6,
    )).rejects.toThrow('current poll failed');
  });
});
