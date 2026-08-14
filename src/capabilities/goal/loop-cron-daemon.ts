import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  assertOperationalJsonlIntegrity,
  hasFiniteNumberFields,
  hasStringFields,
  isJsonObject,
  parseJsonlWithDiagnostics,
} from '../../runtime/jsonl-integrity.js';
import type { LoopCronConfig, LoopCronTask } from './loop-cron-config.js';
import { runLoopCronOnce, type LoopCronState, type LoopCronStore, type LoopCronTaskResult } from './loop-cron.js';

export type LoopCronDaemonRecord =
  | { t: 'daemon-started'; pid: number; cronMapPath: string; pollMs: number; startedAt: string }
  | { t: 'daemon-heartbeat'; at: string; nextWakeAt: string }
  | { t: 'daemon-stopped'; reason: 'signal' | 'completed' | 'error'; at: string }
  | { t: 'scan-started'; at: string }
  | { t: 'scan-finished'; at: string; triggered: number; skipped: number; parked: number; failed?: number }
  | { t: 'scan-skipped'; at: string; reason: 'scan-lock-held' }
  | { t: 'task-started'; taskId: string; scheduledFor: string; startedAt: string; command?: string }
  | { t: 'task-finished'; taskId: string; scheduledFor: string; startedAt: string; finishedAt: string; exitCode: number | null; loopId?: string }
  | { t: 'task-parked'; taskId: string; reason: 'started-without-finished'; at: string };

export interface LoopCronDaemonState {
  parkedTaskIds: Set<string>;
}

export interface LoopCronDaemonStore {
  append(record: LoopCronDaemonRecord): Promise<void>;
}

export interface LoopCronDaemonRunResult {
  triggered: number;
  skipped: number;
  failed: number;
  parked: number;
}

export interface LoopCronDaemonSignalState {
  requested: boolean;
  onSignal?: () => void;
  dispose(): void;
}

export function isLoopCronDaemonRecord(value: unknown): value is LoopCronDaemonRecord {
  if (!isJsonObject(value) || typeof value.t !== 'string') return false;
  switch (value.t) {
    case 'daemon-started':
      return hasFiniteNumberFields(value, 'pid', 'pollMs') && hasStringFields(value, 'cronMapPath', 'startedAt');
    case 'daemon-heartbeat':
      return hasStringFields(value, 'at', 'nextWakeAt');
    case 'daemon-stopped':
      return (value.reason === 'signal' || value.reason === 'completed' || value.reason === 'error') && typeof value.at === 'string';
    case 'scan-started':
      return typeof value.at === 'string';
    case 'scan-finished':
      return typeof value.at === 'string'
        && hasFiniteNumberFields(value, 'triggered', 'skipped', 'parked')
        && (value.failed === undefined || (typeof value.failed === 'number' && Number.isFinite(value.failed)));
    case 'scan-skipped':
      return typeof value.at === 'string' && value.reason === 'scan-lock-held';
    case 'task-started':
      return hasStringFields(value, 'taskId', 'scheduledFor', 'startedAt')
        && (value.command === undefined || typeof value.command === 'string');
    case 'task-finished':
      return hasStringFields(value, 'taskId', 'scheduledFor', 'startedAt', 'finishedAt')
        && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)))
        && (value.loopId === undefined || typeof value.loopId === 'string');
    case 'task-parked':
      return hasStringFields(value, 'taskId', 'at') && value.reason === 'started-without-finished';
    default:
      return false;
  }
}

export function parseLoopCronDaemonLog(text: string): LoopCronDaemonRecord[] {
  return parseJsonlWithDiagnostics(text, isLoopCronDaemonRecord).records;
}

export function replayLoopCronDaemonState(records: LoopCronDaemonRecord[]): LoopCronDaemonState {
  const inFlight = new Set<string>();
  for (const record of records) {
    if (record.t === 'task-started') inFlight.add(record.taskId);
    if (record.t === 'task-finished') inFlight.delete(record.taskId);
  }
  return { parkedTaskIds: inFlight };
}

export class FileLoopCronDaemonStore implements LoopCronDaemonStore {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  async append(record: LoopCronDaemonRecord): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

export async function loadLoopCronDaemonState(path: string): Promise<LoopCronDaemonState> {
  try {
    const parsed = parseJsonlWithDiagnostics(await readFile(path, 'utf8'), isLoopCronDaemonRecord);
    assertOperationalJsonlIntegrity('cron daemon', parsed.malformed, true);
    return replayLoopCronDaemonState(parsed.records);
  } catch (err) {
    if (isNotFound(err)) return { parkedTaskIds: new Set() };
    throw new Error(`cron daemon state cannot be read: ${path}: ${errorMessage(err)}`, { cause: err });
  }
}

export async function runLoopCronDaemonOnce(
  config: LoopCronConfig,
  deps: {
    cronStore: LoopCronStore;
    daemonStore: LoopCronDaemonStore;
    runTask: (task: LoopCronTask) => Promise<LoopCronTaskResult>;
    commandForTask?: (task: LoopCronTask) => string;
    beforeRunTask?: (task: LoopCronTask) => Promise<void>;
    shouldStop?: () => boolean;
    cronState?: LoopCronState;
    daemonState?: LoopCronDaemonState;
    now?: () => Date;
  },
): Promise<LoopCronDaemonRunResult> {
  const now = deps.now ?? (() => new Date());
  const daemonState = deps.daemonState ?? { parkedTaskIds: new Set<string>() };
  const runnableTasks: LoopCronTask[] = [];
  let parked = 0;

  for (const task of config.tasks) {
    if (daemonState.parkedTaskIds.has(task.id)) {
      parked++;
      await deps.daemonStore.append({ t: 'task-parked', taskId: task.id, reason: 'started-without-finished', at: now().toISOString() });
    } else {
      runnableTasks.push(task);
    }
  }

  const result = await runLoopCronOnce(
    { tasks: runnableTasks },
    {
      store: deps.cronStore,
      state: deps.cronState,
      now,
      beforeRunTask: async (task, context) => {
        await deps.daemonStore.append({
          t: 'task-started',
          taskId: task.id,
          scheduledFor: context.scheduledFor,
          startedAt: context.startedAt,
          ...(deps.commandForTask === undefined ? {} : { command: deps.commandForTask(task) }),
        });
        await deps.beforeRunTask?.(task);
      },
      runTask: deps.runTask,
      shouldStop: deps.shouldStop,
      afterRecordAttempt: async (_task, context) => {
        await deps.daemonStore.append({
          t: 'task-finished',
          taskId: context.taskId,
          scheduledFor: context.scheduledFor,
          startedAt: context.startedAt,
          finishedAt: context.finishedAt,
          exitCode: context.exitCode,
          ...(context.loopId === undefined ? {} : { loopId: context.loopId }),
        });
      },
    },
  );

  return { ...result, parked };
}

export function createLoopCronDaemonSignalState(): LoopCronDaemonSignalState {
  const state: LoopCronDaemonSignalState = {
    requested: false,
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
  const onSignal = (): void => {
    state.requested = true;
    state.onSignal?.();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return state;
}

export function sleepOrLoopCronDaemonSignal(ms: number, stop: LoopCronDaemonSignalState): Promise<void> {
  if (stop.requested) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    stop.onSignal = done;
    function done(): void {
      clearTimeout(timer);
      if (stop.onSignal === done) stop.onSignal = undefined;
      resolve();
    }
  });
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
