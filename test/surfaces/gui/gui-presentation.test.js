import { describe, expect, it } from 'vitest';
import { buildRunPresentation } from '../../../src/surfaces/gui/assets/presentation.js';

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
