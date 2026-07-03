import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    await writeParkedGoal('g-human', [{ id: 'r1', text: 'Luis confirms the copy reads naturally' }]);

    const pending = await listPendingHumanReviews(dataDir);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      goalId: 'g-human',
      state: 'blocked',
      verdict: 'couldNotVerify',
      requirements: [{ requirementId: 'r1', text: 'Luis confirms the copy reads naturally' }],
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

  it('applies an approval as verifier evidence, appends audit, and updates loop finish state', async () => {
    const pinned = [{ id: 'r1', text: 'Luis confirms the copy reads naturally' }];
    await writeParkedGoal('g-human', pinned);
    await writeLoopWithBlockedGoal('loop-human', 'g-human');

    const result = await applyHumanReviewDecision({
      dataDir,
      goalId: 'g-human',
      reviewer: 'Luis',
      at: '2026-07-03T18:00:00.000Z',
      decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Copy is clear and ready.' }],
    });

    expect(result.verdict.outcome).toBe('verified');
    expect(result.state).toBe('complete');
    expect(result.report.perRequirement).toContainEqual({ requirementId: 'r1', strength: 'proves', scope: 'matched' });
    expect(result.report.couldNotVerify).toEqual([]);

    const goalRecords = parseGoalLog(await readFile(join(dataDir, 'goals', 'g-human.jsonl'), 'utf8'));
    const replayed = replayGoal(goalRecords);
    expect(replayed.goal?.state).toBe('complete');
    expect(replayed.rounds.at(-1)?.verdict?.outcome).toBe('verified');
    expect(replayed.rounds.at(-1)?.checks?.objectiveChecksPassed).toBe(true);

    const audit = parseHumanReviewAuditLog(await readFile(join(dataDir, 'human-reviews', 'g-human.jsonl'), 'utf8'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      goalId: 'g-human',
      reviewer: 'Luis',
      verdict: 'verified',
      decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Copy is clear and ready.' }],
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
      reviewer: 'Luis',
      at: '2026-07-03T18:05:00.000Z',
      decisions: [{ requirementId: 'r1', decision: 'reject', note: 'Screenshot does not match spacing.' }],
    });

    expect(result.verdict.outcome).toBe('rejected');
    expect(result.state).toBe('blocked');
    expect(result.report.feature).toBe('broken');
    expect(result.report.perRequirement).toContainEqual({ requirementId: 'r1', strength: 'contradicts', scope: 'matched' });
  });
});

async function writeParkedGoal(goalId: string, pinned: PinnedRequirement[]): Promise<void> {
  const pinnedWithRoute = pinned.map((requirement) => ({ ...requirement, route: requirement.route ?? 'human' as const }));
  const report = composeVerifierReport({
    pinned: pinnedWithRoute,
    routes: new Map(pinnedWithRoute.map((requirement) => [requirement.id, requirement.route])),
  });
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
