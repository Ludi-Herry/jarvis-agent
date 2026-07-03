import { describe, expect, it } from 'vitest';
import type { ObservationReport } from '../../../src/capabilities/index.js';
import { buildGuiTimeline } from '../../../src/surfaces/gui/timeline.js';

const REPORT: ObservationReport = {
  meta: {
    schemaVersion: 1,
    generatedAt: '2026-07-03T12:00:00.000Z',
    source: { dataDir: 'data' },
    scope: { sessions: true, goals: true, loops: true, cron: true, cronDaemon: true, approvals: true },
  },
  authority: { mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false },
  status: {
    sessions: { total: 1 },
    goals: { total: 1, byState: { active: 0, complete: 1, blocked: 0 } },
    loops: { total: 1 },
    cron: { attempts: 1, lastAttempt: { taskId: 'daily', exitCode: 0, startedAt: '2026-07-03T11:00:00.000Z', finishedAt: '2026-07-03T11:01:00.000Z', loopId: 'L1' } },
    cronDaemon: { records: 0, parkedTasks: [] },
    latestSession: { id: 's1', model: 'builder', cwd: 'H:\\jarvis-agent', startedAt: '2026-07-03T10:00:00.000Z', messages: 3 },
    latestGoal: { id: 'g1', objective: 'ship GUI', state: 'complete', rounds: 1, verdict: 'verified', lastAt: '2026-07-03T11:30:00.000Z' },
    latestGoalBudget: { goalId: 'g1', roundsUsed: 1, maxRounds: 8, totalTurns: 2, totalTokens: 120, lastAt: '2026-07-03T11:30:00.000Z' },
    latestLoop: { id: 'L1', objectives: 1, completed: 1, blocked: 0, inFlight: 0, tokens: 120, halted: 'queue-empty', lastAt: '2026-07-03T11:31:00.000Z' },
  },
  usage: { sessionMessages: 3, sessionCompactions: 0, goalTurns: 2, goalTokens: 120, loopTokens: 120, loopFinishedGoals: 1 },
  audit: {
    trustedContracts: [{ loopId: 'L1', goalSetterRequirementsMapPath: 'C:\\trusted\\requirements.json' }],
    worktreeStatus: [{ goalId: 'g1', round: 1, policy: 'audit', changed: true, changedEntries: [' M README.md'] }],
    sandboxEvidence: [{ goalId: 'g1', round: 1, backend: 'wsl2-unshare', networkMode: 'none' }],
    approvals: { requests: 1, results: 1, allowed: 1, denied: 0, errors: 0, sessionIds: ['g1'] },
  },
  activity: {
    recent: [
      {
        id: 'approval:g1:1',
        kind: 'approval',
        title: 'Approval allow-once',
        detail: 'bash',
        tone: 'good',
        at: '2026-07-03T11:29:00.000Z',
        source: 'data/approvals/g1.jsonl',
        meta: ['session g1'],
      },
    ],
  },
};

describe('buildGuiTimeline', () => {
  it('turns observe output into a readable timeline without completion authority', () => {
    const items = buildGuiTimeline(REPORT, { path: 'stop.json', requested: false });

    expect(items.map((item) => item.kind)).toContain('loop');
    expect(items.map((item) => item.kind)).toContain('goal');
    expect(items).toContainEqual(expect.objectContaining({ id: 'activity-approval:g1:1', title: 'Approval allow-once' }));
    expect(items.map((item) => item.kind)).toContain('authority');
    expect(items.find((item) => item.kind === 'authority')).toMatchObject({
      detail: 'observation-only',
      meta: ['canCompleteGoals false', 'canCompleteLoops false'],
    });
  });

  it('puts an emergency stop request on the timeline', () => {
    const items = buildGuiTimeline(REPORT, {
      path: 'stop.json',
      requested: true,
      requestedAtMs: Date.parse('2026-07-03T12:01:00.000Z'),
      record: {
        schemaVersion: 1,
        requestedAt: '2026-07-03T12:01:00.000Z',
        source: 'gui',
        reason: 'operator stop',
        pid: 1,
        cwd: 'H:\\jarvis-agent',
      },
    });

    expect(items[0]).toMatchObject({ kind: 'control', tone: 'danger', detail: 'operator stop' });
  });
});
