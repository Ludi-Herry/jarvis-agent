import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { appendFile, link, mkdir, open, readFile, stat, unlink, type FileHandle } from 'node:fs/promises';
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

export interface LoopCronLockHandle {
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface FileLoopCronLockOptions {
  staleMs?: number;
  now?: () => Date;
  token?: () => string;
  linkPath?: (existingPath: string, recoveryPath: string) => Promise<void>;
  beforeRenewOpen?: () => Promise<void>;
  beforeRenewWrite?: () => Promise<void>;
  beforeReleaseUnlink?: () => Promise<void>;
  writeText?: (handle: FileHandle, text: string) => Promise<void>;
}

export class FileLoopCronLock {
  private readonly staleMs: number;
  private readonly now: () => Date;
  private readonly token: () => string;
  private readonly linkPath: (existingPath: string, recoveryPath: string) => Promise<void>;
  private readonly beforeRenewOpen?: () => Promise<void>;
  private readonly beforeRenewWrite?: () => Promise<void>;
  private readonly beforeReleaseUnlink?: () => Promise<void>;
  private readonly writeText: (handle: FileHandle, text: string) => Promise<void>;
  private readonly recoveryPath: string;
  private readonly futureSkewMs = 5 * 60 * 1000;
  private readonly recoveryStaleMs = 5 * 60 * 1000;

  constructor(
    private readonly path: string,
    options: FileLoopCronLockOptions = {},
  ) {
    this.staleMs = options.staleMs ?? 3 * 60 * 60 * 1000 + 5 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.token = options.token ?? randomUUID;
    this.linkPath = options.linkPath ?? link;
    this.beforeRenewOpen = options.beforeRenewOpen;
    this.beforeRenewWrite = options.beforeRenewWrite;
    this.beforeReleaseUnlink = options.beforeReleaseUnlink;
    this.writeText = options.writeText ?? ((handle, text) => handle.writeFile(text));
    this.recoveryPath = `${path}.recovering`;
  }

  async tryAcquire(): Promise<LoopCronLockHandle | null> {
    await mkdir(dirname(this.path), { recursive: true });
    const token = this.token();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.recoveryInProgress()) return null;

      const acquired = await this.tryCreate(token);
      if (acquired !== null) return acquired;

