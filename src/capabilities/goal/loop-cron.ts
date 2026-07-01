import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LoopCronConfig, LoopCronTask } from './loop-cron-config.js';

export interface LoopCronTaskResult {
  exitCode: number | null;
  loopId?: string;
}

export interface LoopCronStore {
  recordAttempt(record: Omit<LoopCronAttemptRecord, 't'>): Promise<void>;
}

export type LoopCronRecord = LoopCronAttemptRecord;

export interface LoopCronAttemptRecord {
  t: 'cron-attempt';
  taskId: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  loopId?: string;
  nextRunAt: string;
}

export interface LoopCronState {
  nextRunAtByTaskId: Map<string, string>;
}

export interface LoopCronRunResult {
  triggered: number;
  skipped: number;
}

export function parseLoopCronLog(text: string): LoopCronRecord[] {
  const records: LoopCronRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as LoopCronRecord);
    } catch {
      // Skip a crash-truncated tail line.
    }
  }
  return records;
}

export function replayLoopCronState(records: LoopCronRecord[]): LoopCronState {
  const nextRunAtByTaskId = new Map<string, string>();
  for (const record of records) {
    if (record.t === 'cron-attempt') nextRunAtByTaskId.set(record.taskId, record.nextRunAt);
  }
  return { nextRunAtByTaskId };
}

export class FileLoopCronStore implements LoopCronStore {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  async recordAttempt(record: Omit<LoopCronAttemptRecord, 't'>): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.path, `${JSON.stringify({ t: 'cron-attempt', ...record })}\n`, 'utf8');
  }
}

export async function loadLoopCronState(path: string): Promise<LoopCronState> {
  try {
    return replayLoopCronState(parseLoopCronLog(await readFile(path, 'utf8')));
  } catch {
    return { nextRunAtByTaskId: new Map() };
  }
}

export async function runLoopCronOnce(
  config: LoopCronConfig,
  deps: {
    store: LoopCronStore;
    runTask: (task: LoopCronTask) => Promise<LoopCronTaskResult>;
    state?: LoopCronState;
    now?: () => Date;
  },
): Promise<LoopCronRunResult> {
  const now = deps.now ?? (() => new Date());
  const state = deps.state ?? { nextRunAtByTaskId: new Map<string, string>() };
  let triggered = 0;
  let skipped = 0;

  for (const task of config.tasks) {
    const scheduledFor = state.nextRunAtByTaskId.get(task.id) ?? task.nextRunAt;
    const start = now();
    if (new Date(scheduledFor).getTime() > start.getTime()) {
      skipped++;
      continue;
    }

    const result = await deps.runTask(task);
    const finish = now();
    const nextRunAt = new Date(finish.getTime() + task.intervalMinutes * 60_000).toISOString();
    await deps.store.recordAttempt({
      taskId: task.id,
      scheduledFor,
      startedAt: start.toISOString(),
      finishedAt: finish.toISOString(),
      exitCode: result.exitCode,
      loopId: result.loopId,
      nextRunAt,
    });
    state.nextRunAtByTaskId.set(task.id, nextRunAt);
    triggered++;
  }

  return { triggered, skipped };
}
