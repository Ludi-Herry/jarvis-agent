import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VerifierCircuitBreaker,
  runGoal,
  type GoalRunDeps,
  type GoalSpec,
} from '../../../src/capabilities/goal/goal-loop.js';
import {
  FileGoalStore,
  assertObjectiveUnchanged,
  hashObjective,
  parseGoalLog,
  type GoalRoundRecord,
} from '../../../src/capabilities/goal/goal-store.js';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { InMemoryEventBus, type Event } from '../../../src/runtime/event-bus.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import type { RunOutcome } from '../../../src/core/loop/run-agent.js';
import type { PinnedRequirement, VerifierReport } from '../../../src/capabilities/goal/goal.js';
import { createUpdateGoalTool, updateGoalToolSchema } from '../../../src/capabilities/goal/update-goal-tool.js';

it('hashes the exact runtime update_goal schema for session composition', () => {
  const registry = new InMemoryToolRegistry();
  registry.register(createUpdateGoalTool({}));
  expect(updateGoalToolSchema()).toEqual(registry.schemasForModel()[0]);
});

function dummyProvider(): ModelProvider {
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield* []; // never iterated — the fake run replaces the loop
      return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'completed', rawFinishReason: 'stop' };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

/** A fake builder run that claims `status` by actually calling the registered update_goal tool
 *  (so the GoalLoop's claim slot is set the real way), then returns a clean final turn. */
function claimingRun(status: 'complete' | 'blocked'): { run: NonNullable<GoalRunDeps['run']>; calls: () => number } {
  let calls = 0;
  const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
    calls++;
    await ctx.tools.run(
      { id: `u${calls}`, name: 'update_goal', arguments: JSON.stringify({ status }) },
      ctx.toolCtx,
    );
    return { finalText: 'claimed', turns: 1 };
  };
  return { run, calls: () => calls };
}

const passingCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
  heldOut: { passed: true, results: [] },
});
const routineProjectCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
});
const failingCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: false,
  results: [{ command: 'npm test', code: 1, output: 'FAIL: 1 test failed' }],
  testTamper: 'clean',
  tamperReason: '',
});
const tamperCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'weakened-or-deleted',
  tamperReason: 'test file deleted: test/x.test.ts',
});
const dirtyWorktreeCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
  worktreeStatus: {
    command: 'git status --porcelain --untracked-files=all',
    policy: 'forbid',
    baseline: '',
    current: '?? docs/new.md',
    changed: true,
    changedEntries: ['?? docs/new.md'],
  },
});

