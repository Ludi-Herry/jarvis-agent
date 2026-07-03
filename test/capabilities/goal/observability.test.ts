import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildObservationReport,
  formatObservationReport,
  loadWorkspaceObservation,
  type ObservationInput,
} from '../../../src/capabilities/goal/observability.js';
import type { LoopContract } from '../../../src/capabilities/goal/index.js';

const CONTRACT: LoopContract = {
  maxGoals: 2,
  maxTotalTokens: 1000,
  maxWallClockMs: 60_000,
  maxConsecutiveBlocked: 3,
  cnvWindow: 3,
  cnvThreshold: 3,
  perGoalBudget: { maxRounds: 3 },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-observe-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildObservationReport', () => {
  it('summarizes status, usage, and audit evidence without granting completion authority', () => {
    const input: ObservationInput = {
      sessions: [
        {
          path: 'data/sessions/g1.jsonl',
          records: [
            { t: 'session', id: 'g1', model: 'builder', cwd: 'H:\\jarvis-agent', startedAt: '2026-07-02T10:00:00.000Z' },
            { t: 'message', message: { role: 'user', content: 'do it' } },
            { t: 'message', message: { role: 'assistant', content: 'done' } },
          ],
        },
      ],
      goals: [
        {
          path: 'data/goals/g1.jsonl',
          records: [
            {
              t: 'goal-created',
              id: 'g1',
              objective: 'inspect README',
              objectiveHash: 'hash',
              budget: { maxRounds: 3 },
              sessionId: 'g1',
              createdAt: '2026-07-02T10:00:00.000Z',
              pinned: [{ id: 'r1', text: 'README is inspectable' }],
            },
            {
              t: 'goal-round',
              round: 1,
              turns: 2,
              tokens: 42,
              checks: {
                objectiveChecksPassed: true,
                results: [],
                testTamper: 'clean',
                tamperReason: '',
                worktreeStatus: {
                  command: 'git status --porcelain --untracked-files=all',
                  baseline: '',
                  policy: 'audit',
                  current: ' M README.md',
                  changed: true,
                  changedEntries: [' M README.md'],
                },
              },
              verdict: {
                outcome: 'verified',
                rationale: 'ok',
                report: {
                  feature: 'works',
                  expected: 'README exists',
                  observed: 'r1 passed',
                  evidence:
                    'sandbox verifier evidence:\n' +
                    'r1: README is inspectable\n' +
                    'configuredCommand: stat README.md\n' +
                    'executedCommand: bash --noprofile --norc -c stat README.md\n' +
                    'sandbox audit:\n' +
                    JSON.stringify(
                      {
                        backend: 'wsl2-unshare',
                        command: ['bash', '--noprofile', '--norc', '-c', 'stat README.md'],
                        mounts: [{ hostPath: 'H:\\jarvis-agent', sandboxPath: '/tmp/jarvis-sandbox/project', access: 'read-only' }],
                        networkMode: 'none',
                        limits: { timeoutMs: 30000, outputLimitBytes: 20000 },
                      },
                      null,
                      2,
                    ) +
                    '\nexitCode: 0',
                  perRequirement: [{ requirementId: 'r1', strength: 'proves', scope: 'matched' }],
                  couldNotVerify: [],
                  rationale: 'ok',
                },
              },
              at: '2026-07-02T10:01:00.000Z',
            },
            { t: 'goal-state', state: 'complete', at: '2026-07-02T10:01:01.000Z' },
          ],
        },
      ],
      loops: [
        {
          path: 'data/loops/L1.jsonl',
          records: [
            {
              t: 'loop-created',
              id: 'L1',
              contract: CONTRACT,
              objectives: ['inspect README', 'human check'],
              createdAt: '2026-07-02T09:59:00.000Z',
              goalSetterRequirementsMapPath: 'C:\\trusted\\requirements.json',
              goalSetterRequirementsMapHash: 'abc123',
            },
            { t: 'goal-started', index: 0, goalId: 'g1', at: '2026-07-02T10:00:00.000Z' },
            { t: 'goal-finished', index: 0, goalId: 'g1', state: 'complete', outcome: 'verified', rounds: 1, tokens: 42, at: '2026-07-02T10:01:02.000Z' },
            { t: 'goal-started', index: 1, goalId: 'g2', at: '2026-07-02T10:02:00.000Z' },
            { t: 'goal-finished', index: 1, goalId: 'g2', state: 'blocked', outcome: 'couldNotVerify', rounds: 1, tokens: 9, at: '2026-07-02T10:03:00.000Z' },
            { t: 'loop-halted', reason: 'queue-empty', at: '2026-07-02T10:03:01.000Z' },
          ],
        },
      ],
      cron: {
        path: 'data/cron/loop-cron.jsonl',
        records: [
          {
            t: 'cron-attempt',
            taskId: 'daily',
            scheduledFor: '2026-07-02T09:00:00.000Z',
            startedAt: '2026-07-02T09:00:01.000Z',
            finishedAt: '2026-07-02T09:00:02.000Z',
            exitCode: 0,
            loopId: 'L1',
            nextRunAt: '2026-07-03T09:00:02.000Z',
          },
        ],
      },
      approvals: [
        {
          path: 'data/approvals/goal-1.jsonl',
          records: [
            {
              t: 'approval-request',
              requestId: 'a1',
              sessionId: 'goal-1',
              toolName: 'bash',
              capability: 'executes-code',
              reason: 'executes code',
              detail: 'npm test',
              at: '2026-07-02T10:00:30.000Z',
            },
            {
              t: 'approval-result',
              requestId: 'a1',
              sessionId: 'goal-1',
              toolName: 'bash',
              decision: 'allow-once',
              at: '2026-07-02T10:00:31.000Z',
            },
            {
              t: 'approval-result',
              requestId: 'a2',
              sessionId: 'goal-1',
              toolName: 'write',
              decision: 'deny',
              at: '2026-07-02T10:00:32.000Z',
            },
          ],
        },
      ],
    };

    const report = buildObservationReport(input);

    expect(report).toMatchObject({
      meta: {
        schemaVersion: 1,
        generatedAt: expect.any(String),
        source: {},
        scope: {
          sessions: true,
          goals: true,
          loops: true,
          cron: true,
          cronDaemon: true,
          approvals: true,
        },
      },
    });
    expect(report.authority).toEqual({ canCompleteGoals: false, canCompleteLoops: false, mode: 'observation-only' });
    expect(report.status.latestGoal).toMatchObject({ id: 'g1', state: 'complete', verdict: 'verified', rounds: 1 });
    expect(report.status.latestLoop).toMatchObject({ id: 'L1', completed: 1, blocked: 1, halted: 'queue-empty' });
    expect(report.status.cron.lastAttempt).toMatchObject({ taskId: 'daily', exitCode: 0, loopId: 'L1' });
    expect(report.status.latestGoalBudget).toMatchObject({
      goalId: 'g1',
      roundsUsed: 1,
      maxRounds: 3,
      totalTurns: 2,
      totalTokens: 42,
    });
    expect(report.usage).toMatchObject({ sessionMessages: 2, goalTurns: 2, goalTokens: 42, loopTokens: 51 });
    expect(report.audit.trustedContracts).toEqual([
      { loopId: 'L1', goalSetterRequirementsMapPath: 'C:\\trusted\\requirements.json', goalSetterRequirementsMapHash: 'abc123' },
    ]);
    expect(report.audit.worktreeStatus).toEqual([
      { goalId: 'g1', round: 1, policy: 'audit', changed: true, changedEntries: [' M README.md'] },
    ]);
    expect(report.audit.sandboxEvidence).toEqual([
      {
        goalId: 'g1',
        round: 1,
        backend: 'wsl2-unshare',
        command: ['bash', '--noprofile', '--norc', '-c', 'stat README.md'],
        networkMode: 'none',
        mounts: [{ hostPath: 'H:\\jarvis-agent', sandboxPath: '/tmp/jarvis-sandbox/project', access: 'read-only' }],
        limits: { timeoutMs: 30000, outputLimitBytes: 20000 },
      },
    ]);
    expect(report.audit.approvals).toEqual({
      requests: 1,
      results: 2,
      allowed: 1,
      denied: 1,
      errors: 0,
      sessionIds: ['goal-1'],
    });

    expect(formatObservationReport(report)).toContain('Observation: status/usage/audit (read-only)');
    expect(formatObservationReport(report)).toContain('completion authority: none');
    expect(formatObservationReport(report)).toContain('latest goal: g1 complete verdict=verified rounds=1');
    expect(formatObservationReport(report)).toContain('latest goal budget: g1 rounds=1/3 turns=2 tokens=42');
    expect(formatObservationReport(report)).toContain('sandbox evidence: 1');
  });
});

