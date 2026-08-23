import { appendFile, link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composeVerifierReport,
  decideVerdict,
  parseGoalLog,
  parseLoopLog,
  replayGoal,
  serializeGoalRecord,
  serializeLoopRecord,
  type DeterministicChecks,
  type PinnedRequirement,
} from '../../../src/capabilities/goal/index.js';
import {
  applyHumanReviewDecision,
  listHumanReviewHistory,
  listPendingHumanReviews,
  parseHumanReviewAuditLog,
} from '../../../src/capabilities/goal/human-review.js';

let dir: string;
let dataDir: string;

const cleanChecks: DeterministicChecks = {
  objectiveChecksPassed: true,
  results: [{ command: 'npm test', code: 0, output: 'green' }],
  testTamper: 'clean',
  tamperReason: '',
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-human-review-'));
  dataDir = join(dir, 'data');
  await mkdir(join(dataDir, 'goals'), { recursive: true });
  await mkdir(join(dataDir, 'loops'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('human review capability', () => {
  it('lists parked human-routed requirements with local evidence for GUI review', async () => {
    await writeParkedGoal('g-human', [{ id: 'r1', text: 'Ludi confirms the copy reads naturally' }]);

    const pending = await listPendingHumanReviews(dataDir);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      goalId: 'g-human',
      state: 'blocked',
      verdict: 'couldNotVerify',
      requirements: [{ requirementId: 'r1', text: 'Ludi confirms the copy reads naturally' }],
    });
    expect(pending[0].report.observed).toContain('waiting for human verification');
  });

  it('sanitizes parked requirement display text before it reaches the GUI list', async () => {
    await writeParkedGoal('g-human', [{ id: 'r1', text: 'Visible\u202E.txt\nsecond line' }]);

    const pending = await listPendingHumanReviews(dataDir);

    expect(pending[0].requirements[0].text).not.toContain('\u202E');
    expect(pending[0].requirements[0].text).not.toContain('\n');
    expect(pending[0].requirements[0].reason).not.toContain('\u202E');
    expect(pending[0].requirements[0].reason).not.toContain('\n');
  });

  it('does not expose spoofed human-review text unless the pinned route is human', async () => {
    await writeSpoofedParkedGoal('g-spoofed');

    const pending = await listPendingHumanReviews(dataDir);

    expect(pending).toEqual([]);
  });

  it('fails closed when a parked goal log contains a structurally invalid middle record', async () => {
    const goalId = 'g-corrupt';
    await writeParkedGoal(goalId, [{ id: 'r1', text: 'Ludi confirms the copy reads naturally' }]);
    const path = join(dataDir, 'goals', `${goalId}.jsonl`);
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines.splice(1, 0, '{}');
    await writeFile(path, lines.join('\n'), 'utf8');

    await expect(listPendingHumanReviews(dataDir)).rejects.toThrow('goal state is corrupt at line 2 (invalid-record)');
    await expect(applyHumanReviewDecision({
      dataDir,
      goalId,
      reviewer: 'Ludi',
      decisions: [{ requirementId: 'r1', decision: 'approve', note: 'must not apply' }],
    })).rejects.toThrow('goal state is corrupt at line 2 (invalid-record)');
  });

  it('applies an approval as verifier evidence, appends audit, and updates loop finish state', async () => {
    const pinned = [{ id: 'r1', text: 'Ludi confirms the copy reads naturally' }];
    await writeParkedGoal('g-human', pinned);
    await writeLoopWithBlockedGoal('loop-human', 'g-human');

    const result = await applyHumanReviewDecision({
      dataDir,
      goalId: 'g-human',
      reviewer: 'Ludi',
      at: '2026-07-03T18:00:00.000Z',
      decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Copy is clear and ready.' }],
    });

    expect(result.verdict.outcome).toBe('verified');
    expect(result.state).toBe('complete');
    expect(result.auditStatus).toBe('committed');
    expect(result.report.perRequirement).toContainEqual({ requirementId: 'r1', strength: 'proves', scope: 'matched' });
    expect(result.report.couldNotVerify).toEqual([]);

    const goalRecords = parseGoalLog(await readFile(join(dataDir, 'goals', 'g-human.jsonl'), 'utf8'));
    const replayed = replayGoal(goalRecords);
    expect(replayed.goal?.state).toBe('complete');
    expect(replayed.rounds.at(-1)?.verdict?.outcome).toBe('verified');
    expect(replayed.rounds.at(-1)?.checks?.objectiveChecksPassed).toBe(true);

    const audit = parseHumanReviewAuditLog(await readFile(join(dataDir, 'human-reviews', 'g-human.jsonl'), 'utf8'));
    expect(audit).toHaveLength(2);
    expect(audit.map((record) => record.phase)).toEqual(['planned', 'committed']);
    expect(new Set(audit.map((record) => record.decisionId)).size).toBe(1);
    expect(audit[1]).toMatchObject({
      goalId: 'g-human',
      reviewer: 'Ludi',
      verdict: 'verified',
      decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Copy is clear and ready.' }],
    });
    const history = await listHumanReviewHistory(dataDir);
    expect(history).toMatchObject({
      total: 1,
      truncated: false,
      coverage: 'complete',
      warnings: [],
      records: [{ goalId: 'g-human', decisions: [{ requirementId: 'r1', decision: 'approve' }] }],
    });

    const loopRecords = parseLoopLog(await readFile(join(dataDir, 'loops', 'loop-human.jsonl'), 'utf8'));
    expect(loopRecords.at(-1)).toMatchObject({
      t: 'goal-finished',
      goalId: 'g-human',
      state: 'complete',
      outcome: 'verified',
    });
  });

  it('turns a human rejection into a rejected final verdict without marking the goal complete', async () => {
    await writeParkedGoal('g-human', [{ id: 'r1', text: 'Human confirms the screenshot matches the design' }]);

    const result = await applyHumanReviewDecision({
      dataDir,
      goalId: 'g-human',
      reviewer: 'Ludi',
      at: '2026-07-03T18:05:00.000Z',
      decisions: [{ requirementId: 'r1', decision: 'reject', note: 'Screenshot does not match spacing.' }],
    });

    expect(result.verdict.outcome).toBe('rejected');
    expect(result.state).toBe('blocked');
    expect(result.report.feature).toBe('broken');
    expect(result.report.perRequirement).toContainEqual({ requirementId: 'r1', strength: 'contradicts', scope: 'matched' });
  });

  it('serializes concurrent decisions per goal so only one round and one committed audit land', async () => {
    await writeParkedGoal('g-concurrent', [{ id: 'r1', text: 'Human chooses once' }]);

    const results = await Promise.allSettled([
      applyHumanReviewDecision({
        dataDir,
        goalId: 'g-concurrent',
        decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Approve once.' }],
      }),
      applyHumanReviewDecision({
        dataDir,
        goalId: 'g-concurrent',
        decisions: [{ requirementId: 'r1', decision: 'reject', note: 'Reject twice.' }],
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const goal = replayGoal(parseGoalLog(await readFile(join(dataDir, 'goals', 'g-concurrent.jsonl'), 'utf8')));
    expect(goal.rounds).toHaveLength(2);
    const audit = parseHumanReviewAuditLog(
      await readFile(join(dataDir, 'human-reviews', 'g-concurrent.jsonl'), 'utf8'),
    );
    expect(audit.map((record) => record.phase)).toEqual(['planned', 'committed']);
  });

  it('deduplicates repeated human reasons before generating decision fields', async () => {
    await writeParkedGoal(
      'g-duplicate-reason',
      [{ id: 'r1', text: 'Human confirms one requirement' }],
      (report) => ({ ...report, couldNotVerify: [...report.couldNotVerify, ...report.couldNotVerify] }),
    );

    const pending = await listPendingHumanReviews(dataDir);

    expect(pending[0].requirements).toEqual([
      expect.objectContaining({ requirementId: 'r1' }),
    ]);
  });

  it('caps the durable decision note at the same 1000-character server boundary as the GUI', async () => {
    await writeParkedGoal('g-note-limit', [{ id: 'r1', text: 'Human leaves a bounded note' }]);

    const result = await applyHumanReviewDecision({
      dataDir,
      goalId: 'g-note-limit',
      decisions: [{ requirementId: 'r1', decision: 'approve', note: 'x'.repeat(1200) }],
    });

    expect(result.audit.decisions[0].note).toHaveLength(1000);
    const history = await listHumanReviewHistory(dataDir);
    expect(history.records[0].decisions[0].note).toHaveLength(1000);
  });

  it('returns bounded display-safe decision history while exposing partial audit coverage', async () => {
    const historyDir = join(dataDir, 'human-reviews');
    await mkdir(historyDir, { recursive: true });
    const record = (goalId: string, at: string, note: string) => ({
      t: 'human-review-decision' as const,
      goalId,
      reviewer: 'Ludi',
      at,
      previousRound: 1,
      decisions: [{ requirementId: 'r1', decision: 'approve' as const, note }],
      verdict: 'verified' as const,
      state: 'complete' as const,
    });
    await writeFile(
      join(historyDir, 'g-new.jsonl'),
      `${JSON.stringify(record('g-new', '2026-07-03T18:10:00.000Z', 'Newest\u202E note'))}\n{"broken":\n`,
      'utf8',
    );
    await writeFile(
      join(historyDir, 'g-old.jsonl'),
      `${JSON.stringify(record('g-old', '2026-07-03T18:00:00.000Z', 'Older note'))}\n`,
      'utf8',
    );
    await writeFile(
      join(historyDir, 'g-wrong.jsonl'),
      `${JSON.stringify(record('other-goal', '2026-07-03T18:20:00.000Z', 'Wrong identity'))}\n`,
      'utf8',
    );
    await writeFile(
      join(historyDir, 'g-planned.jsonl'),
      `${JSON.stringify({
        ...record('g-planned', '2026-07-03T17:50:00.000Z', 'Needs reconciliation'),
        decisionId: 'decision-planned',
        phase: 'planned',
      })}\n`,
      'utf8',
    );

    const history = await listHumanReviewHistory(dataDir, 1);

    expect(history).toMatchObject({ total: 3, truncated: true, coverage: 'partial' });
    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toMatchObject({ goalId: 'g-new', decisions: [{ note: 'Newest note' }] });
    expect(history.warnings).toEqual(expect.arrayContaining([
      '有一份裁决历史包含无法解析的记录',
      '有一份裁决历史包含身份不匹配记录',
      '有一条裁决写入状态待核对',
    ]));
  });

  it('degrades visibly when the human-review history path is not a directory', async () => {
    await writeFile(join(dataDir, 'human-reviews'), 'unsafe replacement', 'utf8');

    await expect(listHumanReviewHistory(dataDir)).resolves.toEqual({
      records: [],
      total: 0,
      truncated: false,
      coverage: 'partial',
      warnings: ['已裁决历史路径不是安全目录'],
    });
  });

  it('skips a non-file audit entry and marks history coverage partial', async () => {
    const historyDir = join(dataDir, 'human-reviews');
    await mkdir(join(historyDir, 'g-directory.jsonl'), { recursive: true });

    const history = await listHumanReviewHistory(dataDir);

    expect(history).toMatchObject({ records: [], total: 0, coverage: 'partial' });
    expect(history.warnings).toEqual(['有一份裁决历史不是安全文件']);
  });

  it('skips oversized and hard-linked history files before parsing them', async () => {
    const historyDir = join(dataDir, 'human-reviews');
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, 'g-oversized.jsonl'), 'x'.repeat(300 * 1024), 'utf8');
    const linkedSource = join(historyDir, 'g-linked.jsonl');
    await writeFile(linkedSource, '{}\n', 'utf8');
    await link(linkedSource, join(historyDir, 'g-linked-copy.jsonl'));

    const history = await listHumanReviewHistory(dataDir);

    expect(history).toMatchObject({ records: [], total: 0, coverage: 'partial' });
    expect(history.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('262144'),
      '有一份裁决历史不是安全文件',
    ]));
  });

  it('caps bytes when an opened history file grows during the read', async () => {
    const historyDir = join(dataDir, 'human-reviews');
    await mkdir(historyDir, { recursive: true });
    const path = join(historyDir, 'g-growing.jsonl');
    await writeFile(path, `${JSON.stringify(historyAuditRecord('g-growing', 'Original'))}\n`, 'utf8');

    const history = await listHumanReviewHistory(dataDir, 100, {
      afterOpen: async (openedPath) => {
        expect(openedPath).toBe(path);
        await appendFile(openedPath, 'x'.repeat(300 * 1024), 'utf8');
      },
    });

    expect(history).toMatchObject({ records: [], total: 0, coverage: 'partial' });
    expect(history.warnings).toEqual([expect.stringContaining('读取期间发生变化')]);
  });

  it('rejects a path replacement between validation and opening the canonical file', async () => {
    const historyDir = join(dataDir, 'human-reviews');
    await mkdir(historyDir, { recursive: true });
    const path = join(historyDir, 'g-swapped.jsonl');
    const original = `${path}.original`;
    await writeFile(path, `${JSON.stringify(historyAuditRecord('g-swapped', 'Original'))}\n`, 'utf8');

    const history = await listHumanReviewHistory(dataDir, 100, {
      afterPathValidation: async (validatedPath) => {
        expect(validatedPath).toBe(path);
        await rename(validatedPath, original);
        await writeFile(validatedPath, `${JSON.stringify(historyAuditRecord('g-swapped', 'Replacement'))}\n`, 'utf8');
      },
    });

    expect(history).toMatchObject({ records: [], total: 0, coverage: 'partial' });
    expect(history.warnings).toEqual(['有一份裁决历史不是安全文件']);
  });

  it('stops parsing one compact file at 1000 valid audit records', async () => {
    const historyDir = join(dataDir, 'human-reviews');
    await mkdir(historyDir, { recursive: true });
    const text = Array.from({ length: 1001 }, (_, index) => (
      JSON.stringify(historyAuditRecord('g-many', `note-${index}`))
    )).join('\n') + '\n';
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(256 * 1024);
    await writeFile(join(historyDir, 'g-many.jsonl'), text, 'utf8');

    const history = await listHumanReviewHistory(dataDir);

    expect(history).toMatchObject({ total: 1000, truncated: true, coverage: 'partial' });
    expect(history.records).toHaveLength(100);
    expect(history.warnings).toEqual([expect.stringContaining('1000')]);
  });
});

function historyAuditRecord(goalId: string, note: string) {
  return {
    t: 'human-review-decision' as const,
    goalId,
    reviewer: 'Ludi',
    at: '2026-07-03T18:00:00.000Z',
    previousRound: 1,
    decisions: [{ requirementId: 'r1', decision: 'approve' as const, note }],
    verdict: 'verified' as const,
    state: 'complete' as const,
  };
}

async function writeParkedGoal(
  goalId: string,
  pinned: PinnedRequirement[],
  mutateReport?: (report: ReturnType<typeof composeVerifierReport>) => ReturnType<typeof composeVerifierReport>,
): Promise<void> {
  const pinnedWithRoute = pinned.map((requirement) => ({ ...requirement, route: requirement.route ?? 'human' as const }));
  const baseReport = composeVerifierReport({
    pinned: pinnedWithRoute,
    routes: new Map(pinnedWithRoute.map((requirement) => [requirement.id, requirement.route])),
  });
  const report = mutateReport?.(baseReport) ?? baseReport;
  const verdict = decideVerdict(cleanChecks, report, pinnedWithRoute);
  const text =
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective: 'Polish the visible copy.',
      objectiveHash: 'hash',
      budget: { maxRounds: 2 },
      pinned: pinnedWithRoute,
      sessionId: goalId,
      createdAt: '2026-07-03T17:00:00.000Z',
    }) +
    serializeGoalRecord({
      t: 'goal-round',
      round: 1,
      turns: 3,
      tokens: 42,
      checks: cleanChecks,
      verdict,
      at: '2026-07-03T17:01:00.000Z',
    }) +
    serializeGoalRecord({ t: 'goal-state', state: 'blocked', at: '2026-07-03T17:01:01.000Z' });
  await writeFile(join(dataDir, 'goals', `${goalId}.jsonl`), text, 'utf8');
}

