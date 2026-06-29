import { describe, expect, it } from 'vitest';
import {
  VerifierCircuitBreaker,
  runGoal,
  type GoalRunDeps,
  type GoalSpec,
} from '../../../src/capabilities/goal/goal-loop.js';
import { assertObjectiveUnchanged, hashObjective } from '../../../src/capabilities/goal/goal-store.js';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { InMemoryEventBus, type Event } from '../../../src/runtime/event-bus.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';

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
  it('completes only when a completion claim is backed by clean checks', async () => {
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

  it('a blocked claim hands the goal to a human without verifying', async () => {
    const { run, calls } = claimingRun('blocked');
    const result = await runGoal(spec(), baseDeps({ run, check: passingCheck }));
    expect(result.state).toBe('blocked');
    expect(calls()).toBe(1);
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

describe('VerifierCircuitBreaker', () => {
  it('trips (halt) on the 3rd consecutive reject and latches once', () => {
    const b = new VerifierCircuitBreaker();
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('halt');
    expect(b.recordReject()).toBe('continue'); // latched — never halts twice
  });

  it('resets the consecutive count on a non-reject', () => {
    const b = new VerifierCircuitBreaker();
    b.recordReject();
    b.recordReject();
    b.recordNonReject();
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('continue');
    expect(b.recordReject()).toBe('halt');
  });
});

describe('assertObjectiveUnchanged — objective immutability (fail-closed)', () => {
  it('passes for the original objective and throws for a changed one', () => {
    const h = hashObjective('build X');
    expect(() => assertObjectiveUnchanged('build X', h)).not.toThrow();
    expect(() => assertObjectiveUnchanged('build something else', h)).toThrow(/immutability/);
  });
});
