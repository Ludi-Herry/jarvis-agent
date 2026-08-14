import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { redactSecrets } from '../../core/model/errors.js';
import {
  assertOperationalJsonlIntegrity,
  hasFiniteNumberFields,
  hasStringFields,
  isJsonObject,
  parseJsonlWithDiagnostics,
} from '../../runtime/jsonl-integrity.js';
import type {
  DeterministicChecks,
  GoalState,
  PinnedRequirement,
  Verdict,
  VerdictOutcome,
  VerifierReport,
} from './goal.js';
import { decideVerdict } from './verdict.js';
import {
  isGoalRecord,
  replayGoal,
  serializeGoalRecord,
} from './goal-store.js';
import {
  isLoopRecord,
  serializeLoopRecord,
  type LoopRecord,
} from './loop-store.js';

export type HumanReviewDecisionValue = 'approve' | 'reject';

export interface HumanReviewDecisionInput {
  requirementId: string;
  decision: HumanReviewDecisionValue;
  note: string;
}

export interface PendingHumanReviewRequirement {
  requirementId: string;
  text: string;
  reason: string;
}

export interface PendingHumanReview {
  goalId: string;
  objective: string;
  state: GoalState;
  verdict: VerdictOutcome;
  round: number;
  lastAt: string;
  requirements: PendingHumanReviewRequirement[];
  pinned: PinnedRequirement[];
  report: VerifierReport;
  checks: DeterministicChecks;
}

export interface HumanReviewAuditRecord {
  t: 'human-review-decision';
  goalId: string;
  reviewer: string;
  at: string;
  previousRound: number;
  decisions: HumanReviewDecisionInput[];
  verdict: VerdictOutcome;
  state: GoalState;
}

export interface ApplyHumanReviewDecisionInput {
  dataDir: string;
  goalId: string;
  reviewer?: string;
  at?: string;
  decisions: HumanReviewDecisionInput[];
}

export interface ApplyHumanReviewDecisionResult {
  goalId: string;
  state: GoalState;
  verdict: Verdict;
  report: VerifierReport;
  round: number;
  audit: HumanReviewAuditRecord;
  loop?: { loopId: string; index: number };
}

export class HumanReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HumanReviewError';
  }
}

const SAFE_LOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HUMAN_REVIEW_PREFIX = 'human verification required for ';
const MAX_NOTE_LENGTH = 1000;
const MAX_REVIEWER_LENGTH = 100;
const MAX_DISPLAY_TEXT_LENGTH = 4000;

export async function listPendingHumanReviews(dataDir: string): Promise<PendingHumanReview[]> {
  const entries = await jsonlEntries(join(dataDir, 'goals'));
  const reviews: PendingHumanReview[] = [];
  for (const entry of entries) {
    const goalId = basename(entry, '.jsonl');
    if (!isSafeLogId(goalId)) continue;
    const review = await loadPendingHumanReview(dataDir, goalId);
    if (review !== undefined) reviews.push(displaySafePendingReview(review));
  }
  return reviews.sort((a, b) => a.lastAt.localeCompare(b.lastAt));
}

