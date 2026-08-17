/**
 * CLI surface for human review of parked human-routed requirements
 * (`jarvis review list|show|approve|reject`).
 *
 * This is a thin adapter over the existing capability layer
 * (`capabilities/goal/human-review.ts`): pending detection, decision
 * normalization, verdict recomputation via `decideVerdict`, goal/loop log
 * appends, and the human-reviews audit all stay there. `list`/`show` are
 * observation-only; `approve`/`reject` record human evidence (authority
 * `human-review`) — any completion still comes only from the recorded
 * `decideVerdict` output, never from this CLI.
 *
 * Exit contract: list/show exit 0 (including an empty pending list), 2 for
 * unknown/unsafe goal ids, 7 for corrupt goal/loop logs. approve/reject exit
 * 0 when the decision is recorded (the output states the resulting verdict,
 * state, and remaining parked requirements), 2 for usage errors (no pending
 * review, unknown/duplicate requirement, empty note, unsafe id), 5 for
 * runtime I/O failures, 7 for corrupt logs.
 *
 * JSON contract: versioned (schemaVersion 1), additive-only, no ANSI.
 */
import { join } from 'node:path';
import {
  applyHumanReviewDecision,
  HumanReviewError,
  listPendingHumanReviews,
  type HumanReviewDecisionValue,
  type PendingHumanReview,
} from '../../capabilities/goal/index.js';
import { safeInline } from './approval.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';

const OBSERVATION_AUTHORITY = {
  mode: 'observation-only',
  canCompleteGoals: false,
  canCompleteLoops: false,
} as const;

const HUMAN_REVIEW_AUTHORITY = {
  mode: 'human-review',
  canCompleteGoals: false,
  canCompleteLoops: false,
} as const;

export interface ReviewListItem {
  goalId: string;
  objective: string;
  round: number;
  lastAt: string;
  pendingRequirements: number;
  requirementIds: string[];
}

export interface ReviewListReport {
  schemaVersion: 1;
  authority: typeof OBSERVATION_AUTHORITY;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  reviews: ReviewListItem[];
}

export type ReviewListResult =
  | { status: 'ok'; report: ReviewListReport }
  | { status: 'corrupt'; reason: string };

export async function buildReviewListReport(input: {
  cwd: string;
  generatedAt?: string;
}): Promise<ReviewListResult> {
  const dataDir = join(input.cwd, 'data');
  try {
    const reviews = await listPendingHumanReviews(dataDir);
    return {
      status: 'ok',
      report: {
        schemaVersion: 1,
        authority: OBSERVATION_AUTHORITY,
        source: { cwd: input.cwd, dataDir },
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        reviews: reviews.map(toListItem),
      },
    };
  } catch (err) {
    return corruptOrThrow(err);
  }
}

export interface ReviewShowReport {
  schemaVersion: 1;
  authority: typeof OBSERVATION_AUTHORITY;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  review: {
    goalId: string;
    objective: string;
    state: string;
    verdict: string;
    round: number;
    lastAt: string;
    pinned: Array<{ id: string; text: string; route?: string }>;
    requirements: Array<{ requirementId: string; text: string; reason: string }>;
    report: {
      feature: string;
      expected: string;
      observed: string;
      evidence: string;
      couldNotVerify: string[];
      rationale: string;
    };
    checks: { objectiveChecksPassed: boolean; testTamper: string; commandCount: number };
  };
}

export type ReviewShowResult =
  | { status: 'ok'; report: ReviewShowReport }
  | { status: 'not-found'; goalId: string }
  | { status: 'corrupt'; reason: string };