function record(bus: InMemoryEventBus): Event[] {
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

function spec(over: Partial<GoalSpec> = {}): GoalSpec {
  return { id: 'g1', objective: 'do the thing', sessionId: 's1', budget: { maxRounds: 5 }, ...over };
}

function baseDeps(over: Partial<GoalRunDeps> = {}): GoalRunDeps {
  return {
    model: dummyProvider(),
    tools: new InMemoryToolRegistry(),
    bus: new InMemoryEventBus(),
    cwd: process.cwd(),
    shellPath: 'bash',
    builderSystemPrompt: 'you are a builder',
    perRoundMaxTurns: 5,
    ...over,
  };
}

describe('runGoal — verification gates completion', () => {
  it('completes only when a completion claim is backed by trusted held-out evidence', async () => {
    const { run, calls } = claimingRun('complete');
    const result = await runGoal(spec(), baseDeps({ run, check: passingCheck }));
    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
    expect(calls()).toBe(1); // verified on the first round
  });

  it('a completion claim does NOT complete when leg 1 fails (builder self-report ignored)', async () => {
    const { run } = claimingRun('complete');
    const result = await runGoal(spec({ budget: { maxRounds: 10 } }), baseDeps({ run, check: failingCheck }));
    expect(result.state).not.toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('rejected');
  });

  it('a completion claim does NOT complete when tests were tampered (leg 2)', async () => {
    const { run } = claimingRun('complete');
    const result = await runGoal(spec({ budget: { maxRounds: 10 } }), baseDeps({ run, check: tamperCheck }));
    expect(result.state).not.toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('rejected');
  });

  it('a completion claim does NOT complete when the no-change worktree baseline is violated, and records the status diff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-goal-worktree-status-'));
    const path = join(dir, 'goal.jsonl');
    try {
      const { run } = claimingRun('complete');
      const result = await runGoal(
        spec({ budget: { maxRounds: 10 } }),
        baseDeps({ run, check: dirtyWorktreeCheck, goalStore: new FileGoalStore(path) }),
      );

      expect(result.state).not.toBe('complete');
      expect(result.finalVerdict?.outcome).toBe('rejected');
      expect(result.finalVerdict?.rationale).toContain('worktree changed');

      const rounds = parseGoalLog(await readFile(path, 'utf8')).filter((record) => record.t === 'goal-round');
      expect(rounds[0].checks?.worktreeStatus?.changedEntries).toEqual(['?? docs/new.md']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a blocked claim hands the goal to a human without verifying', async () => {
    const { run, calls } = claimingRun('blocked');
    const result = await runGoal(spec(), baseDeps({ run, check: passingCheck }));
    expect(result.state).toBe('blocked');
    expect(calls()).toBe(1);
  });

  it('runs out of rounds without a completion claim → blocked (budget exhaustion, fail-closed)', async () => {
    let calls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async () => {
      calls++;
      return { finalText: 'still working', turns: 1 }; // never calls update_goal → no claim
    };
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const result = await runGoal(spec({ budget: { maxRounds: 3 } }), baseDeps({ bus, run, check: passingCheck }));
    expect(result.state).toBe('blocked');
    expect(calls).toBe(3); // nudged each round, never claimed → exhausted the 3-round budget
    expect(events.some((e) => e.type === 'halt' && e.reason === 'budget')).toBe(true);
    expect(events.filter((e) => e.type === 'goal_round_end').at(-1)).toMatchObject({
      type: 'goal_round_end',
      round: 3,
      state: 'blocked',
    });
  });

  it('emits read-only round budget events around a builder round', async () => {
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
      ctx.bus.emit({ type: 'usage', inputTokens: 3, outputTokens: 4 });
      await ctx.tools.run(
        { id: 'u1', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) },
        ctx.toolCtx,
      );
      return { finalText: 'claimed', turns: 2 };
    };

    const result = await runGoal(
      spec({ budget: { maxRounds: 2, maxTotalTurns: 10, maxTotalTokens: 20 } }),
      baseDeps({ bus, run, check: passingCheck }),
    );

    expect(result.state).toBe('complete');
    const roundEvents = events.filter((event) => ['goal_round_start', 'goal_round_end'].includes(event.type));
    expect(roundEvents).toEqual([
      {
        type: 'goal_round_start',
        goalId: 'g1',
        round: 1,
        maxRounds: 2,
        totalTurns: 0,
        maxTotalTurns: 10,
        totalTokens: 0,
        maxTotalTokens: 20,
      },
      {
        type: 'goal_round_end',
        goalId: 'g1',
        round: 1,
        turns: 2,
        roundTokens: 7,
        totalTurns: 2,
        maxTotalTurns: 10,
        totalTokens: 7,
        maxTotalTokens: 20,
        maxRounds: 2,
        claimStatus: 'complete',
        verdict: 'verified',
        state: 'complete',
      },
    ]);
  });

  it('emits blocked round end when the last round rejects a completion claim', async () => {
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const { run } = claimingRun('complete');

    const result = await runGoal(spec({ budget: { maxRounds: 1 } }), baseDeps({ bus, run, check: failingCheck }));

    expect(result.state).toBe('blocked');
    expect(events.filter((e) => e.type === 'goal_round_end').at(-1)).toMatchObject({
      type: 'goal_round_end',
      round: 1,
      verdict: 'rejected',
      state: 'blocked',
    });
  });
});

describe('runGoal — circuit breaker is really wired (Part7 P0-2)', () => {
  it('halts to blocked after 3 consecutive rejects, before maxRounds', async () => {
    const { run, calls } = claimingRun('complete');
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const result = await runGoal(
      spec({ budget: { maxRounds: 10 } }), // generous round budget — the breaker should stop first
      baseDeps({ bus, run, check: failingCheck }),
    );
    expect(result.state).toBe('blocked');
    expect(calls()).toBe(3); // stopped at the breaker, not the 10-round budget
    expect(events.some((e) => e.type === 'halt' && e.reason === 'guardrail')).toBe(true);
    expect(events.some((e) => e.type === 'goal_state' && e.state === 'blocked')).toBe(true);
  });
});

