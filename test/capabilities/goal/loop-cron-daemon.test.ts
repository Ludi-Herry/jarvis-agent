import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileLoopCronDaemonStore,
  createLoopCronDaemonSignalState,
  FileLoopCronStore,
  loadLoopCronDaemonState,
  parseLoopCronDaemonLog,
  replayLoopCronDaemonState,
  runLoopCronDaemonOnce,
  sleepOrLoopCronDaemonSignal,
  type LoopCronConfig,
} from '../../../src/capabilities/goal/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-loop-cron-daemon-'));
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

describe('loop cron daemon replay', () => {
  it('uses an empty daemon state when the daemon log is missing', async () => {
    await expect(loadLoopCronDaemonState(join(dir, 'missing-daemon.jsonl'))).resolves.toEqual({
      parkedTaskIds: new Set(),
    });
  });

  it('fails closed when the daemon log cannot be read', async () => {
    await expect(loadLoopCronDaemonState(dir)).rejects.toThrow(/cron daemon state cannot be read/);
  });

  it('parks a task that started without a matching finish and skips truncated tails', () => {
    const records = parseLoopCronDaemonLog(
      [
        JSON.stringify({ t: 'task-started', taskId: 'task-a', scheduledFor: '2026-07-01T00:00:00.000Z', startedAt: '2026-07-01T00:01:00.000Z' }),
        '{',
      ].join('\n'),
    );

    const state = replayLoopCronDaemonState(records);

    expect(state.parkedTaskIds).toEqual(new Set(['task-a']));
  });

  it('does not park a task that has a matching finish', () => {
    const records = parseLoopCronDaemonLog(
      [
        JSON.stringify({ t: 'task-started', taskId: 'task-a', scheduledFor: '2026-07-01T00:00:00.000Z', startedAt: '2026-07-01T00:01:00.000Z' }),
        JSON.stringify({ t: 'task-finished', taskId: 'task-a', scheduledFor: '2026-07-01T00:00:00.000Z', startedAt: '2026-07-01T00:01:00.000Z', finishedAt: '2026-07-01T00:02:00.000Z', exitCode: 0 }),
      ].join('\n'),
    );

    const state = replayLoopCronDaemonState(records);

    expect(state.parkedTaskIds).toEqual(new Set());
  });
});

describe('runLoopCronDaemonOnce', () => {
  it('records task lifecycle around the cron attempt and advances nextRunAt', async () => {
    const cronPath = join(dir, 'loop-cron.jsonl');
    const daemonPath = join(dir, 'loop-cron-daemon.jsonl');
    const cronStore = new FileLoopCronStore(cronPath);
    const daemonStore = new FileLoopCronDaemonStore(daemonPath);

    const result = await runLoopCronDaemonOnce(config(), {
      cronStore,
      daemonStore,
      now: () => new Date('2026-07-01T00:10:00.000Z'),
      runTask: async () => ({ exitCode: 0, loopId: 'L1' }),
    });

    expect(result).toEqual({ triggered: 1, skipped: 0, parked: 0 });
    const daemonText = await readFile(daemonPath, 'utf8');
    expect(daemonText).toContain('"t":"task-started"');
    expect(daemonText).toContain('"t":"task-finished"');
    expect(daemonText.indexOf('"t":"task-started"')).toBeLessThan(daemonText.indexOf('"t":"task-finished"'));
    await expect(readFile(cronPath, 'utf8')).resolves.toContain('"t":"cron-attempt"');
  });

  it('parks started-without-finished tasks instead of running them again', async () => {
    const cronPath = join(dir, 'loop-cron.jsonl');
    const daemonPath = join(dir, 'loop-cron-daemon.jsonl');
    const cronStore = new FileLoopCronStore(cronPath);
    const daemonStore = new FileLoopCronDaemonStore(daemonPath);
    const daemonState = replayLoopCronDaemonState(
      parseLoopCronDaemonLog(
        JSON.stringify({ t: 'task-started', taskId: 'task-a', scheduledFor: '2026-07-01T00:00:00.000Z', startedAt: '2026-07-01T00:01:00.000Z' }),
      ),
    );
    const seen: string[] = [];

    const result = await runLoopCronDaemonOnce(config(), {
      cronStore,
      daemonStore,
      daemonState,
      now: () => new Date('2026-07-01T00:10:00.000Z'),
      runTask: async (task) => {
        seen.push(task.id);
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ triggered: 0, skipped: 0, parked: 1 });
    expect(seen).toEqual([]);
    await expect(readFile(cronPath, 'utf8')).rejects.toThrow();
    await expect(readFile(daemonPath, 'utf8')).resolves.toContain('"t":"task-parked"');
  });

  it('stops accepting new due tasks after stop is requested during a task', async () => {
    const cronPath = join(dir, 'loop-cron.jsonl');
    const daemonPath = join(dir, 'loop-cron-daemon.jsonl');
    const cronStore = new FileLoopCronStore(cronPath);
    const daemonStore = new FileLoopCronDaemonStore(daemonPath);
    const seen: string[] = [];
    let stop = false;

    const result = await runLoopCronDaemonOnce(
      {
        tasks: [
          ...config().tasks,
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
        cronStore,
        daemonStore,
        now: () => new Date('2026-07-01T00:10:00.000Z'),
        shouldStop: () => stop,
        runTask: async (task) => {
          seen.push(task.id);
          stop = true;
          return { exitCode: 0 };
        },
      },
    );

    expect(result).toEqual({ triggered: 1, skipped: 0, parked: 0 });
    expect(seen).toEqual(['task-a']);
    const daemonText = await readFile(daemonPath, 'utf8');
    expect(daemonText).toContain('"taskId":"task-a"');
    expect(daemonText).not.toContain('"taskId":"task-b"');
  });
});

describe('loop cron daemon signal helpers', () => {
  it('wakes a sleeping daemon when SIGINT is emitted', async () => {
    const state = createLoopCronDaemonSignalState();
    try {
      const sleep = sleepOrLoopCronDaemonSignal(60_000, state);
      process.emit('SIGINT');
      await expect(sleep).resolves.toBeUndefined();
      expect(state.requested).toBe(true);
    } finally {
      state.dispose();
    }
  });
});