      const existing = await this.lockSnapshot(this.path);
      if (existing === null) continue;
      if (!this.isStale(existing)) return null;
      return this.recoverStaleLock(existing, token);
    }
    return null;
  }

  private async tryCreate(token: string): Promise<LoopCronLockHandle | null> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, 'wx');
    } catch (err) {
      if (isAlreadyExists(err)) return null;
      throw err;
    }
    try {
      await this.writeLockMetadata(handle, token);
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(this.path).catch(() => undefined);
      throw err;
    }
    const owner = await this.lockSnapshot(this.path);
    if (owner === null || owner.token !== token) {
      await unlink(this.path).catch(() => undefined);
      throw new Error('cron lock metadata was not written');
    }
    const claimable = await this.claimLockForExclusivePathMutation(owner, sameOwner);
    if (!claimable) {
      await unlink(this.path).catch(() => undefined);
      return null;
    }
    await unlink(this.recoveryPath).catch(() => undefined);
    return {
      renew: async () => {
        await this.renew(owner);
      },
      release: async () => {
        await this.release(owner);
      },
    };
  }

  private async renew(owner: LoopCronLockSnapshot): Promise<void> {
    await this.beforeRenewOpen?.();
    const handle = await open(this.path, 'r+');
    try {
      const current = await handle.stat();
      if (fileIdentity(current) !== owner.fileIdentity) throw new Error('cron lock ownership lost');
      if (!sameOwner(await this.lockSnapshot(this.path), owner)) throw new Error('cron lock ownership lost');
      await this.beforeRenewWrite?.();
      await handle.truncate(0);
      await this.writeLockMetadata(handle, owner.token);
    } finally {
      await handle.close();
    }
    if (!sameOwner(await this.lockSnapshot(this.path), owner)) throw new Error('cron lock ownership lost');
  }

  private async release(owner: LoopCronLockSnapshot): Promise<void> {
    const claimed = await this.claimLockForExclusivePathMutation(owner, sameOwner);
    if (!claimed) return;
    try {
      if (!sameOwner(await this.lockSnapshot(this.path), owner)) return;
      await this.beforeReleaseUnlink?.();
      if (!sameOwner(await this.lockSnapshot(this.path), owner)) return;
      await unlink(this.path);
    } finally {
      await unlink(this.recoveryPath).catch(() => undefined);
    }
  }

  private async writeLockMetadata(handle: FileHandle, token: string): Promise<void> {
    await this.writeText(handle, JSON.stringify({ token, pid: process.pid, acquiredAt: this.now().toISOString() }));
  }

  private async recoveryInProgress(): Promise<boolean> {
    const recovery = await stat(this.recoveryPath).catch((err: unknown) => {
      if (isNotFound(err)) return null;
      throw err;
    });
    if (recovery === null) return false;
    if (this.now().getTime() - recovery.ctimeMs <= this.recoveryStaleMs) return true;
    await unlink(this.recoveryPath).catch((err: unknown) => {
      if (!isNotFound(err)) throw err;
    });
    return false;
  }

  private async recoverStaleLock(expected: LoopCronLockSnapshot, token: string): Promise<LoopCronLockHandle | null> {
    const claimed = await this.claimLockForExclusivePathMutation(expected, sameSnapshot);
    if (!claimed) return null;
    try {
      if (!sameSnapshot(await this.lockSnapshot(this.recoveryPath), expected) || !this.isStale(expected)) return null;
      if (!sameSnapshot(await this.lockSnapshot(this.path), expected)) return null;
      try {
        await unlink(this.path);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      return this.tryCreate(token);
    } finally {
      await unlink(this.recoveryPath).catch(() => undefined);
    }
  }

  private async claimLockForExclusivePathMutation(
    expected: LoopCronLockSnapshot,
    matches: (actual: LoopCronLockSnapshot | null, expected: LoopCronLockSnapshot) => boolean,
  ): Promise<boolean> {
    try {
      await this.linkPath(this.path, this.recoveryPath);
    } catch (err) {
      if (isAlreadyExists(err) || isNotFound(err) || isUnsupportedLink(err)) return false;
      throw err;
    }

    const claimed = await this.lockSnapshot(this.recoveryPath);
    if (!matches(claimed, expected)) {
      await unlink(this.recoveryPath).catch(() => undefined);
      return false;
    }
    return true;
  }

  private async lockSnapshot(path: string): Promise<LoopCronLockSnapshot | null> {
    const stats = await stat(path).catch((err: unknown) => {
      if (isNotFound(err)) return null;
      throw err;
    });
    if (stats === null) return null;

    const metadata = parseLockMetadata(await readFile(path, 'utf8').catch(() => null));
    if (metadata !== null && metadata.acquiredAt.getTime() <= this.now().getTime() + this.futureSkewMs) {
      return {
        token: metadata.token,
        acquiredAt: metadata.acquiredAt,
        contentIdentity: `valid:${metadata.token}:${metadata.acquiredAt.toISOString()}`,
        fileIdentity: fileIdentity(stats),
      };
    }
    return {
      token: '',
      acquiredAt: new Date(stats.mtimeMs),
      contentIdentity: `invalid:${stats.mtimeMs}:${stats.size}`,
      fileIdentity: fileIdentity(stats),
    };
  }

  private isStale(snapshot: LoopCronLockSnapshot): boolean {
    return this.now().getTime() - snapshot.acquiredAt.getTime() > this.staleMs;
  }
}

interface LoopCronLockSnapshot {
  contentIdentity: string;
  fileIdentity: string;
  acquiredAt: Date;
  token: string;
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
    beforeRunTask?: (task: LoopCronTask) => Promise<void>;
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

    await deps.beforeRunTask?.(task);
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

function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'EEXIST';
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function isUnsupportedLink(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ['EPERM', 'EINVAL', 'ENOTSUP', 'EXDEV'].includes(String((err as { code?: unknown }).code))
  );
}

function sameOwner(actual: LoopCronLockSnapshot | null, expected: LoopCronLockSnapshot): boolean {
  return actual !== null && actual.fileIdentity === expected.fileIdentity && actual.token === expected.token;
}

function sameSnapshot(actual: LoopCronLockSnapshot | null, expected: LoopCronLockSnapshot): boolean {
  return actual !== null && actual.fileIdentity === expected.fileIdentity && actual.contentIdentity === expected.contentIdentity;
}

function fileIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

function parseLockMetadata(text: string | null): { token: string; acquiredAt: Date } | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { token?: unknown; acquiredAt?: unknown };
    if (typeof parsed.token !== 'string' || typeof parsed.acquiredAt !== 'string') return null;
    const acquiredAt = new Date(parsed.acquiredAt);
    if (!Number.isFinite(acquiredAt.getTime())) return null;
    return { token: parsed.token, acquiredAt };
  } catch {
    return null;
  }
}
