import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseSessionLog,
  type SessionRecord,
} from '../../runtime/session/session-store.js';
import { parseApprovalAuditLog, type ApprovalAuditDecision, type ApprovalAuditRecord } from '../../runtime/permission/index.js';
import {
  parseLoopCronDaemonLog,
  type LoopCronDaemonRecord,
} from './loop-cron-daemon.js';
import { parseLoopCronLog, type LoopCronRecord } from './loop-cron.js';
import {
  parseGoalLog,
  replayGoal,
  type GoalRecord,
  type GoalRoundRecord,
} from './goal-store.js';
import {
  parseLoopLog,
  type LoopCreatedRecord,
  type LoopRecord,
} from './loop-store.js';
import type { GoalState, VerdictOutcome, WorktreeChangePolicy } from './goal.js';
import type { LoopHaltReason } from './loop.js';

export interface ObservationLog<T> {
  path: string;
  records: T[];
  mtimeMs?: number;
}

export interface ObservationInput {
  sessions?: Array<ObservationLog<SessionRecord>>;
  goals?: Array<ObservationLog<GoalRecord>>;
  loops?: Array<ObservationLog<LoopRecord>>;
  cron?: ObservationLog<LoopCronRecord>;
  cronDaemon?: ObservationLog<LoopCronDaemonRecord>;
  approvals?: Array<ObservationLog<ApprovalAuditRecord>>;
}

export interface ObservationReportOptions {
  sourceDataDir?: string;
  generatedAt?: string;
}

export interface ObservationReport {
  meta: {
    schemaVersion: 1;
    generatedAt: string;
    source: {
      dataDir?: string;
    };
    scope: {
      sessions: true;
      goals: true;
      loops: true;
      cron: true;
      cronDaemon: true;
      approvals: true;
    };
  };
  authority: {
    mode: 'observation-only';
    canCompleteGoals: false;
    canCompleteLoops: false;
  };
  status: {
    sessions: { total: number };
    goals: { total: number; byState: Record<GoalState, number> };
    loops: { total: number };
    cron: { attempts: number; lastAttempt?: CronAttemptSummary };
    cronDaemon: { records: number; parkedTasks: string[]; lastStopReason?: string };
    latestSession?: SessionSummary;
    latestGoal?: GoalSummary;
    latestGoalBudget?: GoalBudgetSummary;
    latestLoop?: LoopSummary;
  };
  usage: {
    sessionMessages: number;
    sessionCompactions: number;
    goalTurns: number;
    goalTokens: number;
    loopTokens: number;
    loopFinishedGoals: number;
  };
  audit: {
    trustedContracts: TrustedContractSummary[];
    worktreeStatus: WorktreeStatusSummary[];
    sandboxEvidence: SandboxAuditSummary[];
    approvals: ApprovalAuditSummary;
  };
  activity: {
    recent: ObservationActivityItem[];
  };
}

export type ObservationActivityKind = 'session' | 'goal' | 'loop' | 'cron' | 'cron-daemon' | 'approval';
export type ObservationActivityTone = 'neutral' | 'info' | 'good' | 'warn' | 'danger';

export interface ObservationActivityItem {
  id: string;
  kind: ObservationActivityKind;
  title: string;
  detail: string;
  tone: ObservationActivityTone;
  at?: string;
  source: string;
  meta: string[];
}

export interface SessionSummary {
  id: string;
  model: string;
  cwd: string;
  startedAt: string;
  messages: number;
}

export interface GoalSummary {
  id: string;
  objective: string;
  state: GoalState;
  rounds: number;
  verdict?: VerdictOutcome;
  lastAt?: string;
}

export interface GoalBudgetSummary {
  goalId: string;
  roundsUsed: number;
  maxRounds: number;
  totalTurns: number;
  totalTokens: number;
  lastRound?: number;
  maxTotalTurns?: number;
  maxTotalTokens?: number;
  lastAt?: string;
}

export interface LoopSummary {
  id: string;
  objectives: number;
  completed: number;
  blocked: number;
  inFlight: number;
  tokens: number;
  halted?: LoopHaltReason;
  lastAt?: string;
}

export interface CronAttemptSummary {
  taskId: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  loopId?: string;
}

export interface TrustedContractSummary {
  loopId: string;
  verifierMapPath?: string;
  hookMapPath?: string;
  sandboxCheckMapPath?: string;
  goalSetterRequirementsMapPath?: string;
  goalSetterRequirementsMapHash?: string;
}