export async function applyHumanReviewDecision(
  input: ApplyHumanReviewDecisionInput,
): Promise<ApplyHumanReviewDecisionResult> {
  assertSafeLogId(input.goalId);
  const pending = await loadPendingHumanReview(input.dataDir, input.goalId);
  if (pending === undefined) {
    throw new HumanReviewError(404, `no pending human review for goal: ${input.goalId}`);
  }

  const decisions = normalizeDecisions(input.decisions, pending.requirements);
  const reviewer = normalizeReviewer(input.reviewer);
  const at = input.at ?? new Date().toISOString();
  const report = applyDecisionsToReport(pending.report, decisions, reviewer, at);
  const verdict = decideVerdict(pending.checks, report, pending.pinned);
  const state: GoalState = verdict.outcome === 'verified' ? 'complete' : 'blocked';
  const round = pending.round + 1;

  const audit: HumanReviewAuditRecord = {
    t: 'human-review-decision',
    goalId: input.goalId,
    reviewer,
    at,
    previousRound: pending.round,
    decisions,
    verdict: verdict.outcome,
    state,
  };

  const goalPath = join(input.dataDir, 'goals', `${input.goalId}.jsonl`);
  await appendFile(
    goalPath,
    serializeGoalRecord({
      t: 'goal-round',
      round,
      turns: 0,
      tokens: 0,
      checks: pending.checks,
      verdict,
      at,
    }) + serializeGoalRecord({ t: 'goal-state', state, at }),
    'utf8',
  );

  await mkdir(join(input.dataDir, 'human-reviews'), { recursive: true });
  await appendFile(
    join(input.dataDir, 'human-reviews', `${input.goalId}.jsonl`),
    `${JSON.stringify(audit)}\n`,
    'utf8',
  );

  const loop = await appendLoopFinishIfPresent(input.dataDir, input.goalId, {
    state,
    outcome: verdict.outcome,
    rounds: round,
    tokens: totalTokensFromLatestGoal(input.dataDir, input.goalId),
    at,
  });

  return { goalId: input.goalId, state, verdict, report, round, audit, ...(loop === undefined ? {} : { loop }) };
}

export function parseHumanReviewAuditLog(text: string): HumanReviewAuditRecord[] {
  return parseJsonlWithDiagnostics(text, isHumanReviewAuditRecord).records;
}

export function isHumanReviewAuditRecord(value: unknown): value is HumanReviewAuditRecord {
  return isJsonObject(value)
    && value.t === 'human-review-decision'
    && hasStringFields(value, 'goalId', 'reviewer', 'at')
    && hasFiniteNumberFields(value, 'previousRound')
    && Array.isArray(value.decisions)
    && value.decisions.every((decision) => isJsonObject(decision)
      && hasStringFields(decision, 'requirementId', 'note')
      && (decision.decision === 'approve' || decision.decision === 'reject'))
    && (value.verdict === 'verified'
      || value.verdict === 'checksOnly'
      || value.verdict === 'rejected'
      || value.verdict === 'couldNotVerify')
    && (value.state === 'active' || value.state === 'complete' || value.state === 'blocked');
}

