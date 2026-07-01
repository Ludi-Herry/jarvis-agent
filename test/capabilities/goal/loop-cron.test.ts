import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileLoopCronStore,
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

    expect(result).toEqual({ triggered: 0, skipped: 1 });
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

    expect(result).toEqual({ triggered: 1, skipped: 0 });
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

    expect(result).toEqual({ triggered: 0, skipped: 1 });
    expect(calls).toEqual(['task-a']);
  });
});
