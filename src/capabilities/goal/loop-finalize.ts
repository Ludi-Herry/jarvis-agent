import { normalize } from 'node:path';
import type { GoalState, VerdictOutcome } from './goal.js';
import type { LoopRecord } from './loop-store.js';

export interface FinalizeWorktreeStatus {
  path: string;
  exists: boolean;
  clean: boolean;
  conflicted: boolean;
  hasTrackedChanges: boolean;
  hasUntracked: boolean;
  statusReadable: boolean;
  diffReadable: boolean;
  status: string;
  diffStat: string;
  trackedDiffHash?: string;
}

export type LoopFinalizeDecision = 'proposal' | 'park';

export type LoopFinalizeReason =
  | 'verified-mergeable'
  | 'blocked'
  | 'could-not-verify'
  | 'rejected'
  | 'missing-verdict'
  | 'missing-goal-evidence'
  | 'goal-mismatch'
  | 'missing-human-review-audit'
  | 'missing-worktree'
  | 'conflict'
  | 'dirty'
  | 'no-diff';

export interface LoopFinalizeItem {
  index: number;
  objective: string;
  goalId?: string;
  state?: GoalState;
  outcome?: VerdictOutcome;
  worktree?: FinalizeWorktreeStatus;
  decision: LoopFinalizeDecision;
  reason: LoopFinalizeReason;
}

export interface LoopFinalizeProposal {
  index: number;
  goalId: string;
  worktreePath: string;
  worktreeDiffHash: string;
}

export interface LoopFinalizeReport {
  loopId: string;
  items: LoopFinalizeItem[];
  proposals: LoopFinalizeProposal[];
}

export interface LoopFinalizeGoalEvidence {
  goalId: string;
  objective?: string;
  sessionId?: string;
  sessionCwd?: string;
  pinnedCount?: number;
  hasVerifierReport?: boolean;
  worktreeDiffHash?: string;
  state?: GoalState;
  outcome?: VerdictOutcome;
  requiresHumanReviewAudit?: boolean;
  hasHumanReviewAudit?: boolean;
}

export function buildLoopFinalizeReport(
  records: LoopRecord[],
  worktrees: Map<number, FinalizeWorktreeStatus>,
  goalEvidence: ReadonlyMap<string, LoopFinalizeGoalEvidence>,
): LoopFinalizeReport {
  const created = [...records].reverse().find((record): record is Extract<LoopRecord, { t: 'loop-created' }> => record.t === 'loop-created');
  if (created === undefined) throw new Error('loop log is missing loop-created');

  const latestAttempt = new Map<
    number,
    Extract<LoopRecord, { t: 'goal-started' }> | Extract<LoopRecord, { t: 'goal-finished' }>
  >();
  for (const record of records) {
    if (record.t === 'goal-started' || record.t === 'goal-finished') latestAttempt.set(record.index, record);
  }

  const items = created.objectives.map((objective, index): LoopFinalizeItem => {
    const attempt = latestAttempt.get(index);
    const finished = attempt?.t === 'goal-finished' ? attempt : undefined;
    const goalId = attempt?.goalId;
    const base = {
      index,
      objective,
      ...(goalId === undefined ? {} : { goalId }),
      ...(finished?.state === undefined ? {} : { state: finished.state }),
      ...(finished?.outcome === undefined ? {} : { outcome: finished.outcome }),
    };
    if (finished === undefined || finished.outcome === undefined) {
      return { ...base, decision: 'park', reason: 'missing-verdict' };
    }
    const outcomeStop = reasonForOutcome(finished.state, finished.outcome);
    if (outcomeStop !== undefined) {
      return { ...base, decision: 'park', reason: outcomeStop };
    }

    const evidence = goalId === undefined ? undefined : goalEvidence.get(goalId);
    if (evidence === undefined) {
      return { ...base, decision: 'park', reason: 'missing-goal-evidence' };
    }
    if (
      evidence.goalId !== goalId ||
      evidence.objective !== objective ||
      evidence.sessionId !== goalId ||
      evidence.state !== finished.state ||
      evidence.outcome !== finished.outcome ||
      ((evidence.pinnedCount ?? 0) > 0 && evidence.hasVerifierReport === false)
    ) {
      return { ...base, decision: 'park', reason: 'goal-mismatch' };
    }
    if (evidence.requiresHumanReviewAudit && !evidence.hasHumanReviewAudit) {
      return { ...base, decision: 'park', reason: 'missing-human-review-audit' };
    }

    const worktree = worktrees.get(index);
    if (worktree === undefined || !worktree.exists) {
      return { ...base, worktree, decision: 'park', reason: 'missing-worktree' };
    }
    if (evidence.sessionCwd === undefined || !samePath(evidence.sessionCwd, worktree.path)) {
      return { ...base, worktree, decision: 'park', reason: 'goal-mismatch' };
    }
    if (worktree.conflicted) {
      return { ...base, worktree, decision: 'park', reason: 'conflict' };
    }
    if (!worktree.statusReadable || !worktree.diffReadable || worktree.hasUntracked) {
      return { ...base, worktree, decision: 'park', reason: 'dirty' };
    }
    if (!worktree.hasTrackedChanges) {
      return { ...base, worktree, decision: 'park', reason: 'no-diff' };
    }
    if (evidence.worktreeDiffHash === undefined || worktree.trackedDiffHash !== evidence.worktreeDiffHash) {
      return { ...base, worktree, decision: 'park', reason: 'goal-mismatch' };
    }
    return { ...base, worktree, decision: 'proposal', reason: 'verified-mergeable' };
  });

  const proposals = items
    .filter(
      (item): item is LoopFinalizeItem & {
        goalId: string;
        worktree: FinalizeWorktreeStatus & { trackedDiffHash: string };
        decision: 'proposal';
      } => item.decision === 'proposal' && item.worktree?.trackedDiffHash !== undefined,
    )
    .map((item) => ({
      index: item.index,
      goalId: item.goalId,
      worktreePath: item.worktree.path,
      worktreeDiffHash: item.worktree.trackedDiffHash,
    }));

  return { loopId: created.id, items, proposals };
}

function reasonForOutcome(state: GoalState, outcome: VerdictOutcome): LoopFinalizeReason | undefined {
  if (state !== 'complete') {
    if (outcome === 'couldNotVerify') return 'could-not-verify';
    if (outcome === 'rejected') return 'rejected';
    return 'blocked';
  }
  if (outcome === 'verified') return undefined;
  if (outcome === 'couldNotVerify') return 'could-not-verify';
  return 'rejected';
}

function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function normalizeForCompare(value: string): string {
  const normalized = normalize(value).replace(/[\\/]+$/g, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