describe('loadWorkspaceObservation', () => {
  it('loads workspace JSONL logs and skips corrupt tails', async () => {
    await mkdir(join(dir, 'data', 'sessions'), { recursive: true });
    await mkdir(join(dir, 'data', 'goals'), { recursive: true });

    await writeFile(
      join(dir, 'data', 'sessions', 's1.jsonl'),
      '{"t":"session","id":"s1","model":"builder","cwd":"cwd","startedAt":"t0"}\n' +
        '{"t":"message","message":{"role":"user","content":"hello"}}\n' +
        '{"t":"mess',
      'utf8',
    );
    await writeFile(
      join(dir, 'data', 'goals', 'g1.jsonl'),
      '{"t":"goal-created","id":"g1","objective":"x","objectiveHash":"h","budget":{"maxRounds":1},"sessionId":"s1","createdAt":"t0"}\n' +
        '{"t":"goal-state","state":"blocked","at":"t1"}\n',
      'utf8',
    );
    await mkdir(join(dir, 'data', 'approvals'), { recursive: true });
    await writeFile(
      join(dir, 'data', 'approvals', 'goal-1.jsonl'),
      '{"t":"approval-request","requestId":"a1","sessionId":"goal-1","toolName":"write","capability":"writes-files","reason":"writes files","detail":"路径: README.md","at":"t0"}\n' +
        '{"t":"approval-result","requestId":"a1","sessionId":"goal-1","toolName":"write","decision":"deny","at":"t1"}\n',
      'utf8',
    );

    const report = await loadWorkspaceObservation(join(dir, 'data'));

    expect(report.meta.source).toEqual({ dataDir: join(dir, 'data') });
    expect(report.status.sessions.total).toBe(1);
    expect(report.status.goals.total).toBe(1);
    expect(report.status.latestGoal).toMatchObject({ id: 'g1', state: 'blocked' });
    expect(report.usage.sessionMessages).toBe(1);
    expect(report.audit.approvals.denied).toBe(1);
  });
});