describe('runGoal — shadow-git snapshot hook (best-effort, off the verdict path)', () => {
  it('snapshots once per round with a round label', async () => {
    const labels: string[] = [];
    const shadowGit = { snapshot: async (label: string) => void labels.push(label) };
    const { run } = claimingRun('complete');
    const result = await runGoal(spec(), baseDeps({ run, check: passingCheck, shadowGit }));
    expect(result.state).toBe('complete'); // hook does not disturb the verdict
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/round 1/);
  });

  it('snapshots every round, including reject→retry rounds', async () => {
    const labels: string[] = [];
    const shadowGit = { snapshot: async (label: string) => void labels.push(label) };
    const { run } = claimingRun('complete');
    await runGoal(spec({ budget: { maxRounds: 2 } }), baseDeps({ run, check: failingCheck, shadowGit }));
    expect(labels).toHaveLength(2); // one per round, regardless of reject
  });

  it('a throwing snapshot NEVER breaks the goal (best-effort observability)', async () => {
    const shadowGit = {
      snapshot: async () => {
        throw new Error('git exploded');
      },
    };
    const { run } = claimingRun('complete');
    const result = await runGoal(spec(), baseDeps({ run, check: passingCheck, shadowGit }));
    expect(result.state).toBe('complete'); // verdict unaffected by the snapshot failure
  });

  it('waits only for snapshot capture before starting the next round, then drains commits before returning', async () => {
    let releaseFirstCommit!: () => void;
    const firstCommit = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    const labels: string[] = [];
    const shadowGit = {
      snapshot: async () => {
        throw new Error('fallback snapshot should not be used when snapshotAsync is available');
      },
      snapshotAsync: (label: string) => {
        labels.push(label);
        return labels.length === 1
          ? { captured: Promise.resolve(), done: firstCommit }
          : { captured: Promise.resolve(), done: Promise.resolve() };
      },
    };
    const { run, calls } = claimingRun('complete');
    let settled = false;
    const goal = runGoal(spec({ budget: { maxRounds: 2 } }), baseDeps({ run, check: failingCheck, shadowGit }));
    goal.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      for (let i = 0; i < 50 && calls() < 2; i++) await Promise.resolve();
      expect(calls()).toBe(2); // round 2 started after capture, before the round-1 commit finished
      expect(labels).toHaveLength(1); // the round-2 capture waits until round-1 commit owns the index
      expect(settled).toBe(false); // but the run still waits for queued commits before returning
    } finally {
      releaseFirstCommit();
      await goal.catch(() => undefined);
    }
    expect(labels).toHaveLength(2);
  });

  it('drains queued snapshot commits before recording a terminal goal state', async () => {
    let releaseCommit!: () => void;
    const events: string[] = [];
    const commit = new Promise<void>((resolve) => {
      releaseCommit = () => {
        events.push('snapshot-done');
        resolve();
      };
    });
    const shadowGit = {
      snapshot: async () => {
        throw new Error('fallback snapshot should not be used when snapshotAsync is available');
      },
      snapshotAsync: () => ({ captured: Promise.resolve(), done: commit }),
    };
    const goalStore = {
      writeCreated: async () => undefined,
      recordRound: async () => undefined,
      recordState: async () => {
        events.push('state-recorded');
      },
    } as unknown as FileGoalStore;
    const { run } = claimingRun('complete');
    const goal = runGoal(spec(), baseDeps({ run, check: passingCheck, shadowGit, goalStore }));

    try {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(events).toEqual([]); // terminal state is not durable until shadow commits drain
    } finally {
      releaseCommit();
      await goal.catch(() => undefined);
    }
    expect(events).toEqual(['snapshot-done', 'state-recorded']);
  });
});

describe('VerifierCircuitBreaker', () => {
  it('trips (halt) on the 3rd consecutive reject and latches once', () => {
    const b = new VerifierCircuitBreaker();
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('halt');
    expect(b.recordReject()).toBe('continue'); // latched — never halts twice
  });

  it('counts to halt and latches — no reset path (a non-reject ends the loop, so the count is consecutive)', () => {
    const b = new VerifierCircuitBreaker();
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('halt');
    expect(b.recordReject()).toBe('continue'); // latched — never halts twice
  });
});