async function loadPendingHumanReview(dataDir: string, goalId: string): Promise<PendingHumanReview | undefined> {
  assertSafeLogId(goalId);
  let text: string;
  try {
    text = await readFile(join(dataDir, 'goals', `${goalId}.jsonl`), 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseJsonlWithDiagnostics(text, isGoalRecord);
  const { goal, rounds } = replayGoal(parsed.records);
  assertOperationalJsonlIntegrity('goal', parsed.malformed, goal !== undefined);
  const latestRound = rounds.at(-1);
  const report = latestRound?.verdict?.report;
  if (
    goal === undefined ||
    latestRound === undefined ||
    latestRound.checks === undefined ||
    latestRound.verdict?.outcome !== 'couldNotVerify' ||
    report === undefined ||
    goal.state !== 'blocked'
  ) {
    return undefined;
  }

  const requirements = humanRequirementsFrom(goal.pinned, report);
  if (requirements.length === 0) return undefined;

  return {
    goalId,
    objective: goal.objective,
    state: goal.state,
    verdict: latestRound.verdict.outcome,
    round: latestRound.round,
    lastAt: latestRound.at,
    requirements,
    pinned: goal.pinned,
    report,
    checks: latestRound.checks,
  };
}

function humanRequirementsFrom(
  pinned: readonly PinnedRequirement[],
  report: VerifierReport,
): PendingHumanReviewRequirement[] {
  const humanPinnedById = new Map(
    pinned
      .filter((requirement) => requirement.route === 'human')
      .map((requirement) => [requirement.id, requirement.text]),
  );
  const cannotVerify = new Set(
    report.perRequirement
      .filter((score) => score.strength === 'cannotVerify')
      .map((score) => score.requirementId),
  );
  const requirements: PendingHumanReviewRequirement[] = [];
  for (const reason of report.couldNotVerify) {
    const parsed = parseHumanReviewReason(reason);
    if (parsed === undefined || !cannotVerify.has(parsed.requirementId)) continue;
    const pinnedText = humanPinnedById.get(parsed.requirementId);
    if (pinnedText === undefined) continue;
    requirements.push({
      requirementId: parsed.requirementId,
      text: pinnedText,
      reason,
    });
  }
  return requirements;
}

function parseHumanReviewReason(reason: string): { requirementId: string; text: string } | undefined {
  if (!reason.startsWith(HUMAN_REVIEW_PREFIX)) return undefined;
  const rest = reason.slice(HUMAN_REVIEW_PREFIX.length);
  const index = rest.indexOf(':');
  if (index <= 0) return undefined;
  const requirementId = rest.slice(0, index).trim();
  if (requirementId === '') return undefined;
  return { requirementId, text: rest.slice(index + 1).trim() };
}

function normalizeDecisions(
  decisions: readonly HumanReviewDecisionInput[],
  requirements: readonly PendingHumanReviewRequirement[],
): HumanReviewDecisionInput[] {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new HumanReviewError(400, 'decisions must include at least one human review decision');
  }
  const pendingIds = new Set(requirements.map((requirement) => requirement.requirementId));
  const seen = new Set<string>();
  return decisions.map((decision) => {
    if (!pendingIds.has(decision.requirementId)) {
      throw new HumanReviewError(400, `unknown human-review requirement: ${decision.requirementId}`);
    }
    if (seen.has(decision.requirementId)) {
      throw new HumanReviewError(400, `duplicate human-review requirement: ${decision.requirementId}`);
    }
    seen.add(decision.requirementId);
    if (decision.decision !== 'approve' && decision.decision !== 'reject') {
      throw new HumanReviewError(400, `invalid human-review decision: ${String(decision.decision)}`);
    }
    const note = safeReviewText(decision.note).slice(0, MAX_NOTE_LENGTH);
    if (note === '') throw new HumanReviewError(400, 'human-review decision note is required');
    return { requirementId: decision.requirementId, decision: decision.decision, note };
  });
}

function normalizeReviewer(reviewer: string | undefined): string {
  const value = safeReviewText(reviewer ?? '').slice(0, MAX_REVIEWER_LENGTH);
  return value === '' ? 'human' : value;
}

function displaySafePendingReview(review: PendingHumanReview): PendingHumanReview {
  return {
    ...review,
    objective: safeReviewText(review.objective),
    requirements: review.requirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      text: safeReviewText(requirement.text),
      reason: safeReviewText(requirement.reason),
    })),
    pinned: review.pinned.map((requirement) => ({
      id: requirement.id,
      text: safeReviewText(requirement.text),
      ...(requirement.route === undefined ? {} : { route: requirement.route }),
    })),
    report: {
      ...review.report,
      expected: safeReviewText(review.report.expected),
      observed: safeReviewText(review.report.observed),
      evidence: safeReviewText(review.report.evidence),
      couldNotVerify: review.report.couldNotVerify.map((reason) => safeReviewText(reason)),
      rationale: safeReviewText(review.report.rationale),
    },
  };
}

function applyDecisionsToReport(
  report: VerifierReport,
  decisions: readonly HumanReviewDecisionInput[],
  reviewer: string,
  at: string,
): VerifierReport {
  const byRequirement = new Map(decisions.map((decision) => [decision.requirementId, decision]));
  const rejected = decisions.some((decision) => decision.decision === 'reject');
  const perRequirement = report.perRequirement.map((score) => {
    const decision = byRequirement.get(score.requirementId);
    if (decision === undefined) return score;
    return {
      requirementId: score.requirementId,
      strength: decision.decision === 'approve' ? 'proves' : 'contradicts',
      scope: 'matched',
    } satisfies VerifierReport['perRequirement'][number];
  });
  const couldNotVerify = report.couldNotVerify.filter((reason) => {
    const parsed = parseHumanReviewReason(reason);
    return parsed === undefined || !byRequirement.has(parsed.requirementId);
  });
  const reviewLines = decisions.map(
    (decision) => `${decision.requirementId}: human ${decision.decision} by ${reviewer} at ${at}; note: ${decision.note}`,
  );
  return {
    ...report,
    feature: report.feature === 'broken' || rejected ? 'broken' : 'works',
    observed: appendSection(report.observed, 'human review observed', reviewLines.join('\n')),
    evidence: appendSection(report.evidence, 'human review evidence', reviewLines.join('\n')),
    perRequirement,
    couldNotVerify,
    rationale:
      rejected
        ? 'Human review rejected one or more requirements.'
        : couldNotVerify.length > 0
          ? 'Human review resolved submitted requirements; other requirements still need verification.'
          : 'Human review verified all submitted human-routed requirements.',
  };
}

