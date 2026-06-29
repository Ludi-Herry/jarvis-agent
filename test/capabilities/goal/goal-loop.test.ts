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
import type { PinnedRequirement, VerifierReport } from '../../../src/capabilities/goal/goal.js';

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

  it('without a verifier provider the batch-1 deterministic-only path is unchanged (clean legs → verified)', async () => {
    const { run } = claimingRun('complete');
    const spy = verifierSpy(perfectReport());
    const result = await runGoal(
      spec({ pinned: PINNED }), // pinned present but no verifierProvider → leg 3 stays off
      baseDeps({ run, check: passingCheck, runVerifier: spy.fn }),
    );
    expect(spy.calls()).toBe(0); // no provider → judge never runs
    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
  });
});