describe('runGoal — resume', () => {
  it('resumes an active goal from prior messages and continues at the next round without rewriting goal-created', async () => {
    const writes: string[] = [];
    const goalStore = {
      writeCreated: async () => void writes.push('created'),
      recordRound: async () => void writes.push('round'),
      recordState: async () => void writes.push('state'),
    } as unknown as FileGoalStore;
    const seenMessageCounts: number[] = [];
    const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
      seenMessageCounts.push(ctx.messages.length);
      await ctx.tools.run({ id: 'u', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) }, ctx.toolCtx);
      return { finalText: 'claimed', turns: 1 };
    };
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };
    const priorMessages = [
      { role: 'system' as const, content: 'you are a builder' },
      { role: 'user' as const, content: 'do the thing' },
      { role: 'assistant' as const, content: 'worked before crash' },
    ];

    const result = await runGoal(
      { ...spec({ budget: { maxRounds: 3 } }), resume: { goal: priorGoal, rounds: [], messages: priorMessages } },
      baseDeps({ run, check: passingCheck, goalStore }),
    );

    expect(result.state).toBe('complete');
    expect(result.rounds).toBe(1);
    expect(seenMessageCounts[0]).toBe(3);
    expect(writes).toEqual(['round', 'state']);
  });

  it('records no-claim rounds so resume can preserve the round budget', async () => {
    const rounds: Array<{ round: number; claim?: unknown; turns?: number }> = [];
    const goalStore = {
      writeCreated: async () => undefined,
      recordRound: async (record: { round: number; claim?: unknown; turns?: number }) => void rounds.push(record),
      recordState: async () => undefined,
    } as unknown as FileGoalStore;
    let calls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
      calls++;
      if (calls === 2) {
        await ctx.tools.run({ id: 'u', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) }, ctx.toolCtx);
      }
      return { finalText: 'round done', turns: 1 };
    };

    const result = await runGoal(spec({ budget: { maxRounds: 2 } }), baseDeps({ run, check: passingCheck, goalStore }));

    expect(result.state).toBe('complete');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ round: 1, turns: 1 });
    expect(rounds[0].claim).toBeUndefined();
    expect(rounds[1].claim).toEqual({ status: 'complete' });
  });

  it('restores prior turn budget from replayed rounds before running more builder work', async () => {
    let calls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async () => {
      calls++;
      return { finalText: 'still working', turns: 1 };
    };
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 5, maxTotalTurns: 5 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };
    const priorRounds = [{ t: 'goal-round' as const, round: 1, turns: 4, at: 't1' }];

    const result = await runGoal(
      {
        ...spec({ budget: { maxRounds: 5, maxTotalTurns: 5 } }),
        resume: { goal: priorGoal, rounds: priorRounds, messages: [] },
      },
      baseDeps({ run, check: passingCheck }),
    );

    expect(result.state).toBe('blocked');
    expect(result.rounds).toBe(2);
    expect(calls).toBe(1);
  });

  it('restores the reject breaker on resume so prior rejected rounds still count', async () => {
    const { run, calls } = claimingRun('complete');
    const rejectedRound = (round: number): GoalRoundRecord => ({
      t: 'goal-round',
      round,
      claim: { status: 'complete' },
      checks: {
        objectiveChecksPassed: false,
        results: [{ command: 'npm test', code: 1, output: 'fail' }],
        testTamper: 'clean',
        tamperReason: '',
      },
      verdict: { outcome: 'rejected', rationale: 'failed' },
      at: `t${round}`,
    });
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 5 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    const result = await runGoal(
      { ...spec({ budget: { maxRounds: 5 } }), resume: { goal: priorGoal, rounds: [rejectedRound(1), rejectedRound(2)], messages: [] } },
      baseDeps({ run, check: failingCheck }),
    );

    expect(result.state).toBe('blocked');
    expect(calls()).toBe(1);
    expect(result.rounds).toBe(3);
  });

  it('does not let a replayed no-claim round reset the reject breaker', async () => {
    const { run, calls } = claimingRun('complete');
    const rejectedRound = (round: number): GoalRoundRecord => ({
      t: 'goal-round',
      round,
      claim: { status: 'complete' },
      checks: {
        objectiveChecksPassed: false,
        results: [{ command: 'npm test', code: 1, output: 'fail' }],
        testTamper: 'clean',
        tamperReason: '',
      },
      verdict: { outcome: 'rejected', rationale: 'failed' },
      at: `t${round}`,
    });
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 5 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    const result = await runGoal(
      {
        ...spec({ budget: { maxRounds: 5 } }),
        resume: {
          goal: priorGoal,
          rounds: [rejectedRound(1), rejectedRound(2), { t: 'goal-round', round: 3, turns: 1, at: 't3' }],
          messages: [],
        },
      },
      baseDeps({ run, check: failingCheck }),
    );

    expect(result.state).toBe('blocked');
    expect(result.rounds).toBe(4);
    expect(calls()).toBe(1);
  });

  it('re-asserts an already-tripped reject breaker on resume before running another builder round', async () => {
    const { run, calls } = claimingRun('complete');
    const rejectedRound = (round: number): GoalRoundRecord => ({
      t: 'goal-round',
      round,
      claim: { status: 'complete' },
      checks: {
        objectiveChecksPassed: false,
        results: [{ command: 'npm test', code: 1, output: 'fail' }],
        testTamper: 'clean',
        tamperReason: '',
      },
      verdict: { outcome: 'rejected', rationale: 'failed' },
      at: `t${round}`,
    });
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 5 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    const result = await runGoal(
      {
        ...spec({ budget: { maxRounds: 5 } }),
        resume: { goal: priorGoal, rounds: [rejectedRound(1), rejectedRound(2), rejectedRound(3)], messages: [] },
      },
      baseDeps({ run, check: failingCheck }),
    );

    expect(result.state).toBe('blocked');
    expect(result.rounds).toBe(3);
    expect(calls()).toBe(0);
  });

  it('fails closed when a resumed complete goal lacks a verified verdict', async () => {
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'complete' as const,
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    await expect(
      runGoal(
        { ...spec({ budget: { maxRounds: 3 } }), resume: { goal: priorGoal, rounds: [], messages: [] } },
        baseDeps({ run: claimingRun('complete').run, check: passingCheck }),
      ),
    ).rejects.toThrow(/verified verdict/);
  });

  it('fails closed when a resumed goal budget differs from the loop spec budget', async () => {
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 999 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    await expect(
      runGoal(
        { ...spec({ budget: { maxRounds: 3 } }), resume: { goal: priorGoal, rounds: [], messages: [] } },
        baseDeps({ run: claimingRun('complete').run, check: passingCheck }),
      ),
    ).rejects.toThrow(/budget/);
  });

  it('uses the spec baseline instead of trusting the resumed goal log baseline', async () => {
    let seenBaseline: unknown;
    const { run } = claimingRun('complete');
    const check: NonNullable<GoalRunDeps['check']> = async (_deps, baseline) => {
      seenBaseline = baseline;
      return {
        objectiveChecksPassed: true,
        results: [],
        testTamper: 'clean',
        tamperReason: '',
        heldOut: { passed: true, results: [] },
      };
    };
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 3 },
      testBaseline: undefined,
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };
    const trustedBaseline = { headSha: 'trusted-head', testFiles: [] };

    const result = await runGoal(
      {
        ...spec({ budget: { maxRounds: 3 }, baseline: trustedBaseline }),
        resume: { goal: priorGoal, rounds: [], messages: [] },
      },
      baseDeps({ run, check }),
    );

    expect(result.state).toBe('complete');
    expect(seenBaseline).toEqual(trustedBaseline);
  });

  it('uses spec pinned requirements instead of trusting the resumed goal log pinned list', async () => {
    const { run } = claimingRun('complete');
    let seenPinned: PinnedRequirement[] = [];
    const runVerifier: NonNullable<GoalRunDeps['runVerifier']> = async (_objective, pinned) => {
      seenPinned = pinned;
      return perfectReport();
    };
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'active' as const,
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    const result = await runGoal(
      {
        ...spec({ budget: { maxRounds: 3 }, pinned: PINNED }),
        resume: { goal: priorGoal, rounds: [], messages: [] },
      },
      baseDeps({ run, check: passingCheck, verifierProvider: dummyProvider(), runVerifier }),
    );

    expect(result.state).toBe('complete');
    expect(seenPinned).toEqual(PINNED);
  });

  it('returns a persisted terminal complete goal without rerunning the builder when resume closes a loop crash gap', async () => {
    let calls = 0;
    let checkCalls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async () => {
      calls++;
      return { finalText: 'should not run', turns: 1 };
    };
    const check: NonNullable<GoalRunDeps['check']> = async () => {
      checkCalls++;
      return {
        objectiveChecksPassed: true,
        results: [],
        testTamper: 'clean',
        tamperReason: '',
        heldOut: { passed: true, results: [] },
      };
    };
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'complete' as const,
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    const result = await runGoal(
      {
        ...spec({ budget: { maxRounds: 3 } }),
        resume: {
          goal: priorGoal,
          rounds: [{ t: 'goal-round', round: 1, claim: { status: 'complete' }, verdict: { outcome: 'verified', rationale: 'ok' }, at: 't1' }],
          messages: [],
        },
      },
      baseDeps({ run, check }),
    );

    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
    expect(calls).toBe(0);
    expect(checkCalls).toBe(1);
  });

  it('reruns verification for a resumed terminal complete goal and blocks if the worktree no longer verifies', async () => {
    let calls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async () => {
      calls++;
      return { finalText: 'should not run', turns: 1 };
    };
    const priorGoal = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      state: 'complete' as const,
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 's1',
      createdAt: 't0',
    };

    const result = await runGoal(
      {
        ...spec({ budget: { maxRounds: 3 } }),
        resume: {
          goal: priorGoal,
          rounds: [{ t: 'goal-round', round: 1, claim: { status: 'complete' }, verdict: { outcome: 'verified', rationale: 'ok' }, at: 't1' }],
          messages: [],
        },
      },
      baseDeps({ run, check: failingCheck }),
    );

    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('rejected');
    expect(calls).toBe(0);
  });
});