async function appendLoopFinishIfPresent(
  dataDir: string,
  goalId: string,
  finish: { state: GoalState; outcome: VerdictOutcome; rounds: number; tokens: Promise<number>; at: string },
): Promise<{ loopId: string; index: number } | undefined> {
  const loop = await findLoopForGoal(dataDir, goalId);
  if (loop === undefined) return undefined;
  await appendFile(
    loop.path,
    serializeLoopRecord({
      t: 'goal-finished',
      index: loop.index,
      goalId,
      state: finish.state,
      outcome: finish.outcome,
      ...(loop.verifierKey === undefined ? {} : { verifierKey: loop.verifierKey }),
      rounds: finish.rounds,
      tokens: await finish.tokens,
      at: finish.at,
    }),
    'utf8',
  );
  return { loopId: loop.loopId, index: loop.index };
}

async function findLoopForGoal(
  dataDir: string,
  goalId: string,
): Promise<{ path: string; loopId: string; index: number; verifierKey?: string } | undefined> {
  const entries = await jsonlEntries(join(dataDir, 'loops'));
  let found: { path: string; loopId: string; index: number; verifierKey?: string } | undefined;
  for (const entry of entries) {
    const path = join(dataDir, 'loops', entry);
    const parsed = parseJsonlWithDiagnostics(await readFile(path, 'utf8'), isLoopRecord);
    const records = parsed.records;
    assertOperationalJsonlIntegrity(
      'loop',
      parsed.malformed,
      records.some((record) => record.t === 'loop-created'),
    );
    const loopId = records.find((record): record is Extract<LoopRecord, { t: 'loop-created' }> => record.t === 'loop-created')
      ?.id ?? basename(entry, '.jsonl');
    for (const record of records) {
      if ((record.t === 'goal-started' || record.t === 'goal-finished') && record.goalId === goalId) {
        found = {
          path,
          loopId,
          index: record.index,
          ...(record.t === 'goal-finished' && record.verifierKey !== undefined
            ? { verifierKey: record.verifierKey }
            : {}),
        };
      }
    }
  }
  return found;
}

async function totalTokensFromLatestGoal(dataDir: string, goalId: string): Promise<number> {
  const text = await readFile(join(dataDir, 'goals', `${goalId}.jsonl`), 'utf8');
  const parsed = parseJsonlWithDiagnostics(text, isGoalRecord);
  const replayed = replayGoal(parsed.records);
  assertOperationalJsonlIntegrity('goal', parsed.malformed, replayed.goal !== undefined);
  return replayed.rounds.reduce((sum, round) => sum + (round.tokens ?? 0), 0);
}

async function jsonlEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((entry) => entry.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

function assertSafeLogId(value: string): void {
  if (!isSafeLogId(value)) throw new HumanReviewError(400, 'goal id must be a safe log filename');
}

function isSafeLogId(value: string): boolean {
  return SAFE_LOG_ID.test(value) && !value.includes('/') && !value.includes('\\');
}

function appendSection(current: string, label: string, body: string): string {
  const trimmedCurrent = current.trim();
  const section = `${label}:\n${body.trim()}`;
  return trimmedCurrent === '' ? section : `${trimmedCurrent}\n\n${section}`;
}

function safeReviewText(text: string): string {
  return redactSecrets(stripUnsafeInline(text)).slice(0, MAX_DISPLAY_TEXT_LENGTH);
}

function stripUnsafeInline(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 32;
    const unsafe =
      code < 32 ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x061c ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    return unsafe ? ' ' : char;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}
