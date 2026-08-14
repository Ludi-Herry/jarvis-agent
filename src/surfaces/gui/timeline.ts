import type { ObservationReport } from '../../capabilities/index.js';
import type { EmergencyStopState } from '../../runtime/index.js';

export type GuiTimelineTone = 'neutral' | 'info' | 'good' | 'warn' | 'danger';

export interface GuiTimelineItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  tone: GuiTimelineTone;
  at?: string;
  meta: string[];
}

export interface GuiStatusPayload {
  report: ObservationReport;
  stop: EmergencyStopState;
  timeline: GuiTimelineItem[];
}

export function buildGuiTimeline(report: ObservationReport, stop: EmergencyStopState): GuiTimelineItem[] {
  const items: GuiTimelineItem[] = [];

  if (stop.requested) {
    items.push({
      id: 'stop',
      kind: 'control',
      title: '急停已请求',
      detail: stop.record?.reason ?? stop.error ?? '本机运行中的 Jarvis 进程会在收到新于自身启动时间的停机请求后中断。',
      tone: 'danger',
      at: stop.record?.requestedAt,
      meta: [stop.record?.source ? `source ${stop.record.source}` : 'source unknown'],
    });
  }

  const loop = report.status.latestLoop;
  if (loop) {
    items.push({
      id: `loop-${loop.id}`,
      kind: 'loop',
      title: `Loop ${loop.id}`,
      detail: `${loop.completed}/${loop.objectives} complete, ${loop.blocked} blocked, ${loop.inFlight} in flight`,
      tone: loop.halted === undefined || loop.halted === 'queue-empty' ? 'good' : 'warn',
      at: loop.lastAt,
      meta: [
        `halt ${loop.halted ?? '-'}`,
        ...(loop.recordedHalt === undefined ? [] : [`recorded ${loop.recordedHalt}`]),
        `tokens ${loop.tokens}`,
      ],
    });
  }

  const goal = report.status.latestGoal;
  if (goal) {
    const effectiveState = goal.effectiveState;
    const effectiveMeta = effectiveState === goal.recordedState
      ? []
      : [
          `recorded ${goal.recordedState}`,
          `reason ${goal.effectiveReason ?? '-'}`,
          `source ${goal.effectiveSource ? (goal.effectiveSource.kind === 'loop-halt' ? `loop ${goal.effectiveSource.loopId}` : 'verdict recheck') : '-'}`,
        ];
    items.push({
      id: `goal-${goal.id}`,
      kind: 'goal',
      title: `Goal ${goal.id}`,
      detail: goal.objective,
      tone: effectiveState === 'complete' ? 'good' : effectiveState === 'blocked' || effectiveState === 'interrupted' ? 'warn' : 'info',
      at: goal.lastAt,
      meta: [
        `state ${effectiveState}`,
        ...effectiveMeta,
        `verdict ${goal.verdict ?? '-'}`,
        ...(goal.recordedVerdict === undefined ? [] : [`recorded verdict ${goal.recordedVerdict}`]),
        `rounds ${goal.rounds}`,
      ],
    });
  }

  const budget = report.status.latestGoalBudget;
  if (budget) {
    items.push({
      id: `budget-${budget.goalId}`,
      kind: 'budget',
      title: '最新 goal 预算',
      detail: `round ${budget.roundsUsed}/${budget.maxRounds}, turns ${formatCap(budget.totalTurns, budget.maxTotalTurns)}, tokens ${formatCap(budget.totalTokens, budget.maxTotalTokens)}`,
      tone: budget.roundsUsed >= budget.maxRounds ? 'warn' : 'info',
      at: budget.lastAt,
      meta: [`goal ${budget.goalId}`],
    });
  }

  const approvals = report.audit.approvals;
  if (approvals.requests > 0 || approvals.results > 0) {
    items.push({
      id: 'approvals',
      kind: 'approval',
      title: '审批流',
      detail: `${approvals.requests} requests, ${approvals.results} results`,
      tone: approvals.denied > 0 || approvals.errors > 0 ? 'warn' : 'info',
      meta: [`allowed ${approvals.allowed}`, `denied ${approvals.denied}`, `errors ${approvals.errors}`],
    });
  }

  for (const activity of report.activity.recent) {
    items.push({
      id: `activity-${activity.id}`,
      kind: activity.kind,
      title: activity.title,
      detail: activity.detail,
      tone: activity.tone,
      at: activity.at,
      meta: activity.meta,
    });
  }

  const changed = report.audit.worktreeStatus.filter((entry) => entry.changed);
  if (changed.length > 0) {
    items.push({
      id: 'worktree-status',
      kind: 'worktree',
      title: 'Worktree drift',
      detail: `${changed.length} rounds recorded changed status`,
      tone: changed.some((entry) => entry.policy === 'forbid') ? 'danger' : 'warn',
      meta: changed.slice(0, 3).map((entry) => `${entry.goalId} r${entry.round}`),
    });
  }

  if (report.audit.sandboxEvidence.length > 0) {
    const latest = report.audit.sandboxEvidence.at(-1);
    items.push({
      id: 'sandbox',
      kind: 'sandbox',
      title: 'Sandbox evidence',
      detail: `${report.audit.sandboxEvidence.length} captured checks`,
      tone: 'info',
      meta: latest ? [`backend ${latest.backend ?? '-'}`, `network ${latest.networkMode ?? '-'}`] : [],
    });
  }

  const cron = report.status.cron.lastAttempt;
  if (cron) {
    items.push({
      id: `cron-${cron.taskId}`,
      kind: 'cron',
      title: `Cron ${cron.taskId}`,
      detail: `exit ${cron.exitCode ?? 'null'}${cron.inconsistent ? ' / linked loop has blocked goals' : ''}`,
      tone: cron.exitCode === 0 && !cron.inconsistent ? 'good' : 'warn',
      at: cron.finishedAt,
      meta: cron.loopId ? [`loop ${cron.loopId}`] : [],
    });
  }

  const session = report.status.latestSession;
  if (session) {
    items.push({
      id: `session-${session.id}`,
      kind: 'session',
      title: `Session ${session.id}`,
      detail: `${session.messages} messages / ${session.format} / ${session.pendingTools} pending tool effects`,
      tone: session.pendingTools > 0 ? 'warn' : 'neutral',
      at: session.startedAt,
      meta: [session.model],
    });
  }

  if (report.audit.trustedContracts.length > 0) {
    items.push({
      id: 'trusted-contracts',
      kind: 'contract',
      title: 'Trusted contracts',
      detail: `${report.audit.trustedContracts.length} loop contracts recorded`,
      tone: 'info',
      meta: report.audit.trustedContracts.slice(-2).map((contract) => contract.loopId),
    });
  }

  items.push({
    id: 'authority',
    kind: 'authority',
    title: '只读观测',
    detail: report.authority.mode,
    tone: 'neutral',
    meta: ['canCompleteGoals false', 'canCompleteLoops false'],
  });

  return items.sort((a, b) => timestamp(b.at) - timestamp(a.at));
}

function formatCap(value: number, max: number | undefined): string {
  return max === undefined ? String(value) : `${value}/${max}`;
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