describe('assertObjectiveUnchanged — objective immutability (fail-closed)', () => {
  it('passes for the original objective and throws for a changed one', () => {
    const h = hashObjective('build X');
    expect(() => assertObjectiveUnchanged('build X', h)).not.toThrow();
    expect(() => assertObjectiveUnchanged('build something else', h)).toThrow(/immutability/);
  });
});

// ── Leg 3 wiring (Part7 §3.3; anti-cheat contract from the plan) ──

const PINNED: PinnedRequirement[] = [{ id: 'r1', text: 'the requirement' }];

function perfectReport(): VerifierReport {
  return {
    feature: 'works',
    expected: 'e',
    observed: 'o',
    evidence: 'ev',
    perRequirement: [{ requirementId: 'r1', strength: 'proves', scope: 'matched' }],
    couldNotVerify: [],
    rationale: 'proven',
  };
}
function brokenReport(): VerifierReport {
  return { ...perfectReport(), feature: 'broken', perRequirement: [{ requirementId: 'r1', strength: 'contradicts', scope: 'matched' }], rationale: 'feature broken', observed: 'observed it fail' };
}
function couldNotVerifyReport(): VerifierReport {
  return { feature: 'works', expected: '', observed: '', evidence: '', perRequirement: [], couldNotVerify: ['could not check locally'], rationale: 'cnv' };
}
/** A report scoring the pinned requirement as `cannotVerify` (an execution/external requirement). */
function cannotVerifyReport(): VerifierReport {
  return { feature: 'works', expected: '', observed: '', evidence: '', perRequirement: [{ requirementId: 'r1', strength: 'cannotVerify', scope: 'matched' }], couldNotVerify: ['needs a running server'], rationale: 'cnv' };
}

/** A runVerifier spy that returns a fixed report and counts how many times it was called. */
function verifierSpy(report: VerifierReport): { fn: NonNullable<GoalRunDeps['runVerifier']>; calls: () => number } {
  let calls = 0;
  const fn: NonNullable<GoalRunDeps['runVerifier']> = async () => {
    calls++;
    return report;
  };
  return { fn, calls: () => calls };
}

