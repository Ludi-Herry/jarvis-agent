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
}

export type LoopFinalizeDecision = 'proposal' | 'park';

export type LoopFinalizeReason =
  | 'verified-mergeable'
  | 'blocked'
  | 'could-not-verify'
  | 'rejected'
  | 'missing-verdict'
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
}

export interface LoopFinalizeReport {
  loopId: string;
  items: LoopFinalizeItem[];
  proposals: LoopFinalizeProposal[];
}

export function buildLoopFinalizeReport(records: LoopRecord[], worktrees: Map<number, FinalizeWorktreeStatus>): LoopFinalizeReport {
  const created = [...records].reverse().find((record): record is Extract<LoopRecord, { t: 'loop-created' }> => record.t === 'loop-created');
  if (created === undefined) throw new Error('loop log is missing loop-created');

  const latestStarted = new Map<number, Extract<LoopRecord, { t: 'goal-started' }>>();
  const latestFinished = new Map<number, Extract<LoopRecord, { t: 'goal-finished' }>>();
  for (const record of records) {
    if (record.t === 'goal-started') latestStarted.set(record.index, record);
    if (record.t === 'goal-finished') latestFinished.set(record.index, record);
  }

  const items = created.objectives.map((objective, index): LoopFinalizeItem => {
    const started = latestStarted.get(index);
    const finished = latestFinished.get(index);
    const goalId = finished?.goalId ?? started?.goalId;
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

    const worktree = worktrees.get(index);
    if (worktree === undefined || !worktree.exists) {
      return { ...base, worktree, decision: 'park', reason: 'missing-worktree' };
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
    return { ...base, worktree, decision: 'proposal', reason: 'verified-mergeable' };
  });

  const proposals = items
    .filter((item): item is LoopFinalizeItem & { goalId: string; worktree: FinalizeWorktreeStatus; decision: 'proposal' } => item.decision === 'proposal')
    .map((item) => ({ index: item.index, goalId: item.goalId, worktreePath: item.worktree.path }));

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
