import { describe, expect, it } from 'vitest';
import { runLoop, VerifierHealthMonitor, type GoalRunSummary, type LoopContract, type LoopStore } from '../../../src/capabilities/goal/loop.js';
import type { LoopRecord } from '../../../src/capabilities/goal/loop-store.js';
import { runGoal, type GoalRunDeps } from '../../../src/capabilities/goal/goal-loop.js';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { InMemoryEventBus, type Event } from '../../../src/runtime/event-bus.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';

/** A contract with generous defaults; override per test. */
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

/** An in-memory LoopStore that captures every record (so a test can assert the durable log). */
function fakeStore(): { store: LoopStore; records: LoopRecord[] } {
  const records: LoopRecord[] = [];
  const store: LoopStore = {
    recordStarted: async (r) => void records.push({ t: 'goal-started', ...r }),
    recordFinished: async (r) => void records.push({ t: 'goal-finished', ...r }),
    recordHalted: async (reason, at) => void records.push({ t: 'loop-halted', reason, at }),
  };
  return { store, records };
}

/** Capture loop_halt events off a bus. */
function captureHalts(bus: InMemoryEventBus): Array<Extract<Event, { type: 'loop_halt' }>> {
  const halts: Array<Extract<Event, { type: 'loop_halt' }>> = [];
  bus.subscribe((e) => {
    if (e.type === 'loop_halt') halts.push(e);
  });
  return halts;
}

/** A runOne that returns scripted summaries by call order and records which objectives it saw. */
function scriptedRunOne(summaries: GoalRunSummary[]): {
  runOne: (objective: string, goalId: string) => Promise<GoalRunSummary>;
  seen: string[];
} {
  const seen: string[] = [];
  let i = 0;
  const runOne = async (objective: string): Promise<GoalRunSummary> => {
    seen.push(objective);
    return summaries[Math.min(i++, summaries.length - 1)];
  };
  return { runOne, seen };
}

const blockedCnv: GoalRunSummary = { state: 'blocked', outcome: 'couldNotVerify', rounds: 1 };
const verified: GoalRunSummary = { state: 'complete', outcome: 'verified', rounds: 1 };
const rejectedBlocked: GoalRunSummary = { state: 'blocked', outcome: 'rejected', rounds: 1 };

describe('VerifierHealthMonitor — the cross-goal health unit', () => {
  it('halts when T couldNotVerify fill the window W', () => {
    const m = new VerifierHealthMonitor(3, 3);
    expect(m.record('couldNotVerify')).toBe('continue');
    expect(m.record('couldNotVerify')).toBe('continue');
    expect(m.record('couldNotVerify')).toBe('halt');
  });

  it('a non-cnv outcome inside the window prevents the trip (sliding)', () => {
    const m = new VerifierHealthMonitor(3, 3);
    m.record('couldNotVerify');
    m.record('verified');
    m.record('couldNotVerify');
    expect(m.record('couldNotVerify')).toBe('continue'); // window = [verified,cnv,cnv] → only 2 cnv
  });

  it('undefined outcomes are NOT samples (a budget/breaker block never feeds the monitor)', () => {
    const m = new VerifierHealthMonitor(3, 3);
    expect(m.record(undefined)).toBe('continue');
    expect(m.record(undefined)).toBe('continue');
    expect(m.record(undefined)).toBe('continue');
    m.record('couldNotVerify');
    m.record('couldNotVerify');
    expect(m.record('couldNotVerify')).toBe('halt');
  });

  it('isTripped reflects whether the window already holds T cnv (for resume re-assertion)', () => {
    const m = new VerifierHealthMonitor(3, 2);
    expect(m.isTripped()).toBe(false);
    m.record('couldNotVerify');
    expect(m.isTripped()).toBe(false);
    m.record('couldNotVerify');
    expect(m.isTripped()).toBe(true);
  });
});