describe('runGoal — leg 3 (independent judge) wiring', () => {
  it('spawns the verifier after the deterministic legs pass, and verifies on a clean report', async () => {
    const { run } = claimingRun('complete');
    const spy = verifierSpy(perfectReport());
    const result = await runGoal(
      spec({ pinned: PINNED }),
      baseDeps({ run, check: passingCheck, verifierProvider: dummyProvider(), runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(1); // objective passed → judge spawned
    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
  });

  it('short-circuits without spawning the judge when leg 1 fails (no injection surface, no wasted spend)', async () => {
    const { run } = claimingRun('complete');
    // Even a PERFECT (injected) report can't matter — the judge is never called, leg 1 rejects.
    const spy = verifierSpy(perfectReport());
    const result = await runGoal(
      spec({ pinned: PINNED, budget: { maxRounds: 1 } }),
      baseDeps({ run, check: failingCheck, verifierProvider: dummyProvider(), runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(0); // leg 1 failed → judge never spawned
    expect(result.finalVerdict?.outcome).toBe('rejected');
  });

  it('short-circuits without spawning the judge when forbidden worktree status changed', async () => {
    const { run } = claimingRun('complete');
    const spy = verifierSpy(perfectReport());
    const result = await runGoal(
      spec({ pinned: PINNED, budget: { maxRounds: 1 } }),
      baseDeps({ run, check: dirtyWorktreeCheck, verifierProvider: dummyProvider(), runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(result.finalVerdict?.outcome).toBe('rejected');
  });

  it('NEVER falls through to verified when the verifier fails (couldNotVerify → blocked, not complete)', async () => {
    const { run } = claimingRun('complete');
    // runVerifier always returns SOME report; a failure synthesizes couldNotVerify. With clean legs the
    // report must still gate completion — it must not slip into the report===undefined → verified path.
    const spy = verifierSpy(couldNotVerifyReport());
    const result = await runGoal(
      spec({ pinned: PINNED }),
      baseDeps({ run, check: passingCheck, verifierProvider: dummyProvider(), runVerifier: spy.fn }),
    );
    expect(result.state).not.toBe('complete');
    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('couldNotVerify');
  });

  it('a leg-3 reject keeps the loop going and the breaker really halts after 3 (judge-driven rejects)', async () => {
    const { run, calls } = claimingRun('complete');
    const spy = verifierSpy(brokenReport());
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const result = await runGoal(
      spec({ pinned: PINNED, budget: { maxRounds: 10 } }),
      baseDeps({ bus, run, check: passingCheck, verifierProvider: dummyProvider(), runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(3); // judged broken three times
    expect(calls()).toBe(3);
    expect(result.state).toBe('blocked');
    expect(events.some((e) => e.type === 'halt' && e.reason === 'guardrail')).toBe(true);
  });

  it('fails closed if a (mis-typed) injected verifier returns undefined while leg 3 is enabled (no false verified)', async () => {
    const { run } = claimingRun('complete');
    // A contract-violating runVerifier that returns undefined despite its non-optional type. With clean
    // legs + a verifier provider, the boundary backstop must synthesize couldNotVerify rather than let
    // decideVerdict take the report===undefined → verified path.
    const badVerifier = (async () => undefined) as unknown as NonNullable<GoalRunDeps['runVerifier']>;
    const result = await runGoal(
      spec({ pinned: PINNED }),
      baseDeps({ run, check: passingCheck, verifierProvider: dummyProvider(), runVerifier: badVerifier }),
    );
    expect(result.state).not.toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('couldNotVerify');
  });

  it('without trusted objective evidence routine project checks stay checksOnly', async () => {
    const { run } = claimingRun('complete');
    const spy = verifierSpy(perfectReport());
    const result = await runGoal(
      spec({ pinned: PINNED }), // pinned present but no verifierProvider → leg 3 stays off
      baseDeps({ run, check: routineProjectCheck, runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(0); // no provider → judge never runs
    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('checksOnly');
  });
});

// ── Held-out leg (secret hidden assertions; checklist #1) ──

/** A check where leg 1 passes (builder's own weak tests are green) but the SECRET held-out leg fails. */
const heldOutFailCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
  heldOut: { passed: false, results: [{ command: 'node hidden-assert.js', code: 1, output: 'HIDDEN-SECRET-OUTPUT' }] },
});

describe('runGoal — held-out leg gates completion', () => {
  it('rejects when held-out fails even though leg 1 is green (faked feature + self-written weak tests)', async () => {
    const { run } = claimingRun('complete');
    const result = await runGoal(
      spec({ budget: { maxRounds: 1 } }),
      baseDeps({ run, check: heldOutFailCheck }),
    );
    expect(result.state).not.toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('rejected');
  });

  it('the held-out rejection continuation NEVER reveals the secret command or its output', async () => {
    let seenUserText = '';
    const captureRun: NonNullable<GoalRunDeps['run']> = async (ctx) => {
      seenUserText = ctx.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      await ctx.tools.run(
        { id: 'u', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) },
        ctx.toolCtx,
      );
      return { finalText: 'claimed', turns: 1 };
    };
    await runGoal(spec({ budget: { maxRounds: 2 } }), baseDeps({ run: captureRun, check: heldOutFailCheck }));
    // round 2's messages include round 1's continuation — it must carry a generic note, not the secret.
    expect(seenUserText).toContain('隐藏'); // a generic held-out note IS present
    expect(seenUserText).not.toContain('hidden-assert'); // the command is NOT revealed
    expect(seenUserText).not.toContain('HIDDEN-SECRET-OUTPUT'); // nor its output
  });

  it('a held-out failure short-circuits leg 3 (the judge is never spawned)', async () => {
    const { run } = claimingRun('complete');
    const spy = verifierSpy(perfectReport());
    const result = await runGoal(
      spec({ pinned: PINNED, budget: { maxRounds: 1 } }),
      baseDeps({ run, check: heldOutFailCheck, verifierProvider: dummyProvider(), runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(0); // held-out failed → judge never spawned (no wasted spend / injection surface)
    expect(result.finalVerdict?.outcome).toBe('rejected');
  });

  it('a leg-3 cannotVerify report parks to blocked, not a reject loop (execution-requirement integration)', async () => {
    const { run } = claimingRun('complete');
    const spy = verifierSpy(cannotVerifyReport());
    const result = await runGoal(
      spec({ pinned: PINNED }),
      baseDeps({ run, check: passingCheck, verifierProvider: dummyProvider(), runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(1);
    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('couldNotVerify');
  });

  it('held-out passing lets a clean goal verify (the leg is satisfied)', async () => {
    const heldOutPassCheck: NonNullable<GoalRunDeps['check']> = async () => ({
      objectiveChecksPassed: true,
      results: [],
      testTamper: 'clean',
      tamperReason: '',
      heldOut: { passed: true, results: [] },
    });
    const { run } = claimingRun('complete');
    const result = await runGoal(spec(), baseDeps({ run, check: heldOutPassCheck }));
    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
  });

  it('the persisted goalStore record NEVER contains the held-out secret command/output (it lives under cwd, builder-readable)', async () => {
    // Two independent reviewers converged: goalStore is data/goals/*.jsonl UNDER cwd, which the builder
    // can read/grep/bash — so persisting heldOut.results would leak the hidden assertions back. Only
    // pass/fail must survive to disk.
    const dir = await mkdtemp(join(tmpdir(), 'goal-heldout-'));
    const storePath = join(dir, 'goal.jsonl');
    const { run } = claimingRun('complete');
    await runGoal(
      spec({ budget: { maxRounds: 1 } }),
      baseDeps({ run, check: heldOutFailCheck, goalStore: new FileGoalStore(storePath) }),
    );
    const persisted = await readFile(storePath, 'utf8');
    await rm(dir, { recursive: true, force: true });
    expect(persisted).not.toContain('hidden-assert'); // the secret command is not on disk
    expect(persisted).not.toContain('HIDDEN-SECRET-OUTPUT'); // nor its output
    expect(persisted).toContain('"passed":false'); // but the pass/fail WAS recorded (audit intact)
  });
});

describe('runGoal — liveness deadlines and abnormal builder halts', () => {
  it('keeps goalTimeout as the single terminal truth when the real agent receives a late tool call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goal-timeout-agent-'));
    const path = join(dir, 'goal.jsonl');
    let release!: () => void;
    const provider: ModelProvider = {
      ...dummyProvider(),
      async *call(): AsyncGenerator<ModelDelta, ModelResult> {
        yield* [];
        await new Promise<void>((resolve) => {
          release = resolve;
        }); // deliberately ignores AbortSignal
        return {
          text: '',
          toolCalls: [{ id: 'late', name: 'update_goal', arguments: '{"status":"complete"}' }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'tool_calls',
          rawFinishReason: 'tool_calls',
        };
      },
    };
    provider.withThinking = () => provider;
    provider.withMaxCompletionTokens = () => provider;
    const bus = new InMemoryEventBus();
    const events = record(bus);

    try {
      const result = await runGoal(
        spec({ budget: { maxRounds: 5, maxWallClockMs: 50 } }),
        baseDeps({ model: provider, bus, check: passingCheck, goalStore: new FileGoalStore(path) }),
      );
      expect(result).toMatchObject({ state: 'blocked', haltReason: 'goalTimeout' });
      const beforeLateResult = await readFile(path, 'utf8');

      release();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) => event.type === 'final' || event.type === 'tool_call' || event.type === 'tool_result')).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(beforeLateResult);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks on the whole-goal deadline even when an injected builder ignores AbortSignal, and a late result cannot rewrite the log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goal-timeout-'));
    const path = join(dir, 'goal.jsonl');
    let providerSignal: AbortSignal | undefined;
    let resolveLate!: (outcome: RunOutcome) => void;
    let calls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
      calls++;
      providerSignal = ctx.signal;
      return new Promise<RunOutcome>((resolve) => {
        resolveLate = resolve;
      }); // deliberately ignores ctx.signal
    };
    const bus = new InMemoryEventBus();
    const events = record(bus);

    try {
      const result = await runGoal(
        spec({ budget: { maxRounds: 5, maxWallClockMs: 50 } }),
        baseDeps({ bus, run, check: passingCheck, goalStore: new FileGoalStore(path) }),
      );

      expect(calls).toBe(1);
      expect(providerSignal?.aborted).toBe(true);
      expect(result).toMatchObject({
        state: 'blocked',
        haltReason: 'goalTimeout',
        timeoutMs: 50,
        finalVerdict: { outcome: 'couldNotVerify' },
      });
      expect(events).toContainEqual({ type: 'halt', reason: 'goalTimeout', timeoutMs: 50 });

      const beforeLateResult = await readFile(path, 'utf8');
      const rounds = parseGoalLog(beforeLateResult).filter((entry) => entry.t === 'goal-round');
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({
        haltReason: 'goalTimeout',
        timeoutMs: 50,
        verdict: { outcome: 'couldNotVerify' },
      });

      resolveLate({ finalText: 'late completion must be ignored', turns: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await readFile(path, 'utf8')).toBe(beforeLateResult);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks immediately when runAgent reports a turn timeout instead of launching another round', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goal-turn-timeout-'));
    const path = join(dir, 'goal.jsonl');
    let calls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async () => {
      calls++;
      return { halted: 'turnTimeout', turns: 1, timeoutMs: 17 };
    };

    try {
      const result = await runGoal(
        spec({ budget: { maxRounds: 5 } }),
        baseDeps({ run, check: passingCheck, goalStore: new FileGoalStore(path) }),
      );

      expect(calls).toBe(1);
      expect(result).toMatchObject({
        state: 'blocked',
        haltReason: 'turnTimeout',
        timeoutMs: 17,
        finalVerdict: { outcome: 'couldNotVerify' },
      });
      const rounds = parseGoalLog(await readFile(path, 'utf8')).filter((entry) => entry.t === 'goal-round');
      expect(rounds[0]).toMatchObject({ haltReason: 'turnTimeout', timeoutMs: 17 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['paused', 'refused', 'unknown'] as const)(
    'parks a %s builder finish after one round and persists the provider reason',
    async (halted) => {
      const dir = await mkdtemp(join(tmpdir(), `goal-${halted}-`));
      const path = join(dir, 'goal.jsonl');
      let calls = 0;
      const run: NonNullable<GoalRunDeps['run']> = async () => {
        calls++;
        return { halted, turns: 1, rawFinishReason: 'provider-raw' };
      };

      try {
        const result = await runGoal(
          spec({ budget: { maxRounds: 5 } }),
          baseDeps({ run, check: passingCheck, goalStore: new FileGoalStore(path) }),
        );

        expect(calls).toBe(1);
        expect(result).toMatchObject({ state: 'blocked', haltReason: halted, rawFinishReason: 'provider-raw' });
        const rounds = parseGoalLog(await readFile(path, 'utf8')).filter((entry) => entry.t === 'goal-round');
        expect(rounds[0]).toMatchObject({ haltReason: halted, rawFinishReason: 'provider-raw' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('blocks an unknown tool execution before clean checks can authorize completion', async () => {
    let checks = 0;
    const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
      await ctx.tools.run({
        id: 'claim',
        name: 'update_goal',
        arguments: JSON.stringify({ status: 'complete', verification: 'self report' }),
      }, ctx.toolCtx);
      return { halted: 'toolExecutionUnknown', turns: 1 };
    };
    const check: NonNullable<GoalRunDeps['check']> = async (deps, baseline) => {
      checks++;
      return passingCheck(deps, baseline);
    };

    const result = await runGoal(spec({ budget: { maxRounds: 3 } }), baseDeps({ run, check }));

    expect(checks).toBe(0);
    expect(result).toMatchObject({
      state: 'blocked',
      haltReason: 'toolExecutionUnknown',
      finalVerdict: { outcome: 'couldNotVerify' },
    });
  });

  it('applies the whole-goal deadline to verification checks after a completion claim', async () => {
    let checkSignal: AbortSignal | undefined;
    const neverSettlingCheck: NonNullable<GoalRunDeps['check']> = async (deps) => {
      checkSignal = deps.signal;
      return new Promise<never>(() => undefined);
    };
    const { run } = claimingRun('complete');

    const result = await runGoal(
      spec({ budget: { maxRounds: 5, maxWallClockMs: 50 } }),
      baseDeps({ run, check: neverSettlingCheck }),
    );

    expect(checkSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      state: 'blocked',
      haltReason: 'goalTimeout',
      timeoutMs: 50,
      finalVerdict: { outcome: 'couldNotVerify' },
    });
  });

  it('keeps maxTurns as the legacy per-round continuation case', async () => {
    let calls = 0;
    const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
      calls++;
      if (calls === 1) return { halted: 'maxTurns', turns: 1 };
      await ctx.tools.run(
        { id: 'u2', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) },
        ctx.toolCtx,
      );
      return { finalText: 'claimed after continuation', turns: 1 };
    };

    const trustedObjectiveCheck: NonNullable<GoalRunDeps['check']> = async () => ({
      objectiveChecksPassed: true,
      results: [],
      testTamper: 'clean',
      tamperReason: '',
      heldOut: { passed: true, results: [] },
    });
    const result = await runGoal(spec({ budget: { maxRounds: 3 } }), baseDeps({ run, check: trustedObjectiveCheck }));

    expect(calls).toBe(2);
    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
  });
});