export interface WorktreeStatusSummary {
  goalId: string;
  round: number;
  policy: WorktreeChangePolicy;
  changed: boolean;
  changedEntries: string[];
  error?: string;
}

export interface SandboxAuditSummary {
  goalId: string;
  round: number;
  backend?: string;
  command?: unknown;
  mounts?: unknown;
  networkMode?: string;
  limits?: unknown;
}

export interface ApprovalAuditSummary {
  requests: number;
  results: number;
  allowed: number;
  denied: number;
  errors: number;
  sessionIds: string[];
}

export function buildObservationReport(input: ObservationInput, options: ObservationReportOptions = {}): ObservationReport {
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const loops = input.loops ?? [];
  const cronRecords = input.cron?.records ?? [];
  const daemonRecords = input.cronDaemon?.records ?? [];
  const approvalRecords = (input.approvals ?? []).flatMap((log) => log.records);

  const sessionSummaries = sessions.map(summarizeSession).filter((summary): summary is SessionSummary => summary !== undefined);
  const goalSummaries = goals.map(summarizeGoal).filter((summary): summary is GoalSummary => summary !== undefined);
  const goalBudgetSummaries = goals.map(summarizeGoalBudget).filter((summary): summary is GoalBudgetSummary => summary !== undefined);
  const loopSummaries = loops.map(summarizeLoop).filter((summary): summary is LoopSummary => summary !== undefined);

  const goalRounds = goals.flatMap((log) => log.records.filter((record): record is GoalRoundRecord => record.t === 'goal-round')
    .map((round) => ({ log, round })));
  const loopFinished = loops.flatMap((log) => log.records.filter((record) => record.t === 'goal-finished'));

  return {
    meta: {
      schemaVersion: 1,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      source: {
        ...optional('dataDir', options.sourceDataDir),
      },
      scope: {
        sessions: true,
        goals: true,
        loops: true,
        cron: true,
        cronDaemon: true,
        approvals: true,
      },
    },
    authority: { mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false },
    status: {
      sessions: { total: sessionSummaries.length },
      goals: { total: goalSummaries.length, byState: countGoalsByState(goalSummaries) },
      loops: { total: loopSummaries.length },
      cron: {
        attempts: cronRecords.filter((record) => record.t === 'cron-attempt').length,
        ...optional('lastAttempt', summarizeCronAttempt(last(cronRecords.filter((record) => record.t === 'cron-attempt')))),
      },
      cronDaemon: summarizeCronDaemon(daemonRecords),
      ...optional('latestSession', latestBy(sessionSummaries, (summary) => summary.startedAt)),
      ...optional('latestGoal', latestBy(goalSummaries, (summary) => summary.lastAt ?? '')),
      ...optional('latestGoalBudget', latestBy(goalBudgetSummaries, (summary) => summary.lastAt ?? '')),
      ...optional('latestLoop', latestBy(loopSummaries, (summary) => summary.lastAt ?? '')),
    },
    usage: {
      sessionMessages: sessions.reduce((sum, log) => sum + log.records.filter((record) => record.t === 'message').length, 0),
      sessionCompactions: sessions.reduce((sum, log) => sum + log.records.filter((record) => record.t === 'compaction').length, 0),
      goalTurns: goalRounds.reduce((sum, item) => sum + (item.round.turns ?? 0), 0),
      goalTokens: goalRounds.reduce((sum, item) => sum + (item.round.tokens ?? 0), 0),
      loopTokens: loopFinished.reduce((sum, record) => sum + record.tokens, 0),
      loopFinishedGoals: loopFinished.length,
    },
    audit: {
      trustedContracts: loops.flatMap((log) => trustedContractsFromLoop(log.records)),
      worktreeStatus: goals.flatMap((log) => worktreeStatusFromGoal(log.records)),
      sandboxEvidence: goals.flatMap((log) => sandboxEvidenceFromGoal(log.records)),
      approvals: summarizeApprovals(approvalRecords),
    },
    activity: {
      recent: recentActivity(input),
    },
  };
}

