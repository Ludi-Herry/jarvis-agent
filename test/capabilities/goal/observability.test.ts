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
  it('downgrades a historical checks-only complete record in summaries, counts, and activity', () => {
    const report = buildObservationReport({
      goals: [{
        path: 'data/goals/legacy.jsonl',
        records: [
          {
            t: 'goal-created',
            id: 'legacy',
            objective: 'claim more than routine checks prove',
            objectiveHash: 'hash',
            budget: { maxRounds: 1 },
            sessionId: 'legacy',
            createdAt: '2026-07-01T00:00:00.000Z',
          },
          {
            t: 'goal-round',
            round: 1,
            checks: { objectiveChecksPassed: true, results: [], testTamper: 'clean', tamperReason: '' },
            verdict: { outcome: 'verified', rationale: 'legacy deterministic-only rule' },
            at: '2026-07-01T00:00:01.000Z',
          },
          { t: 'goal-state', state: 'complete', at: '2026-07-01T00:00:02.000Z' },
        ],
      }],
    });

    expect(report.status.goals.byState).toEqual({ active: 0, complete: 0, blocked: 1 });
    expect(report.status.latestGoal).toMatchObject({
      state: 'complete',
      recordedState: 'complete',
      effectiveState: 'blocked',
      effectiveReason: 'verdict-mismatch',
      verdict: 'checksOnly',
      recordedVerdict: 'verified',
    });
    expect(report.activity.recent).toContainEqual(expect.objectContaining({ title: 'Goal blocked', tone: 'warn' }));
    expect(formatObservationReport(report)).toContain(
      'latest goal: legacy blocked recorded=complete reason=verdict-mismatch source=verdict-recheck verdict=checksOnly recordedVerdict=verified',
    );
  });

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
    expect(report.integrity).toEqual({
      status: 'complete',
      corruptLineCount: 0,
      unreadableFileCount: 0,
      affected: [],
      omittedAffectedCount: 0,
    });
    expect(report.status.latestGoal).toMatchObject({ id: 'g1', state: 'complete', verdict: 'verified', rounds: 1 });
    expect(report.status.latestLoop).toMatchObject({
      id: 'L1',
      completed: 1,
      blocked: 1,
      halted: 'blocked-goals',
      recordedHalt: 'queue-empty',
    });
    expect(report.status.cron.lastAttempt).toMatchObject({ taskId: 'daily', exitCode: 0, loopId: 'L1', inconsistent: true });
    expect(report.status.latestGoalBudget).toMatchObject({
      goalId: 'g1',
      roundsUsed: 1,
      maxRounds: 3,
      totalTurns: 2,
      totalTokens: 42,
    });
    expect(report.usage).toMatchObject({
      sessionMessages: 2,
      goalTurns: 2,
      goalTokens: 42,
      loopTokens: 51,
      uniqueTotalTokens: 51,
      coverage: 'partial',
    });
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
    expect(report.activity.recent[0]).toMatchObject({ kind: 'loop', title: 'Loop halted', detail: 'blocked-goals', tone: 'warn' });
    expect(report.activity.recent).toContainEqual(expect.objectContaining({ kind: 'approval', title: 'Approval deny', detail: 'write' }));

    expect(formatObservationReport(report)).toContain('Observation: status/usage/audit (read-only)');
    expect(formatObservationReport(report)).toContain('completion authority: none');
    expect(formatObservationReport(report)).toContain('latest goal: g1 complete verdict=verified rounds=1');
    expect(formatObservationReport(report)).toContain('latest goal budget: g1 rounds=1/3 turns=2 tokens=42');
    expect(formatObservationReport(report)).toContain('halted=blocked-goals recorded=queue-empty');
    expect(formatObservationReport(report)).toContain('inconsistent=blocked-loop-reported-success');
    expect(formatObservationReport(report)).toContain('sandbox evidence: 1');
    expect(formatObservationReport(report)).toContain('recent activity:');
  });

  it('keeps the recorded goal state and derives interruption from its halted parent loop', () => {
    const report = buildObservationReport({
      goals: [
        {
          path: 'data/goals/L-stop-g0.jsonl',
          records: [
            {
              t: 'goal-created',
              id: 'L-stop-g0',
              objective: 'inspect the release evidence',
              objectiveHash: 'hash',
              budget: { maxRounds: 3 },
              sessionId: 'L-stop-g0',
              createdAt: '2026-07-03T20:01:28.000Z',
            },
          ],
        },
      ],
      loops: [
        {
          path: 'data/loops/L-stop.jsonl',
          records: [
            {
              t: 'loop-created',
              id: 'L-stop',
              contract: CONTRACT,
              objectives: ['inspect the release evidence'],
              createdAt: '2026-07-03T20:01:28.000Z',
            },
            { t: 'goal-started', index: 0, goalId: 'L-stop-g0', at: '2026-07-03T20:01:28.100Z' },
            { t: 'loop-halted', reason: 'emergency-stop', at: '2026-07-03T20:01:55.000Z' },
          ],
        },
      ],
    });

    expect(report.status.latestGoal).toMatchObject({
      id: 'L-stop-g0',
      state: 'active',
      recordedState: 'active',
      effectiveState: 'interrupted',
      effectiveReason: 'emergency-stop',
      effectiveSource: { kind: 'loop-halt', loopId: 'L-stop' },
    });
    expect(report.status.goals.byState.active).toBe(1);
    expect(formatObservationReport(report)).toContain(
      'latest goal: L-stop-g0 interrupted recorded=active reason=emergency-stop source=loop:L-stop',
    );
  });

  it('warns on legacy daemon success records linked to a blocked loop', () => {
    const report = buildObservationReport({
      loops: [
        {
          path: 'data/loops/L-old.jsonl',
          records: [
            { t: 'loop-created', id: 'L-old', contract: CONTRACT, objectives: ['inspect'], createdAt: 't0' },
            { t: 'goal-finished', index: 0, goalId: 'g0', state: 'blocked', rounds: 1, tokens: 0, at: 't1' },
            { t: 'loop-halted', reason: 'queue-empty', at: 't2' },
          ],
        },
      ],
      cronDaemon: {
        path: 'data/cron/loop-cron-daemon.jsonl',
        records: [
          { t: 'scan-started', at: '2026-07-03T10:00:00.000Z' },
          {
            t: 'task-finished',
            taskId: 'daily',
            scheduledFor: '2026-07-03T10:00:00.000Z',
            startedAt: '2026-07-03T10:00:01.000Z',
            finishedAt: '2026-07-03T10:00:02.000Z',
            exitCode: 0,
            loopId: 'L-old',
          },
          { t: 'scan-finished', at: '2026-07-03T10:00:03.000Z', triggered: 1, skipped: 0, parked: 0 },
        ],
      },
    });

    expect(report.activity.recent).toContainEqual(
      expect.objectContaining({
        title: 'Cron task daily finished',
        detail: 'exit 0 / linked loop has blocked goals',
        tone: 'warn',
      }),
    );
    expect(report.activity.recent).toContainEqual(
      expect.objectContaining({
        title: 'Cron scan finished',
        detail: expect.stringContaining('legacy linked-loop inconsistency'),
        tone: 'warn',
      }),
    );
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
    expect(report.activity.recent).toContainEqual(expect.objectContaining({ kind: 'approval', title: 'Approval deny' }));
    expect(report.integrity).toEqual({
      status: 'partial',
      corruptLineCount: 1,
      unreadableFileCount: 0,
      affected: [{ kind: 'malformed-tail', path: 'sessions/s1.jsonl', line: 3 }],
      omittedAffectedCount: 0,
    });
    expect(formatObservationReport(report)).toContain('integrity: partial corruptLines=1 unreadableFiles=0');
    expect(formatObservationReport(report)).toContain('- malformed-tail sessions/s1.jsonl:3');
  });

  it('reports malformed middle lines and unreadable optional JSONL files while missing sources stay clean', async () => {
    await mkdir(join(dir, 'data', 'sessions'), { recursive: true });
    await writeFile(
      join(dir, 'data', 'sessions', 's1.jsonl'),
      '{"t":"session","id":"s1","model":"builder","cwd":"cwd","startedAt":"t0"}\n' +
        '{not valid json}\n' +
        '{"t":"message","message":{"role":"user","content":"hello"}}\n',
      'utf8',
    );
    await mkdir(join(dir, 'data', 'cron', 'loop-cron.jsonl'), { recursive: true });

    const report = await loadWorkspaceObservation(join(dir, 'data'));

    expect(report.status.sessions.total).toBe(1);
    expect(report.usage.sessionMessages).toBe(1);
    expect(report.integrity).toEqual({
      status: 'partial',
      corruptLineCount: 1,
      unreadableFileCount: 1,
      affected: [
        { kind: 'malformed-middle', path: 'sessions/s1.jsonl', line: 2 },
        { kind: 'unreadable', path: 'cron/loop-cron.jsonl' },
      ],
      omittedAffectedCount: 0,
    });
  });

  it('reports v2 sequence corruption and pending tool effects', async () => {
    await mkdir(join(dir, 'data', 'sessions'), { recursive: true });
    const records = [
      {
        schemaVersion: 2,
        seq: 1,
        at: 't0',
        t: 'session',
        id: 's-v2',
        model: 'builder',
        cwd: 'cwd',
        startedAt: 't0',
        composition: {
          root: 'repl',
          runtimeVersion: '0.1.0',
          permissionMode: 'interactive',
          coverage: 'partial',
        },
      },
      {
        schemaVersion: 2,
        seq: 2,
        at: 't1',
        t: 'message',
        message: {
          role: 'assistant',
          requestId: 'req-1',
          toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"a.txt","content":"x","createOnly":true}' }],
        },
      },
      {
        schemaVersion: 2,
        seq: 4,
        at: 't2',
        t: 'tool',
        phase: 'planned',
        executionId: 'exec-1',
        requestId: 'req-1',
        runId: 'run-1',
        turn: 0,
        callIndex: 0,
        call: { id: 'call-1', name: 'write', arguments: '{"path":"a.txt","content":"x","createOnly":true}' },
      },
    ];
    await writeFile(
      join(dir, 'data', 'sessions', 's-v2.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );

    const report = await loadWorkspaceObservation(join(dir, 'data'));

    expect(report.status.latestSession).toMatchObject({ id: 's-v2', format: 'v2', pendingTools: 1 });
    expect(report.integrity).toMatchObject({
      status: 'partial',
      corruptLineCount: 1,
      affected: [{ kind: 'session-sequence', path: 'sessions/s-v2.jsonl', line: 3 }],
    });
    expect(formatObservationReport(report)).toContain('format=v2 messages=1 pendingTools=1');
    expect(formatObservationReport(report)).toContain('resume is blocked until pending tool effects are reviewed');
  });
});