describe('runLoop — cross-goal verifier-health (load-bearing, real wiring)', () => {
  it('trips verifier-health (NOT consecutive-blocked) on a run of couldNotVerify, halting to a human', async () => {
    const bus = new InMemoryEventBus();
    const halts = captureHalts(bus);
    const { store, records } = fakeStore();
    // Every goal returns couldNotVerify. maxConsecutiveBlocked is DELIBERATELY 3 too — the orthogonality
    // assertion: cnv is neutral to consecutive-blocked, so verifier-health must win.
    const { runOne, seen } = scriptedRunOne([blockedCnv]);
    const objectives = ['o0', 'o1', 'o2', 'o3', 'o4'];

    const result = await runLoop(
      { id: 'L', objectives, contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 3 }) },
      { bus, loopStore: store, runOne },
    );

    expect(result.reason).toBe('verifier-health'); // NOT 'consecutive-blocked' — orthogonality
    expect(result.started).toBe(3); // halted, not flag-and-continue
    expect(seen).toEqual(['o0', 'o1', 'o2']); // o3, o4 never started
    expect(halts).toEqual([{ type: 'loop_halt', loopId: 'L', reason: 'verifier-health' }]);
    expect(records.at(-1)).toMatchObject({ t: 'loop-halted', reason: 'verifier-health' }); // durable
  });

  it('a window that never fills with cnv drains to queue-empty (no false trip)', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    // cnv, verified, cnv, verified, cnv → window never holds 3 cnv at once
    const { runOne } = scriptedRunOne([blockedCnv, verified, blockedCnv, verified, blockedCnv]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd', 'e'], contract: contract({ cnvThreshold: 3, cnvWindow: 3 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.reason).toBe('queue-empty');
    expect(result.started).toBe(5);
  });

  it('trips verifier-health when couldNotVerify samples share the same verifier key', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne } = scriptedRunOne([{ state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:a', rounds: 1 }]);

    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
      { bus, loopStore: store, runOne },
    );

    expect(result.reason).toBe('verifier-health');
    expect(result.started).toBe(3);
  });

  it('does not merge couldNotVerify health across different verifier keys', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne } = scriptedRunOne([
      { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:a', rounds: 1 },
      { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:b', rounds: 1 },
      { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:c', rounds: 1 },
    ]);

    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
      { bus, loopStore: store, runOne },
    );

    expect(result.reason).toBe('queue-empty');
    expect(result.started).toBe(3);
  });

  it('all verified/rejected (no cnv) never health-halts', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne } = scriptedRunOne([verified, rejectedBlocked, verified, rejectedBlocked, verified]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd', 'e'], contract: contract({ maxConsecutiveBlocked: 100 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.reason).toBe('queue-empty');
  });
});

describe('runLoop — hard budget ceilings (each a precise stop)', () => {
  it('max-goals stops after the cap and starts no more', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne, seen } = scriptedRunOne([verified]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd', 'e'], contract: contract({ maxGoals: 2 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.reason).toBe('max-goals');
    expect(result.started).toBe(2);
    expect(seen).toEqual(['a', 'b']);
  });

  it('token-budget stops once cumulative tokens (from bus usage) cross the cap', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    // Each goal emits 120 tokens of usage; cap is 100 → after goal 0 cumulative=120 ≥ 100 → stop.
    const runOne = async (): Promise<GoalRunSummary> => {
      bus.emit({ type: 'usage', inputTokens: 60, outputTokens: 60 });
      return verified;
    };
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract({ maxTotalTokens: 100 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.reason).toBe('token-budget');
    expect(result.started).toBe(1);
    expect(result.cumulativeTokens).toBe(120);
  });

  it('wall-clock stops between goals when the deadline passes (injected clock)', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne } = scriptedRunOne([verified]);
    const times = [0, 10, 999]; // deadline=0+50=50; iter0 check=10 (<50, runs); iter1 check=999 (≥50, stop)
    let t = 0;
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract({ maxWallClockMs: 50 }) },
      { bus, loopStore: store, runOne, now: () => times[Math.min(t++, times.length - 1)] },
    );
    expect(result.reason).toBe('wall-clock');
    expect(result.started).toBe(1);
  });

  it('signal.aborted stops the drain with an emergency-stop terminal record', async () => {
    const bus = new InMemoryEventBus();
    const halts = captureHalts(bus);
    const { store, records } = fakeStore();
    const ac = new AbortController();
    ac.abort();
    const { runOne, seen } = scriptedRunOne([verified]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b'], contract: contract() },
      { bus, loopStore: store, runOne, signal: ac.signal },
    );
    expect(result.reason).toBe('emergency-stop');
    expect(seen).toEqual([]); // aborted before the first start
    expect(halts).toEqual([{ type: 'loop_halt', loopId: 'L', reason: 'emergency-stop' }]);
    expect(records.at(-1)).toMatchObject({ t: 'loop-halted', reason: 'emergency-stop' });
  });

  it('records loop-halted when a running goal aborts and throws', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();
    const ac = new AbortController();
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b'], contract: contract() },
      {
        bus,
        loopStore: store,
        signal: ac.signal,
        runOne: async () => {
          ac.abort();
          throw new Error('aborted during goal');
        },
      },
    );

    expect(result.reason).toBe('emergency-stop');
    expect(result.started).toBe(1);
    expect(records.map((record) => record.t)).toEqual(['goal-started', 'loop-halted']);
    expect(records.at(-1)).toMatchObject({ t: 'loop-halted', reason: 'emergency-stop' });
  });
});