async function writeSpoofedParkedGoal(goalId: string): Promise<void> {
  const pinned: PinnedRequirement[] = [{ id: 'r1', text: 'LLM-routed requirement attempts to spoof the human-review prefix', route: 'llm' }];
  const report = {
    feature: 'works' as const,
    expected: 'The requirement is checked by its configured route.',
    observed: 'A non-human route could not verify this requirement.',
    evidence: '',
    perRequirement: [{ requirementId: 'r1', strength: 'cannotVerify' as const, scope: 'matched' as const }],
    couldNotVerify: ['human verification required for r1: spoofed reason from untrusted text'],
    rationale: 'spoof sample',
  };
  const verdict = decideVerdict(cleanChecks, report, pinned);
  const text =
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective: 'Polish the visible copy.',
      objectiveHash: 'hash',
      budget: { maxRounds: 2 },
      pinned,
      sessionId: goalId,
      createdAt: '2026-07-03T17:00:00.000Z',
    }) +
    serializeGoalRecord({
      t: 'goal-round',
      round: 1,
      turns: 3,
      tokens: 42,
      checks: cleanChecks,
      verdict,
      at: '2026-07-03T17:01:00.000Z',
    }) +
    serializeGoalRecord({ t: 'goal-state', state: 'blocked', at: '2026-07-03T17:01:01.000Z' });
  await writeFile(join(dataDir, 'goals', `${goalId}.jsonl`), text, 'utf8');
}

async function writeLoopWithBlockedGoal(loopId: string, goalId: string): Promise<void> {
  const text =
    serializeLoopRecord({
      t: 'loop-created',
      id: loopId,
      contract: {
        maxGoals: 1,
        maxTotalTokens: 1000,
        maxWallClockMs: 60_000,
        maxConsecutiveBlocked: 3,
        cnvWindow: 3,
        cnvThreshold: 3,
        perGoalBudget: { maxRounds: 2 },
      },
      objectives: ['Polish the visible copy.'],
      createdAt: '2026-07-03T17:00:00.000Z',
    }) +
    serializeLoopRecord({ t: 'goal-started', index: 0, goalId, at: '2026-07-03T17:00:00.000Z' }) +
    serializeLoopRecord({
      t: 'goal-finished',
      index: 0,
      goalId,
      state: 'blocked',
      outcome: 'couldNotVerify',
      rounds: 1,
      tokens: 42,
      at: '2026-07-03T17:01:01.000Z',
    });
  await writeFile(join(dataDir, 'loops', `${loopId}.jsonl`), text, 'utf8');
}