export async function loadWorkspaceObservation(dataDir: string): Promise<ObservationReport> {
  const [sessions, goals, loops, cron, cronDaemon, approvals] = await Promise.all([
    readJsonlDir(join(dataDir, 'sessions'), parseSessionLog),
    readJsonlDir(join(dataDir, 'goals'), parseGoalLog),
    readJsonlDir(join(dataDir, 'loops'), parseLoopLog),
    readJsonlFile(join(dataDir, 'cron', 'loop-cron.jsonl'), parseLoopCronLog),
    readJsonlFile(join(dataDir, 'cron', 'loop-cron-daemon.jsonl'), parseLoopCronDaemonLog),
    readJsonlDir(join(dataDir, 'approvals'), parseApprovalAuditLog),
  ]);

  return buildObservationReport({
    sessions,
    goals,
    loops,
    ...(cron === undefined ? {} : { cron }),
    ...(cronDaemon === undefined ? {} : { cronDaemon }),
    approvals,
  }, { sourceDataDir: dataDir });
}

export function formatObservationReport(report: ObservationReport): string {
  const lines = [
    'Observation: status/usage/audit (read-only)',
    'completion authority: none',
    `sessions: ${report.status.sessions.total} messages=${report.usage.sessionMessages} compactions=${report.usage.sessionCompactions}`,
    `goals: ${report.status.goals.total} active=${report.status.goals.byState.active} complete=${report.status.goals.byState.complete} blocked=${report.status.goals.byState.blocked}`,
    `loops: ${report.status.loops.total} loopTokens=${report.usage.loopTokens} loopFinishedGoals=${report.usage.loopFinishedGoals}`,
    `cron: attempts=${report.status.cron.attempts}`,
    `audit: trusted contracts=${report.audit.trustedContracts.length} worktree statuses=${report.audit.worktreeStatus.length} sandbox evidence: ${report.audit.sandboxEvidence.length} approvals=${report.audit.approvals.requests}/${report.audit.approvals.results}`,
  ];

  if (report.status.latestSession) {
    const session = report.status.latestSession;
    lines.push(`latest session: ${session.id} model=${session.model} messages=${session.messages}`);
  }
  if (report.status.latestGoal) {
    const goal = report.status.latestGoal;
    lines.push(`latest goal: ${goal.id} ${goal.state} verdict=${goal.verdict ?? '-'} rounds=${goal.rounds}`);
  }
  if (report.status.latestGoalBudget) {
    const budget = report.status.latestGoalBudget;
    const turns = budget.maxTotalTurns === undefined ? `${budget.totalTurns}` : `${budget.totalTurns}/${budget.maxTotalTurns}`;
    const tokens = budget.maxTotalTokens === undefined ? `${budget.totalTokens}` : `${budget.totalTokens}/${budget.maxTotalTokens}`;
    lines.push(`latest goal budget: ${budget.goalId} rounds=${budget.roundsUsed}/${budget.maxRounds} turns=${turns} tokens=${tokens}`);
  }
  if (report.status.latestLoop) {
    const loop = report.status.latestLoop;
    lines.push(`latest loop: ${loop.id} completed=${loop.completed}/${loop.objectives} blocked=${loop.blocked} inFlight=${loop.inFlight} halted=${loop.halted ?? '-'}`);
  }
  if (report.status.cron.lastAttempt) {
    const cron = report.status.cron.lastAttempt;
    lines.push(`latest cron: ${cron.taskId} exit=${cron.exitCode ?? 'null'}${cron.loopId ? ` loop=${cron.loopId}` : ''}`);
  }
  if (report.activity.recent.length > 0) {
    lines.push('recent activity:');
    for (const item of report.activity.recent.slice(0, 5)) {
      lines.push(`- ${item.at ?? '-'} ${item.kind}: ${item.title} - ${clip(item.detail, 120)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function summarizeSession(log: ObservationLog<SessionRecord>): SessionSummary | undefined {
  const header = log.records.find((record) => record.t === 'session');
  if (header === undefined) return undefined;
  return {
    id: header.id,
    model: header.model,
    cwd: header.cwd,
    startedAt: header.startedAt,
    messages: log.records.filter((record) => record.t === 'message').length,
  };
}

function summarizeGoal(log: ObservationLog<GoalRecord>): GoalSummary | undefined {
  const { goal, rounds } = replayGoal(log.records);
  if (goal === undefined) return undefined;
  const latestRound = last(rounds);
  return {
    id: goal.id,
    objective: goal.objective,
    state: goal.state,
    rounds: rounds.length,
    ...(latestRound?.verdict?.outcome === undefined ? {} : { verdict: latestRound.verdict.outcome }),
    ...optional('lastAt', lastTimestamp(log.records)),
  };
}

function summarizeGoalBudget(log: ObservationLog<GoalRecord>): GoalBudgetSummary | undefined {
  const { goal, rounds } = replayGoal(log.records);
  if (goal === undefined) return undefined;
  const latestRound = last(rounds);
  return {
    goalId: goal.id,
    roundsUsed: rounds.length,
    maxRounds: goal.budget.maxRounds,
    totalTurns: rounds.reduce((sum, round) => sum + (round.turns ?? 0), 0),
    totalTokens: rounds.reduce((sum, round) => sum + (round.tokens ?? 0), 0),
    ...optional('lastRound', latestRound?.round),
    ...optional('maxTotalTurns', goal.budget.maxTotalTurns),
    ...optional('maxTotalTokens', goal.budget.maxTotalTokens),
    ...optional('lastAt', lastTimestamp(log.records)),
  };
}

function summarizeLoop(log: ObservationLog<LoopRecord>): LoopSummary | undefined {
  const created = log.records.find((record): record is LoopCreatedRecord => record.t === 'loop-created');
  if (created === undefined) return undefined;

  const started = new Map<number, Extract<LoopRecord, { t: 'goal-started' }>>();
  const finished = new Map<number, Extract<LoopRecord, { t: 'goal-finished' }>>();
  let halted: LoopHaltReason | undefined;
  for (const record of log.records) {
    if (record.t === 'goal-started') started.set(record.index, record);
    if (record.t === 'goal-finished') finished.set(record.index, record);
    if (record.t === 'loop-halted') halted = record.reason;
  }

  const finishedValues = [...finished.values()];
  return {
    id: created.id,
    objectives: created.objectives.length,
    completed: finishedValues.filter((record) => record.state === 'complete').length,
    blocked: finishedValues.filter((record) => record.state === 'blocked').length,
    inFlight: [...started.keys()].filter((index) => !finished.has(index)).length,
    tokens: finishedValues.reduce((sum, record) => sum + record.tokens, 0),
    ...(halted === undefined ? {} : { halted }),
    ...optional('lastAt', lastTimestamp(log.records)),
  };
}

function summarizeCronAttempt(record: LoopCronRecord | undefined): CronAttemptSummary | undefined {
  if (record === undefined || record.t !== 'cron-attempt') return undefined;
  return {
    taskId: record.taskId,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    ...(record.loopId === undefined ? {} : { loopId: record.loopId }),
  };
}

function summarizeCronDaemon(records: LoopCronDaemonRecord[]): ObservationReport['status']['cronDaemon'] {
  let lastStopReason: string | undefined;
  const parkedTasks = new Set<string>();
  for (const record of records) {
    if (record.t === 'daemon-stopped') lastStopReason = record.reason;
    if (record.t === 'task-parked') parkedTasks.add(record.taskId);
    if (record.t === 'task-finished') parkedTasks.delete(record.taskId);
  }
  return {
    records: records.length,
    parkedTasks: [...parkedTasks].sort(),
    ...(lastStopReason === undefined ? {} : { lastStopReason }),
  };
}

function countGoalsByState(goals: GoalSummary[]): Record<GoalState, number> {
  return {
    active: goals.filter((goal) => goal.state === 'active').length,
    complete: goals.filter((goal) => goal.state === 'complete').length,
    blocked: goals.filter((goal) => goal.state === 'blocked').length,
  };
}

function trustedContractsFromLoop(records: LoopRecord[]): TrustedContractSummary[] {
  return records
    .filter((record): record is LoopCreatedRecord => record.t === 'loop-created')
    .map((record) => ({
      loopId: record.id,
      ...optional('verifierMapPath', record.verifierMapPath),
      ...optional('hookMapPath', record.hookMapPath),
      ...optional('sandboxCheckMapPath', record.sandboxCheckMapPath),
      ...optional('goalSetterRequirementsMapPath', record.goalSetterRequirementsMapPath),
      ...optional('goalSetterRequirementsMapHash', record.goalSetterRequirementsMapHash),
    }))
    .filter((summary) => Object.keys(summary).length > 1);
}

function worktreeStatusFromGoal(records: GoalRecord[]): WorktreeStatusSummary[] {
  const created = records.find((record) => record.t === 'goal-created');
  const goalId = created?.id;
  if (goalId === undefined) return [];
  return records
    .filter((record): record is GoalRoundRecord => record.t === 'goal-round' && record.checks?.worktreeStatus !== undefined)
    .map((record) => {
      const status = record.checks?.worktreeStatus;
      if (status === undefined) throw new Error('unreachable');
      return {
        goalId,
        round: record.round,
        policy: status.policy,
        changed: status.changed,
        changedEntries: status.changedEntries,
        ...(status.error === undefined ? {} : { error: status.error }),
      };
    });
}

function sandboxEvidenceFromGoal(records: GoalRecord[]): SandboxAuditSummary[] {
  const created = records.find((record) => record.t === 'goal-created');
  const goalId = created?.id;
  if (goalId === undefined) return [];
  return records.flatMap((record) => {
    if (record.t !== 'goal-round' || record.verdict?.report?.evidence === undefined) return [];
    return extractSandboxAudits(record.verdict.report.evidence).map((audit) => ({
      goalId,
      round: record.round,
      ...audit,
    }));
  });
}

function extractSandboxAudits(evidence: string): Array<Omit<SandboxAuditSummary, 'goalId' | 'round'>> {
  const audits: Array<Omit<SandboxAuditSummary, 'goalId' | 'round'>> = [];
  const marker = 'sandbox audit:';
  let cursor = 0;
  while (cursor < evidence.length) {
    const markerAt = evidence.indexOf(marker, cursor);
    if (markerAt === -1) break;
    const objectStart = evidence.indexOf('{', markerAt + marker.length);
    if (objectStart === -1) break;
    const objectText = balancedJsonObject(evidence, objectStart);
    if (objectText === undefined) {
      cursor = objectStart + 1;
      continue;
    }
    const parsed = parseJsonObject(objectText);
    if (parsed !== undefined) {
      audits.push({
        ...optional('backend', stringField(parsed, 'backend')),
        ...optional('command', parsed.command),
        ...optional('mounts', parsed.mounts),
        ...optional('networkMode', stringField(parsed, 'networkMode')),
        ...optional('limits', parsed.limits),
      });
    }
    cursor = objectStart + objectText.length;
  }
  return audits;
}

function summarizeApprovals(records: ApprovalAuditRecord[]): ApprovalAuditSummary {
  const requests = records.filter((record) => record.t === 'approval-request');
  const results = records.filter((record) => record.t === 'approval-result');
  const sessionIds = new Set<string>();
  for (const record of records) {
    if (record.sessionId !== undefined) sessionIds.add(record.sessionId);
  }
  return {
    requests: requests.length,
    results: results.length,
    allowed: results.filter((record) => record.decision === 'allow-once' || record.decision === 'allow-session').length,
    denied: results.filter((record) => record.decision === 'deny').length,
    errors: results.filter((record) => record.decision === 'error').length,
    sessionIds: [...sessionIds].sort(),
  };
}

function recentActivity(input: ObservationInput): ObservationActivityItem[] {
  const items: ObservationActivityItem[] = [];

  for (const log of input.sessions ?? []) {
    const header = log.records.find((record) => record.t === 'session');
    if (header === undefined) continue;
    items.push({
      id: activityId('session', log.path, 'created'),
      kind: 'session',
      title: `Session ${header.id}`,
      detail: `${header.model} started`,
      tone: 'neutral',
      at: header.startedAt,
      source: log.path,
      meta: [`messages ${log.records.filter((record) => record.t === 'message').length}`, header.cwd],
    });
  }

  for (const log of input.goals ?? []) {
    const created = log.records.find((record) => record.t === 'goal-created');
    const goalId = created?.id ?? 'unknown-goal';
    for (const [index, record] of log.records.entries()) {
      if (record.t === 'goal-created') {
        items.push({
          id: activityId('goal', log.path, index),
          kind: 'goal',
          title: `Goal ${record.id}`,
          detail: record.objective,
          tone: 'info',
          at: record.createdAt,
          source: log.path,
          meta: [`max rounds ${record.budget.maxRounds}`, `session ${record.sessionId}`],
        });
      } else if (record.t === 'goal-round') {
        const outcome = record.verdict?.outcome;
        items.push({
          id: activityId('goal-round', log.path, index),
          kind: 'goal',
          title: `Goal round ${record.round}`,
          detail: outcome === undefined ? 'builder round recorded' : `verdict ${outcome}`,
          tone: verdictTone(outcome),
          at: record.at,
          source: log.path,
          meta: [`goal ${goalId}`, `turns ${record.turns ?? 0}`, `tokens ${record.tokens ?? 0}`],
        });
      } else if (record.t === 'goal-state') {
        items.push({
          id: activityId('goal-state', log.path, index),
          kind: 'goal',
          title: `Goal ${record.state}`,
          detail: goalId,
          tone: goalStateTone(record.state),
          at: record.at,
          source: log.path,
          meta: [],
        });
      }
    }
  }

  for (const log of input.loops ?? []) {
    const created = log.records.find((record) => record.t === 'loop-created');
    const loopId = created?.id ?? 'unknown-loop';
    for (const [index, record] of log.records.entries()) {
      if (record.t === 'loop-created') {
        items.push({
          id: activityId('loop', log.path, index),
          kind: 'loop',
          title: `Loop ${record.id}`,
          detail: `${record.objectives.length} objectives queued`,
          tone: 'info',
          at: record.createdAt,
          source: log.path,
          meta: contractMeta(record),
        });
      } else if (record.t === 'goal-started') {
        items.push({
          id: activityId('loop-started', log.path, index),
          kind: 'loop',
          title: `Loop goal ${record.index + 1} started`,
          detail: record.goalId,
          tone: 'info',
          at: record.at,
          source: log.path,
          meta: [`loop ${loopId}`],
        });
      } else if (record.t === 'goal-finished') {
        items.push({
          id: activityId('loop-finished', log.path, index),
          kind: 'loop',
          title: `Loop goal ${record.index + 1} finished`,
          detail: `${record.state}${record.outcome === undefined ? '' : ` / ${record.outcome}`}`,
          tone: goalStateTone(record.state),
          at: record.at,
          source: log.path,
          meta: [`rounds ${record.rounds}`, `tokens ${record.tokens}`],
        });
      } else if (record.t === 'loop-halted') {
        items.push({
          id: activityId('loop-halted', log.path, index),
          kind: 'loop',
          title: 'Loop halted',
          detail: record.reason,
          tone: haltTone(record.reason),
          at: record.at,
          source: log.path,
          meta: [`loop ${loopId}`],
        });
      }
    }
  }

  const cron = input.cron;
  if (cron !== undefined) {
    for (const [index, record] of cron.records.entries()) {
      items.push({
        id: activityId('cron', cron.path, index),
        kind: 'cron',
        title: `Cron ${record.taskId}`,
        detail: `exit ${record.exitCode ?? 'null'}`,
        tone: record.exitCode === 0 ? 'good' : 'warn',
        at: record.finishedAt,
        source: cron.path,
        meta: record.loopId === undefined ? [`next ${record.nextRunAt}`] : [`loop ${record.loopId}`, `next ${record.nextRunAt}`],
      });
    }
  }

  const daemon = input.cronDaemon;
  if (daemon !== undefined) {
    for (const [index, record] of daemon.records.entries()) {
      items.push(cronDaemonActivity(daemon.path, index, record));
    }
  }

  for (const log of input.approvals ?? []) {
    for (const [index, record] of log.records.entries()) {
      if (record.t === 'approval-request') {
        items.push({
          id: activityId('approval-request', log.path, index),
          kind: 'approval',
          title: `Approval request ${record.toolName}`,
          detail: record.detail,
          tone: 'warn',
          at: record.at,
          source: log.path,
          meta: compactMeta([record.sessionId === undefined ? undefined : `session ${record.sessionId}`, record.capability, record.reason]),
        });
      } else {
        items.push({
          id: activityId('approval-result', log.path, index),
          kind: 'approval',
          title: `Approval ${record.decision}`,
          detail: record.toolName,
          tone: approvalTone(record.decision),
          at: record.at,
          source: log.path,
          meta: compactMeta([record.sessionId === undefined ? undefined : `session ${record.sessionId}`, record.error]),
        });
      }
    }
  }

  return items
    .sort((a, b) => timestamp(b.at) - timestamp(a.at))
    .slice(0, 20);
}

function cronDaemonActivity(path: string, index: number, record: LoopCronDaemonRecord): ObservationActivityItem {
  const base = {
    id: activityId('cron-daemon', path, index),
    kind: 'cron-daemon' as const,
    source: path,
  };
  switch (record.t) {
    case 'daemon-started':
      return { ...base, title: 'Cron daemon started', detail: record.cronMapPath, tone: 'info', at: record.startedAt, meta: [`pid ${record.pid}`, `poll ${record.pollMs}ms`] };
    case 'daemon-heartbeat':
      return { ...base, title: 'Cron daemon heartbeat', detail: `next wake ${record.nextWakeAt}`, tone: 'neutral', at: record.at, meta: [] };
    case 'daemon-stopped':
      return { ...base, title: 'Cron daemon stopped', detail: record.reason, tone: record.reason === 'completed' ? 'good' : 'warn', at: record.at, meta: [] };
    case 'scan-started':
      return { ...base, title: 'Cron scan started', detail: 'checking scheduled tasks', tone: 'info', at: record.at, meta: [] };
    case 'scan-finished':
      return { ...base, title: 'Cron scan finished', detail: `${record.triggered} triggered, ${record.skipped} skipped`, tone: record.parked > 0 ? 'warn' : 'good', at: record.at, meta: [`parked ${record.parked}`] };
    case 'scan-skipped':
      return { ...base, title: 'Cron scan skipped', detail: record.reason, tone: 'warn', at: record.at, meta: [] };
    case 'task-started':
      return { ...base, title: `Cron task ${record.taskId} started`, detail: record.command ?? record.scheduledFor, tone: 'info', at: record.startedAt, meta: [] };
    case 'task-finished':
      return { ...base, title: `Cron task ${record.taskId} finished`, detail: `exit ${record.exitCode ?? 'null'}`, tone: record.exitCode === 0 ? 'good' : 'warn', at: record.finishedAt, meta: record.loopId === undefined ? [] : [`loop ${record.loopId}`] };
    case 'task-parked':
      return { ...base, title: `Cron task ${record.taskId} parked`, detail: record.reason, tone: 'warn', at: record.at, meta: [] };
  }
}

function contractMeta(record: LoopCreatedRecord): string[] {
  return compactMeta([
    record.goalSetterRequirementsMapPath === undefined ? undefined : 'requirements map',
    record.sandboxCheckMapPath === undefined ? undefined : 'sandbox check map',
    record.hookMapPath === undefined ? undefined : 'hook map',
    record.verifierMapPath === undefined ? undefined : 'verifier map',
  ]);
}

function goalStateTone(state: GoalState): ObservationActivityTone {
  return state === 'complete' ? 'good' : state === 'blocked' ? 'warn' : 'info';
}

function verdictTone(outcome: VerdictOutcome | undefined): ObservationActivityTone {
  if (outcome === 'verified') return 'good';
  if (outcome === 'rejected' || outcome === 'couldNotVerify') return 'warn';
  return 'info';
}

function haltTone(reason: LoopHaltReason): ObservationActivityTone {
  return reason === 'queue-empty' ? 'good' : 'warn';
}

function approvalTone(decision: ApprovalAuditDecision): ObservationActivityTone {
  if (decision === 'allow-once' || decision === 'allow-session') return 'good';
  if (decision === 'error') return 'danger';
  return 'warn';
}

function compactMeta(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined && value !== '');
}

function activityId(scope: string, path: string, part: string | number): string {
  return `${scope}:${path}:${part}`;
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

async function readJsonlDir<T>(
  dir: string,
  parse: (text: string) => T[],
): Promise<Array<ObservationLog<T>>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const logs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => readJsonlFile(join(dir, entry), parse)),
  );
  return logs.filter((log): log is ObservationLog<T> => log !== undefined);
}

async function readJsonlFile<T>(
  path: string,
  parse: (text: string) => T[],
): Promise<ObservationLog<T> | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { path, records: parse(text), mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

function lastTimestamp(records: Array<{ at?: string; createdAt?: string; startedAt?: string; finishedAt?: string }>): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const value = record.at ?? record.finishedAt ?? record.startedAt ?? record.createdAt;
    if (value !== undefined) return value;
  }
  return undefined;
}

function latestBy<T>(items: T[], select: (item: T) => string): T | undefined {
  let latest: T | undefined;
  let latestKey = '';
  for (const item of items) {
    const key = select(item);
    if (latest === undefined || key > latestKey) {
      latest = item;
      latestKey = key;
    }
  }
  return latest;
}

function last<T>(items: T[]): T | undefined {
  return items.length === 0 ? undefined : items[items.length - 1];
}

function optional<K extends string, T>(key: K, value: T | undefined): { [P in K]: T } | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as { [P in K]: T };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