describe('runLoop — consecutive-blocked breaker', () => {
  it('halts after maxConsecutiveBlocked consecutive non-cnv blocks', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne } = scriptedRunOne([rejectedBlocked]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ maxConsecutiveBlocked: 3 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.reason).toBe('consecutive-blocked');
    expect(result.started).toBe(3);
  });

  it('a complete resets the consecutive counter', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    // block, block, complete, block → never 3 consecutive
    const { runOne } = scriptedRunOne([rejectedBlocked, rejectedBlocked, verified, rejectedBlocked]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ maxConsecutiveBlocked: 3 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.reason).toBe('queue-empty');
    expect(result.started).toBe(4);
  });
});

describe('runLoop — anti-cheat: the loop has zero completion authority', () => {
  it('completed/blocked counts mirror runOne EXACTLY and the log copies state verbatim', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();
    const { runOne } = scriptedRunOne([verified, rejectedBlocked, verified, rejectedBlocked]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ maxConsecutiveBlocked: 100 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.completed).toBe(2);
    expect(result.blocked).toBe(2);
    const finishedStates = records.filter((r): r is Extract<LoopRecord, { t: 'goal-finished' }> => r.t === 'goal-finished').map((r) => r.state);
    expect(finishedStates).toEqual(['complete', 'blocked', 'complete', 'blocked']);
  });

  it('all blocked → completed is zero (cannot manufacture a success)', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne } = scriptedRunOne([rejectedBlocked]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b'], contract: contract({ maxConsecutiveBlocked: 100 }) },
      { bus, loopStore: store, runOne },
    );
    expect(result.completed).toBe(0);
  });
});

