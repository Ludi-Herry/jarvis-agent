import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseSessionLog,
  type SessionRecord,
} from '../../runtime/session/session-store.js';
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
}

export interface ObservationReport {
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
  };
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

export function buildObservationReport(input: ObservationInput): ObservationReport {
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const loops = input.loops ?? [];
  const cronRecords = input.cron?.records ?? [];
  const daemonRecords = input.cronDaemon?.records ?? [];

  const sessionSummaries = sessions.map(summarizeSession).filter((summary): summary is SessionSummary => summary !== undefined);
  const goalSummaries = goals.map(summarizeGoal).filter((summary): summary is GoalSummary => summary !== undefined);
  const loopSummaries = loops.map(summarizeLoop).filter((summary): summary is LoopSummary => summary !== undefined);

  const goalRounds = goals.flatMap((log) => log.records.filter((record): record is GoalRoundRecord => record.t === 'goal-round')
    .map((round) => ({ log, round })));
  const loopFinished = loops.flatMap((log) => log.records.filter((record) => record.t === 'goal-finished'));

  return {
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
    },
  };
}

export async function loadWorkspaceObservation(dataDir: string): Promise<ObservationReport> {
  const [sessions, goals, loops, cron, cronDaemon] = await Promise.all([
    readJsonlDir(join(dataDir, 'sessions'), parseSessionLog),
    readJsonlDir(join(dataDir, 'goals'), parseGoalLog),
    readJsonlDir(join(dataDir, 'loops'), parseLoopLog),
    readJsonlFile(join(dataDir, 'cron', 'loop-cron.jsonl'), parseLoopCronLog),
    readJsonlFile(join(dataDir, 'cron', 'loop-cron-daemon.jsonl'), parseLoopCronDaemonLog),
  ]);

  return buildObservationReport({
    sessions,
    goals,
    loops,
    ...(cron === undefined ? {} : { cron }),
    ...(cronDaemon === undefined ? {} : { cronDaemon }),
  });
}

export function formatObservationReport(report: ObservationReport): string {
  const lines = [
    'Observation: status/usage/audit (read-only)',
    'completion authority: none',
    `sessions: ${report.status.sessions.total} messages=${report.usage.sessionMessages} compactions=${report.usage.sessionCompactions}`,
    `goals: ${report.status.goals.total} active=${report.status.goals.byState.active} complete=${report.status.goals.byState.complete} blocked=${report.status.goals.byState.blocked}`,
    `loops: ${report.status.loops.total} loopTokens=${report.usage.loopTokens} loopFinishedGoals=${report.usage.loopFinishedGoals}`,
    `cron: attempts=${report.status.cron.attempts}`,
    `audit: trusted contracts=${report.audit.trustedContracts.length} worktree statuses=${report.audit.worktreeStatus.length} sandbox evidence: ${report.audit.sandboxEvidence.length}`,
  ];

  if (report.status.latestSession) {
    const session = report.status.latestSession;
    lines.push(`latest session: ${session.id} model=${session.model} messages=${session.messages}`);
  }
  if (report.status.latestGoal) {
    const goal = report.status.latestGoal;
    lines.push(`latest goal: ${goal.id} ${goal.state} verdict=${goal.verdict ?? '-'} rounds=${goal.rounds}`);
  }
  if (report.status.latestLoop) {
    const loop = report.status.latestLoop;
    lines.push(`latest loop: ${loop.id} completed=${loop.completed}/${loop.objectives} blocked=${loop.blocked} inFlight=${loop.inFlight} halted=${loop.halted ?? '-'}`);
  }
  if (report.status.cron.lastAttempt) {
    const cron = report.status.cron.lastAttempt;
    lines.push(`latest cron: ${cron.taskId} exit=${cron.exitCode ?? 'null'}${cron.loopId ? ` loop=${cron.loopId}` : ''}`);
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
