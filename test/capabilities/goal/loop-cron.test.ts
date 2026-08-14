import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileLoopCronStore,
  FileLoopCronLock,
  loadLoopCronState,
  parseLoopCronLog,
  replayLoopCronState,
  runLoopCronOnce,
  type LoopCronConfig,
} from '../../../src/capabilities/goal/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-loop-cron-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(over: Partial<LoopCronConfig['tasks'][number]> = {}): LoopCronConfig {
  return {
    tasks: [
      {
        id: 'task-a',
        objectivesFile: 'tasks.txt',
        intervalMinutes: 30,
        nextRunAt: '2026-07-01T00:00:00.000Z',
        unattended: true,
        ...over,
      },
    ],
  };
}

describe('runLoopCronOnce', () => {
  it('uses an empty cron state when the cron log is missing', async () => {
    const state = await loadLoopCronState(join(dir, 'missing-cron.jsonl'));

    expect(state.nextRunAtByTaskId).toEqual(new Map());
  });

  it('fails closed when the cron log cannot be read', async () => {
    const path = join(dir, 'cron-as-dir');
    await mkdir(path);

    await expect(loadLoopCronState(path)).rejects.toThrow(/cron state cannot be read/);
  });

  it('fails closed when a cron log contains an invalid middle record', async () => {
    const path = join(dir, 'cron-corrupt.jsonl');
    await writeFile(path, [
      JSON.stringify({
        t: 'cron-attempt',
        taskId: 'task-a',
        scheduledFor: '2026-07-01T00:00:00.000Z',
        startedAt: '2026-07-01T00:01:00.000Z',
        finishedAt: '2026-07-01T00:02:00.000Z',
        exitCode: 0,
        nextRunAt: '2026-07-01T00:30:00.000Z',
      }),
      '{}',
      JSON.stringify({
        t: 'cron-attempt',
        taskId: 'task-a',
        scheduledFor: '2026-07-01T00:30:00.000Z',
        startedAt: '2026-07-01T00:31:00.000Z',
        finishedAt: '2026-07-01T00:32:00.000Z',
        exitCode: 0,
        nextRunAt: '2026-07-01T01:00:00.000Z',
      }),
    ].join('\n'));

    await expect(loadLoopCronState(path)).rejects.toThrow(/cron state is corrupt at line 2/);
  });

  it('recovers cron state when only the final append is truncated', async () => {
    const path = join(dir, 'cron-truncated.jsonl');
    await writeFile(path, [
      JSON.stringify({
        t: 'cron-attempt',
        taskId: 'task-a',
        scheduledFor: '2026-07-01T00:00:00.000Z',
        startedAt: '2026-07-01T00:01:00.000Z',
        finishedAt: '2026-07-01T00:02:00.000Z',
        exitCode: 0,
        nextRunAt: '2026-07-01T00:30:00.000Z',
      }),
      '{',
    ].join('\n'));

    const state = await loadLoopCronState(path);

    expect(state.nextRunAtByTaskId).toEqual(new Map([['task-a', '2026-07-01T00:30:00.000Z']]));
  });

  it('skips tasks that are not due and records no attempt', async () => {
    const path = join(dir, 'cron.jsonl');
    const store = new FileLoopCronStore(path);
    const seen: string[] = [];

    const result = await runLoopCronOnce(config({ nextRunAt: '2026-07-01T01:00:00.000Z' }), {
      store,
      now: () => new Date('2026-07-01T00:00:00.000Z'),
      runTask: async (task) => {
        seen.push(task.id);
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ triggered: 0, skipped: 1, failed: 0 });
    expect(seen).toEqual([]);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('runs a due task once and records exitCode plus nextRunAt', async () => {
    const path = join(dir, 'cron.jsonl');
    const store = new FileLoopCronStore(path);

    const result = await runLoopCronOnce(config(), {
      store,
      now: () => new Date('2026-07-01T00:10:00.000Z'),
      runTask: async () => ({ exitCode: 0, loopId: 'L1' }),
    });

    expect(result).toEqual({ triggered: 1, skipped: 0, failed: 0 });
    const records = parseLoopCronLog(await readFile(path, 'utf8'));
    expect(records).toEqual([
      {
        t: 'cron-attempt',
        taskId: 'task-a',
        scheduledFor: '2026-07-01T00:00:00.000Z',
        startedAt: '2026-07-01T00:10:00.000Z',
        finishedAt: '2026-07-01T00:10:00.000Z',
        exitCode: 0,
        loopId: 'L1',
        nextRunAt: '2026-07-01T00:40:00.000Z',
      },
    ]);
  });

  it('uses replayed nextRunAt so repeated scans do not hot-loop', async () => {
    const path = join(dir, 'cron.jsonl');
    const store = new FileLoopCronStore(path);
    const calls: string[] = [];

    await runLoopCronOnce(config(), {
      store,
      now: () => new Date('2026-07-01T00:10:00.000Z'),
      runTask: async (task) => {
        calls.push(task.id);
        return { exitCode: 1 };
      },
    });
    const state = replayLoopCronState(parseLoopCronLog(await readFile(path, 'utf8')));
    const result = await runLoopCronOnce(config(), {
      store,
      state,
      now: () => new Date('2026-07-01T00:20:00.000Z'),
      runTask: async (task) => {
        calls.push(task.id);
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ triggered: 0, skipped: 1, failed: 0 });
    expect(calls).toEqual(['task-a']);
  });

  it('runs a beforeRunTask hook before each due task', async () => {
    const path = join(dir, 'cron.jsonl');
    const store = new FileLoopCronStore(path);
    const order: string[] = [];

    await runLoopCronOnce(
      {
        tasks: [
          {
            id: 'task-a',
            objectivesFile: 'tasks-a.txt',
            intervalMinutes: 30,
            nextRunAt: '2026-07-01T00:00:00.000Z',
            unattended: true,
          },
          {
            id: 'task-b',
            objectivesFile: 'tasks-b.txt',
            intervalMinutes: 30,
            nextRunAt: '2026-07-01T00:00:00.000Z',
            unattended: true,
          },
        ],
      },
      {
        store,
        now: () => new Date('2026-07-01T00:10:00.000Z'),
        beforeRunTask: async (task) => {
          order.push(`renew:${task.id}`);
        },
        runTask: async (task) => {
          order.push(`run:${task.id}`);
          return { exitCode: 0 };
        },
      },
    );

    expect(order).toEqual(['renew:task-a', 'run:task-a', 'renew:task-b', 'run:task-b']);
  });

  it('counts every due child with a nonzero exit code as failed', async () => {
    const path = join(dir, 'cron.jsonl');
    const store = new FileLoopCronStore(path);

    const result = await runLoopCronOnce(config(), {
      store,
      now: () => new Date('2026-07-01T00:10:00.000Z'),
      runTask: async () => ({ exitCode: 2 }),
    });

    expect(result).toEqual({ triggered: 1, skipped: 0, failed: 1 });
  });
});

describe('FileLoopCronLock', () => {
  it('allows only one scan to hold the lock at a time and releases it explicitly', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    const first = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
      token: () => 'first-token',
    }).tryAcquire();
    expect(first).not.toBeNull();

    const second = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:00:01.000Z'),
      staleMs: 60_000,
      token: () => 'second-token',
    }).tryAcquire();
    expect(second).toBeNull();

    await first?.release();
    const third = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:00:02.000Z'),
      token: () => 'third-token',
    }).tryAcquire();
    expect(third).not.toBeNull();
    await third?.release();
  });

  it('reclaims an expired lock before acquiring a new one', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await writeFile(lockPath, JSON.stringify({ token: 'old-token', pid: 1, acquiredAt: '2026-07-01T00:00:00.000Z' }));

    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:02:00.000Z'),
      staleMs: 60_000,
      token: () => 'new-token',
    }).tryAcquire();

    expect(lock).not.toBeNull();
    expect(await readFile(lockPath, 'utf8')).toContain('new-token');
    await lock?.release();
  });

  it('lets only one contender recover an expired lock', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await writeFile(lockPath, JSON.stringify({ token: 'old-token', pid: 1, acquiredAt: '2026-07-01T00:00:00.000Z' }));

    const contenders = await Promise.allSettled([
      new FileLoopCronLock(lockPath, {
        now: () => new Date('2026-07-01T00:02:00.000Z'),
        staleMs: 60_000,
        token: () => 'a-token',
      }).tryAcquire(),
      new FileLoopCronLock(lockPath, {
        now: () => new Date('2026-07-01T00:02:00.000Z'),
        staleMs: 60_000,
        token: () => 'b-token',
      }).tryAcquire(),
    ]);

    expect(contenders.every((result) => result.status === 'fulfilled')).toBe(true);
    const acquired = contenders.flatMap((result) => (result.status === 'fulfilled' && result.value !== null ? [result.value] : []));
    expect(acquired).toHaveLength(1);
    await acquired[0]?.release();
  });

  it('does not recover a stale lock while a fresh recovery guard exists', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await writeFile(lockPath, JSON.stringify({ token: 'old-token', pid: 1, acquiredAt: '2026-07-01T00:00:00.000Z' }));
    await writeFile(`${lockPath}.recovering`, 'active recovery');

    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:02:00.000Z'),
      staleMs: 60_000,
      token: () => 'new-token',
    }).tryAcquire();

    expect(lock).toBeNull();
    expect(await readFile(lockPath, 'utf8')).toContain('old-token');
  });

  it('does not reclaim a fresh lock with invalid metadata', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await writeFile(lockPath, '{');
    await utimes(lockPath, new Date('2026-07-01T00:00:30.000Z'), new Date('2026-07-01T00:00:30.000Z'));

    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:01:00.000Z'),
      staleMs: 60_000,
    }).tryAcquire();

    expect(lock).toBeNull();
  });

  it('reclaims an expired lock with invalid metadata using file mtime', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await writeFile(lockPath, '{');
    await utimes(lockPath, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'));

    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:02:00.000Z'),
      staleMs: 60_000,
      token: () => 'new-token',
    }).tryAcquire();

    expect(lock).not.toBeNull();
    expect(await readFile(lockPath, 'utf8')).toContain('new-token');
    await lock?.release();
  });

  it('reclaims a future-dated lock using file mtime fallback', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await writeFile(lockPath, JSON.stringify({ token: 'future-token', pid: 1, acquiredAt: '9999-01-01T00:00:00.000Z' }));
    await utimes(lockPath, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'));

    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:02:00.000Z'),
      staleMs: 60_000,
      token: () => 'new-token',
    }).tryAcquire();

    expect(lock).not.toBeNull();
    expect(await readFile(lockPath, 'utf8')).toContain('new-token');
    await lock?.release();
  });

  it('renews a held lock so long multi-task scans are not reclaimed', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    let now = new Date('2026-07-01T00:00:00.000Z');
    const lock = await new FileLoopCronLock(lockPath, {
      now: () => now,
      staleMs: 60_000,
      token: () => 'held-token',
    }).tryAcquire();
    expect(lock).not.toBeNull();

    now = new Date('2026-07-01T00:02:00.000Z');
    await lock?.renew();
    const contender = await new FileLoopCronLock(lockPath, {
      now: () => now,
      staleMs: 60_000,
      token: () => 'contender-token',
    }).tryAcquire();

    expect(contender).toBeNull();
    await lock?.release();
  });

  it('does not overwrite a replacement lock when renew races with stale recovery', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
      token: () => 'held-token',
      beforeRenewOpen: async () => {
        await unlink(lockPath);
        await writeFile(lockPath, JSON.stringify({ token: 'replacement-token', pid: 2, acquiredAt: '2026-07-01T00:02:00.000Z' }));
      },
    }).tryAcquire();
    expect(lock).not.toBeNull();

    await expect(lock?.renew()).rejects.toThrow('cron lock ownership lost');
    expect(await readFile(lockPath, 'utf8')).toContain('replacement-token');
  });

  it('does not delete a replacement lock when release races with stale recovery', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
      token: () => 'held-token',
      beforeReleaseUnlink: async () => {
        await unlink(lockPath);
        await writeFile(lockPath, JSON.stringify({ token: 'replacement-token', pid: 2, acquiredAt: '2026-07-01T00:02:00.000Z' }));
      },
    }).tryAcquire();
    expect(lock).not.toBeNull();

    await lock?.release();
    expect(await readFile(lockPath, 'utf8')).toContain('replacement-token');
  });

  it('treats unsupported hard-link recovery as an unrecoverable held lock', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await writeFile(lockPath, JSON.stringify({ token: 'old-token', pid: 1, acquiredAt: '2026-07-01T00:00:00.000Z' }));
    const err = new Error('links unsupported') as NodeJS.ErrnoException;
    err.code = 'EPERM';

    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:02:00.000Z'),
      staleMs: 60_000,
      linkPath: async () => {
        throw err;
      },
    }).tryAcquire();

    expect(lock).toBeNull();
    expect(await readFile(lockPath, 'utf8')).toContain('old-token');
  });

  it('does not acquire a fresh lock when owner claims are unsupported', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    const err = new Error('links unsupported') as NodeJS.ErrnoException;
    err.code = 'EPERM';

    const lock = await new FileLoopCronLock(lockPath, {
      linkPath: async () => {
        throw err;
      },
    }).tryAcquire();

    expect(lock).toBeNull();
    const next = await new FileLoopCronLock(lockPath).tryAcquire();
    expect(next).not.toBeNull();
    await next?.release();
  });

  it('does not delete a replacement lock on release', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    const lock = await new FileLoopCronLock(lockPath, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
      token: () => 'first-token',
    }).tryAcquire();
    expect(lock).not.toBeNull();

    await unlink(lockPath);
    await writeFile(lockPath, JSON.stringify({ token: 'replacement-token', pid: 2, acquiredAt: '2026-07-01T00:00:01.000Z' }));
    await lock?.release();

    expect(await readFile(lockPath, 'utf8')).toContain('replacement-token');
  });

  it('cleans up a newly created lock when metadata write fails', async () => {
    const lockPath = join(dir, 'loop-cron.lock');
    await expect(
      new FileLoopCronLock(lockPath, {
        writeText: async () => {
          throw new Error('disk full');
        },
      }).tryAcquire(),
    ).rejects.toThrow('disk full');

    const lock = await new FileLoopCronLock(lockPath).tryAcquire();
    expect(lock).not.toBeNull();
    await lock?.release();
  });
});