describe('runLoop — resume', () => {
  it('creates fresh goal ids with filesystem-safe timestamps', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();

    await runLoop(
      { id: 'L', objectives: ['a'], contract: contract() },
      {
        bus,
        loopStore: store,
        runOne: async () => verified,
        stamp: () => '2026-07-02T11:52:46.399Z',
      },
    );

    const started = records.find((record) => record.t === 'goal-started');
    expect(started?.goalId).toBe('L-g0-2026-07-02T11-52-46-399Z');
  });

  it('never re-runs a finished goal and continues the unfinished tail', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne, seen } = scriptedRunOne([verified]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd', 'e'], contract: contract() },
      { bus, loopStore: store, runOne, finished: new Set([0, 1]) }, // 0,1 already done
    );
    expect(seen).toEqual(['c', 'd', 'e']); // only the unfinished tail
    expect(result.started).toBe(3);
    expect(result.goalsFinished).toBe(5); // 2 seeded + 3 this run
  });

  it('reuses an in-flight goalId on resume and tells runOne it is resuming', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();
    const calls: Array<{ objective: string; goalId: string; resumed: boolean; index: number }> = [];
    const runOne = async (objective: string, goalId: string, attempt: { index: number; resumed: boolean }): Promise<GoalRunSummary> => {
      calls.push({ objective, goalId, resumed: attempt.resumed, index: attempt.index });
      return verified;
    };

    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract() },
      { bus, loopStore: store, runOne, finished: new Set([0]), inFlight: new Map([[1, 'L-g1-existing']]) },
    );

    expect(calls[0]).toEqual({ objective: 'b', goalId: 'L-g1-existing', resumed: true, index: 1 });
    expect(calls[1]).toMatchObject({ objective: 'c', resumed: false, index: 2 });
    expect(records.filter((r) => r.t === 'goal-started').map((r) => r.goalId)).toEqual(['L-g1-existing', calls[1].goalId]);
    expect(result.goalsFinished).toBe(3);
  });

  it('cumulative seeds cannot be reset by resume — maxGoals counts seeded + this run', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne, seen } = scriptedRunOne([verified]);
    // maxGoals=3, two already finished → only ONE more may run before the cumulative ceiling trips.
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd', 'e'], contract: contract({ maxGoals: 3 }) },
      { bus, loopStore: store, runOne, finished: new Set([0, 1]) },
    );
    expect(result.reason).toBe('max-goals');
    expect(seen).toEqual(['c']); // one more, then the cumulative cap stops it
    expect(result.goalsFinished).toBe(3);
  });

  it('re-asserts the consecutive-blocked checkpoint on resume, running NO goal past it (crash-at-halt safety)', async () => {
    // Simulates a crash AFTER the breaker tripped but BEFORE loop-halted flushed: the seed carries
    // consecutiveBlocked at the ceiling. The loop must halt before running any goal, else a completing
    // goal would reset the breaker and sail past the human checkpoint (the F1 fix).
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();
    const { runOne, seen } = scriptedRunOne([verified]); // would complete (and reset) if it ran
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd', 'e'], contract: contract({ maxConsecutiveBlocked: 3 }) },
      { bus, loopStore: store, runOne, finished: new Set([0, 1, 2]), consecutiveBlocked: 3 },
    );
    expect(result.reason).toBe('consecutive-blocked');
    expect(result.started).toBe(0); // halted before any goal ran
    expect(seen).toEqual([]);
    expect(records.at(-1)).toMatchObject({ t: 'loop-halted', reason: 'consecutive-blocked' });
  });

  it('re-asserts the verifier-health checkpoint on resume when the re-warmed cnv window is at threshold', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne, seen } = scriptedRunOne([verified]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
      { bus, loopStore: store, runOne, finished: new Set([0, 1, 2]), outcomes: ['couldNotVerify', 'couldNotVerify', 'couldNotVerify'] },
    );
    expect(result.reason).toBe('verifier-health');
    expect(result.started).toBe(0);
    expect(seen).toEqual([]);
  });

  it('does not re-assert verifier-health on resume when keyed cnv samples do not share a thresholded verifier', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne, seen } = scriptedRunOne([verified]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
      {
        bus,
        loopStore: store,
        runOne,
        finished: new Set([0, 1, 2]),
        outcomes: [
          { outcome: 'couldNotVerify', verifierKey: 'model:a' },
          { outcome: 'couldNotVerify', verifierKey: 'model:a' },
          { outcome: 'couldNotVerify', verifierKey: 'model:b' },
        ],
      },
    );
    expect(result.reason).toBe('queue-empty');
    expect(seen).toEqual(['d']);
  });

  it('halts before running on resume when one verifier key is already unhealthy', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    const { runOne, seen } = scriptedRunOne([verified]);
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
      {
        bus,
        loopStore: store,
        runOne,
        finished: new Set([0, 1, 2]),
        outcomes: [
          { outcome: 'couldNotVerify', verifierKey: 'model:a' },
          { outcome: 'couldNotVerify', verifierKey: 'model:a' },
          { outcome: 'couldNotVerify', verifierKey: 'model:a' },
        ],
      },
    );
    expect(result.reason).toBe('verifier-health');
    expect(result.started).toBe(0);
    expect(seen).toEqual([]);
  });

  it('cumulative tokens seed carries so the token ceiling spans restarts', async () => {
    const bus = new InMemoryEventBus();
    const { store } = fakeStore();
    // seed already at 90; cap 100; first goal runs (90 < 100) and emits 20 → cumulative 110 ≥ 100 → stop.
    const runOneTok = async (): Promise<GoalRunSummary> => {
      bus.emit({ type: 'usage', inputTokens: 20, outputTokens: 0 });
      return verified;
    };
    const result = await runLoop(
      { id: 'L', objectives: ['a', 'b', 'c'], contract: contract({ maxTotalTokens: 100 }) },
      { bus, loopStore: store, runOne: runOneTok, cumulativeTokens: 90 },
    );
    expect(result.reason).toBe('token-budget');
    expect(result.started).toBe(1); // 90 seed < 100 so one runs (→110), then the cap trips
  });

  it('records a resumed goal summary token total instead of only current bus usage', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();
    const runOne = async (): Promise<GoalRunSummary> => {
      bus.emit({ type: 'usage', inputTokens: 5, outputTokens: 5 });
      return { state: 'complete', outcome: 'verified', rounds: 2, tokens: 910 };
    };

    const result = await runLoop(
      { id: 'L', objectives: ['a'], contract: contract({ maxTotalTokens: 1_000 }) },
      { bus, loopStore: store, runOne, inFlight: new Map([[0, 'L-g0-existing']]) },
    );

    const finished = records.find((r): r is Extract<LoopRecord, { t: 'goal-finished' }> => r.t === 'goal-finished');
    expect(finished?.tokens).toBe(910);
    expect(result.cumulativeTokens).toBe(910);
  });
});