export async function buildReviewShowReport(input: {
  cwd: string;
  goalId: string;
  generatedAt?: string;
}): Promise<ReviewShowResult> {
  const dataDir = join(input.cwd, 'data');
  try {
    const reviews = await listPendingHumanReviews(dataDir);
    const review = reviews.find((candidate) => candidate.goalId === input.goalId);
    if (review === undefined) return { status: 'not-found', goalId: input.goalId };
    return {
      status: 'ok',
      report: {
        schemaVersion: 1,
        authority: OBSERVATION_AUTHORITY,
        source: { cwd: input.cwd, dataDir },
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        review: {
          goalId: review.goalId,
          objective: review.objective,
          state: review.state,
          verdict: review.verdict,
          round: review.round,
          lastAt: review.lastAt,
          pinned: review.pinned.map((requirement) => ({
            id: requirement.id,
            text: requirement.text,
            ...(requirement.route === undefined ? {} : { route: requirement.route }),
          })),
          requirements: review.requirements.map((requirement) => ({ ...requirement })),
          report: {
            feature: review.report.feature,
            expected: review.report.expected,
            observed: review.report.observed,
            evidence: review.report.evidence,
            couldNotVerify: [...review.report.couldNotVerify],
            rationale: review.report.rationale,
          },
          checks: {
            objectiveChecksPassed: review.checks.objectiveChecksPassed,
            testTamper: review.checks.testTamper,
            commandCount: review.checks.results.length,
          },
        },
      },
    };
  } catch (err) {
    return corruptOrThrow(err);
  }
}

export interface ReviewDecisionReport {
  schemaVersion: 1;
  authority: typeof HUMAN_REVIEW_AUTHORITY;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  decision: {
    goalId: string;
    requirementId: string;
    decision: HumanReviewDecisionValue;
    reviewer: string;
    note: string;
    verdict: string;
    state: string;
    round: number;
    /** Parked requirements left on this goal; absent when a corrupt sibling
     * log made the post-decision rescan unavailable (see remainingUnknown). */
    remainingParked?: number;
    /** True when the decision was recorded but the remaining count could not
     * be recomputed because another goal/loop log is corrupt. */
    remainingUnknown?: boolean;
    auditPath: string;
    loop?: { loopId: string; index: number };
  };
}

export type ReviewDecisionResult =
  | { status: 'recorded'; report: ReviewDecisionReport }
  | { status: 'invalid'; reason: string }
  | { status: 'corrupt'; reason: string };

export async function runReviewDecision(input: {
  cwd: string;
  goalId: string;
  decision: HumanReviewDecisionValue;
  requirementId: string;
  note: string;
  reviewer?: string;
  generatedAt?: string;
}): Promise<ReviewDecisionResult> {
  const dataDir = join(input.cwd, 'data');
  try {
    const result = await applyHumanReviewDecision({
      dataDir,
      goalId: input.goalId,
      ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
      decisions: [{ requirementId: input.requirementId, decision: input.decision, note: input.note }],
    });
    // The decision is already durable at this point. The post-decision rescan
    // only computes the cosmetic remaining count, so a corrupt SIBLING log
    // must degrade that field, never rewrite the recorded outcome or its
    // exit code.
    let remainingParked: number | undefined;
    try {
      const remaining = await listPendingHumanReviews(dataDir);
      remainingParked = remaining.find((review) => review.goalId === input.goalId)?.requirements.length ?? 0;
    } catch {
      remainingParked = undefined;
    }
    const note = result.audit.decisions[0]?.note ?? '';
    return {
      status: 'recorded',
      report: {
        schemaVersion: 1,
        authority: HUMAN_REVIEW_AUTHORITY,
        source: { cwd: input.cwd, dataDir },
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        decision: {
          goalId: input.goalId,
          requirementId: input.requirementId,
          decision: input.decision,
          reviewer: result.audit.reviewer,
          note,
          verdict: result.verdict.outcome,
          state: result.state,
          round: result.round,
          ...(remainingParked === undefined ? { remainingUnknown: true } : { remainingParked }),
          auditPath: join('data', 'human-reviews', `${input.goalId}.jsonl`),
          ...(result.loop === undefined ? {} : { loop: result.loop }),
        },
      },
    };
  } catch (err) {
    if (err instanceof HumanReviewError && (err.status === 400 || err.status === 404)) {
      return { status: 'invalid', reason: err.message };
    }
    return corruptOrThrow(err);
  }
}

