import { describe, expect, it } from 'vitest';
import {
  runParallelLoop,
  type ParallelGoalRunSummary,
  type LoopContract,
  type LoopStore,
} from '../../../src/capabilities/goal/index.js';
import type { LoopRecord } from '../../../src/capabilities/goal/loop-store.js';
import { InMemoryEventBus } from '../../../src/runtime/event-bus.js';

function contract(over: Partial<LoopContract> = {}): LoopContract {
  return {
    maxGoals: 100,
    maxTotalTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxConsecutiveBlocked: 100,
    cnvWindow: 3,
    cnvThreshold: 3,
    perGoalBudget: { maxRounds: 8 },
    ...over,
  };
}

function fakeStore(): { store: LoopStore; records: LoopRecord[] } {
  const records: LoopRecord[] = [];
  const store: LoopStore = {
    recordStarted: async (r) => void records.push({ t: 'goal-started', ...r }),
    recordFinished: async (r) => void records.push({ t: 'goal-finished', ...r }),
    recordHalted: async (reason, at) => void records.push({ t: 'loop-halted', reason, at }),
  };
  return { store, records };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for condition');
}

const verified: ParallelGoalRunSummary = { state: 'complete', outcome: 'verified', rounds: 1, tokens: 10 };
const blockedCnv: ParallelGoalRunSummary = { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:a', rounds: 1, tokens: 10 };

describe('runParallelLoop', () => {
  it('creates fresh goal ids with filesystem-safe timestamps', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();

    await runParallelLoop(
      { id: 'L', objectives: ['a'], contract: contract() },
      {
        bus,
        loopStore: store,
        maxParallel: 1,
        runOne: async () => verified,
        stamp: () => '2026-07-02T11:52:46.399Z',
      },
    );

    const started = records.find((record) => record.t === 'goal-started');
    expect(started?.goalId).toBe('L-g0-2026-07-02T11-52-46-399Z');
  });

  it('never runs more than maxParallel goals at once', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const gates = [deferred<ParallelGoalRunSummary>(), deferred<ParallelGoalRunSummary>(), deferred<ParallelGoalRunSummary>()];
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;

    const promise = runParallelLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract() },
      {
        bus,
        loopStore: store,
        maxParallel: 2,
        runOne: async (_objective, _goalId, attempt) => {
          started.push(attempt.index);
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            return await gates[attempt.index].promise;
          } finally {
            active--;
          }
        },
      },
    );

    await waitFor(() => started.length === 2);
    expect(started).toEqual([0, 1]);
    expect(maxActive).toBe(2);

    gates[0].resolve(verified);
    await waitFor(() => started.length === 3);
    expect(started).toEqual([0, 1, 2]);
    expect(maxActive).toBe(2);

    gates[1].resolve(verified);
    gates[2].resolve(verified);
    const result = await promise;
    expect(result.reason).toBe('queue-empty');
    expect(result.completed).toBe(3);
  });

  it('halts new launches on verifier-health while letting in-flight goals finish', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const gates = [deferred<ParallelGoalRunSummary>(), deferred<ParallelGoalRunSummary>()];
    const started: number[] = [];

    const promise = runParallelLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 1, cnvThreshold: 1 }) },
      {
        bus,
        loopStore: store,
        maxParallel: 2,
        runOne: async (_objective, _goalId, attempt) => {
          started.push(attempt.index);
          return gates[attempt.index].promise;
        },
      },
    );

    await waitFor(() => started.length === 2);
    expect(started).toEqual([0, 1]);
    gates[0].resolve(blockedCnv);
    await tick(4);
    expect(started).toEqual([0, 1]);
    gates[1].resolve(verified);

    const result = await promise;
    expect(result.reason).toBe('verifier-health');
    expect(result.started).toBe(2);
    expect(result.completed).toBe(1);
    expect(result.blocked).toBe(1);
  });

  it('counts completion exactly from runOne summaries', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();

    const result = await runParallelLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract({ maxConsecutiveBlocked: 100 }) },
      {
        bus,
        loopStore: store,
        maxParallel: 3,
        runOne: async (_objective, _goalId, attempt) =>
          attempt.index === 1 ? { state: 'blocked', outcome: 'rejected', rounds: 1, tokens: 5 } : verified,
      },
    );

    expect(result.completed).toBe(2);
    expect(result.blocked).toBe(1);
    expect(records.filter((r) => r.t === 'goal-finished').map((r) => r.state).sort()).toEqual(['blocked', 'complete', 'complete']);
  });

  it('computes consecutive-blocked in queue order, not finish order', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const gates = [deferred<ParallelGoalRunSummary>(), deferred<ParallelGoalRunSummary>(), deferred<ParallelGoalRunSummary>()];
    const started: number[] = [];

    const promise = runParallelLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract({ maxConsecutiveBlocked: 2 }) },
      {
        bus,
        loopStore: store,
        maxParallel: 3,
        runOne: async (_objective, _goalId, attempt) => {
          started.push(attempt.index);
          return gates[attempt.index].promise;
        },
      },
    );

    await waitFor(() => started.length === 3);
    gates[1].resolve({ state: 'blocked', outcome: 'rejected', rounds: 1, tokens: 10 });
    gates[2].resolve(verified);
    await tick(4);
    gates[0].resolve({ state: 'blocked', outcome: 'rejected', rounds: 1, tokens: 10 });

    const result = await promise;
    expect(result.reason).toBe('consecutive-blocked');
    expect(result.completed).toBe(1);
    expect(result.blocked).toBe(2);
  });

  it('fails closed when a parallel run summary omits tokens', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();

    await expect(
      runParallelLoop(
        { id: 'L', objectives: ['a'], contract: contract() },
        {
          bus,
          loopStore: store,
          maxParallel: 1,
          runOne: async () => ({ state: 'complete', outcome: 'verified', rounds: 1 }) as unknown as ParallelGoalRunSummary,
        },
      ),
    ).rejects.toThrow(/tokens/);
  });
});