describe('runLoop — production composition (runOne = the REAL runGoal)', () => {
  // Proves the production seam: runOne wraps the UNCHANGED runGoal (with runGoal's own run/check seams
  // faked, exactly as goal-loop.test.ts does), and the GoalRunResult → GoalRunSummary adaptation flows
  // through runLoop. With clean legs and no verifier, decideVerdict returns verified (batch-1 path).
  function dummyProvider(): ModelProvider {
    const p: ModelProvider = {
      capability: { maxContextTokens: 1000, maxOutputTokens: 100, thinking: false, toolUse: true, imageIn: false, videoIn: false },
      async *call(): AsyncGenerator<ModelDelta, ModelResult> {
        yield* [];
        return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'completed', rawFinishReason: 'stop' };
      },
      withThinking: () => p,
      withMaxCompletionTokens: () => p,
    };
    return p;
  }
  const claimingComplete: NonNullable<GoalRunDeps['run']> = async (ctx) => {
    await ctx.tools.run({ id: 'u1', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) }, ctx.toolCtx);
    return { finalText: 'claimed', turns: 1 };
  };
  const passingCheck: NonNullable<GoalRunDeps['check']> = async () => ({
    objectiveChecksPassed: true,
    results: [],
    testTamper: 'clean',
    tamperReason: '',
  });

  it('drives a goal to complete through runGoal and runLoop reports completed=1', async () => {
    const bus = new InMemoryEventBus();
    const { store, records } = fakeStore();
    const runOne = async (objective: string, goalId: string): Promise<GoalRunSummary> => {
      const r = await runGoal(
        { id: goalId, objective, sessionId: goalId, budget: { maxRounds: 3 } },
        {
          model: dummyProvider(),
          tools: new InMemoryToolRegistry(), // a FRESH registry per goal — register() throws on a dup
          bus,
          cwd: process.cwd(),
          shellPath: 'bash',
          builderSystemPrompt: 'x',
          perRoundMaxTurns: 4,
          run: claimingComplete,
          check: passingCheck,
        },
      );
      return { state: r.state, outcome: r.finalVerdict?.outcome, rounds: r.rounds };
    };

    const result = await runLoop({ id: 'L', objectives: ['ship it'], contract: contract() }, { bus, loopStore: store, runOne });
    expect(result.completed).toBe(1);
    expect(result.reason).toBe('queue-empty');
    expect(records.find((r) => r.t === 'goal-finished')).toMatchObject({ state: 'complete', outcome: 'verified' });
  });
});