export function formatReviewListReport(report: ReviewListReport): string {
  const lines = [
    `Pending human reviews: ${report.reviews.length}`,
    `source: ${inline(report.source.dataDir)}`,
    'completion authority: none (observation-only)',
  ];
  if (report.reviews.length === 0) {
    lines.push('', 'no pending human reviews');
    return `${lines.join('\n')}\n`;
  }
  for (const review of report.reviews) {
    lines.push(
      '',
      `${inline(review.lastAt)}  ${inline(review.goalId)}  round ${review.round}`,
      `  objective: ${inline(review.objective)}`,
      `  pending requirements: ${review.pendingRequirements} (${review.requirementIds.map((id) => inline(id)).join(', ')})`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatReviewShowReport(report: ReviewShowReport): string {
  const review = report.review;
  const lines = [
    `Human review ${inline(review.goalId)} (read-only)`,
    `source: ${inline(report.source.dataDir)}`,
    `state: ${review.state}  verdict: ${review.verdict}  round: ${review.round}  last: ${inline(review.lastAt)}`,
    `objective: ${inline(review.objective)}`,
    `checks: objectiveChecksPassed=${review.checks.objectiveChecksPassed}  testTamper=${inline(review.checks.testTamper)}  commands=${review.checks.commandCount}`,
    'pinned requirements:',
  ];
  for (const requirement of review.pinned) {
    lines.push(`  - ${inline(requirement.id)}${requirement.route === undefined ? '' : ` [${requirement.route}]`}: ${inline(requirement.text)}`);
  }
  lines.push('pending human-routed requirements:');
  if (review.requirements.length === 0) {
    lines.push('  none');
  }
  for (const requirement of review.requirements) {
    lines.push(`  - ${inline(requirement.requirementId)}: ${inline(requirement.text)}`);
    lines.push(`    reason: ${inline(requirement.reason)}`);
  }
  lines.push(`verifier feature: ${review.report.feature}`);
  lines.push(`verifier rationale: ${inline(review.report.rationale)}`);
  lines.push('completion authority: none (observation-only)');
  return `${lines.join('\n')}\n`;
}

export function formatReviewDecisionReport(report: ReviewDecisionReport): string {
  const decision = report.decision;
  const lines = [
    `Human review decision recorded: ${decision.decision}`,
    `goal: ${inline(decision.goalId)}  requirement: ${inline(decision.requirementId)}`,
    `reviewer: ${inline(decision.reviewer)}`,
    `resulting verdict: ${decision.verdict}  state: ${decision.state}  round: ${decision.round}`,
    decision.remainingParked !== undefined
      ? `remaining parked requirements: ${decision.remainingParked}`
      : 'remaining parked requirements: unknown (a sibling goal/loop log is corrupt; run jarvis review list to locate it)',
  ];
  if (decision.loop !== undefined) {
    lines.push(`loop: ${inline(decision.loop.loopId)} goal index ${decision.loop.index} finished recorded`);
  }
  lines.push(`audit: ${inline(decision.auditPath)}`);
  lines.push('completion authority: recorded via decideVerdict on human-review evidence (see audit)');
  return `${lines.join('\n')}\n`;
}

export function reviewListExitCode(result: ReviewListResult): CliExitCode {
  return result.status === 'ok' ? CLI_EXIT.SUCCESS : CLI_EXIT.STATE_CORRUPT;
}

export function reviewShowExitCode(result: ReviewShowResult): CliExitCode {
  switch (result.status) {
    case 'ok':
      return CLI_EXIT.SUCCESS;
    case 'corrupt':
      return CLI_EXIT.STATE_CORRUPT;
    default:
      return CLI_EXIT.USAGE;
  }
}

export function reviewDecisionExitCode(result: ReviewDecisionResult): CliExitCode {
  switch (result.status) {
    case 'recorded':
      return CLI_EXIT.SUCCESS;
    case 'corrupt':
      return CLI_EXIT.STATE_CORRUPT;
    default:
      return CLI_EXIT.USAGE;
  }
}

function toListItem(review: PendingHumanReview): ReviewListItem {
  return {
    goalId: review.goalId,
    objective: review.objective,
    round: review.round,
    lastAt: review.lastAt,
    pendingRequirements: review.requirements.length,
    requirementIds: review.requirements.map((requirement) => requirement.requirementId),
  };
}

function corruptOrThrow(err: unknown): { status: 'corrupt'; reason: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('corrupt')) return { status: 'corrupt', reason: message };
  throw err;
}

function inline(value: string | undefined, fallback = '-'): string {
  if (value === undefined) return fallback;
  const safe = safeInline(value);
  return safe === '' ? fallback : safe;
}
