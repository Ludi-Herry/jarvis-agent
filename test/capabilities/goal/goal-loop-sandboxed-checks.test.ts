import { describe, expect, it } from 'vitest';
import { runGoal, type GoalRunDeps, type GoalSpec } from '../../../src/capabilities/goal/goal-loop.js';
import type { PinnedRequirement, VerifierReport } from '../../../src/capabilities/goal/goal.js';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { InMemoryEventBus } from '../../../src/runtime/event-bus.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../../../src/runtime/index.js';

const PINNED: PinnedRequirement[] = [{ id: 'r1', text: 'shows git status' }];
const MIXED_PINNED: PinnedRequirement[] = [
  { id: 'r1', text: 'shows git status' },
  { id: 'r2', text: 'README documents the sandbox option' },
];

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
      yield* [];
      return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'completed', rawFinishReason: 'stop' };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function claimingRun(): NonNullable<GoalRunDeps['run']> {
  return async (ctx) => {
    await ctx.tools.run({ id: 'u1', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) }, ctx.toolCtx);
    return { finalText: 'claimed', turns: 1 };
  };
}

const passingCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
});

function spec(over: Partial<GoalSpec> = {}): GoalSpec {
  return { id: 'g1', objective: 'do the thing', sessionId: 's1', budget: { maxRounds: 3 }, pinned: PINNED, ...over };
}

function baseDeps(over: Partial<GoalRunDeps> = {}): GoalRunDeps {
  return {
    model: dummyProvider(),
    tools: new InMemoryToolRegistry(),
    bus: new InMemoryEventBus(),
    cwd: 'H:\\jarvis-agent',
    shellPath: 'bash',
    builderSystemPrompt: 'you are a builder',
    perRoundMaxTurns: 5,
    run: claimingRun(),
    check: passingCheck,
    ...over,
  };
}

describe('runGoal sandboxed requirement checks', () => {
  it('uses trusted sandbox checks instead of the LLM verifier when configured', async () => {
    const requests: SandboxRunRequest[] = [];
    let verifierCalls = 0;
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        requests.push(request);
        return completed(0, 'ok');
      },
    };
    const runVerifier: NonNullable<GoalRunDeps['runVerifier']> = async (): Promise<VerifierReport> => {
      verifierCalls++;
      throw new Error('LLM verifier should not run when sandbox checks are configured');
    };

    const result = await runGoal(
      spec(),
      baseDeps({
        sandboxRunner: runner,
        sandboxedRequirementCommands: [{ requirementId: 'r1', command: 'git status --short' }],
        verifierProvider: dummyProvider(),
        runVerifier,
      }),
    );

    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
    expect(verifierCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: ['bash', '--noprofile', '--norc', '-c', 'git status --short'],
      cwd: '/tmp/jarvis-sandbox/project',
      mounts: [{ hostPath: 'H:\\jarvis-agent', sandboxPath: '/tmp/jarvis-sandbox/project', access: 'read-only' }],
      networkMode: 'none',
    });
  });

  it('hardens trusted git diff sandbox checks before runner execution', async () => {
    const requests: SandboxRunRequest[] = [];
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        requests.push(request);
        return completed(0, 'ok', '', request);
      },
    };

    await runGoal(
      spec(),
      baseDeps({
        sandboxRunner: runner,
        sandboxedRequirementCommands: [{ requirementId: 'r1', command: 'git diff --stat' }],
      }),
    );

    expect(requests[0]?.command).toEqual(['bash', '--noprofile', '--norc', '-c', 'git diff --no-ext-diff --stat']);
  });

  it('parks when sandbox checks are configured but no runner is available', async () => {
    const result = await runGoal(
      spec({ budget: { maxRounds: 1 } }),
      baseDeps({ sandboxedRequirementCommands: [{ requirementId: 'r1', command: 'git status --short' }] }),
    );

    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('couldNotVerify');
    expect(result.finalVerdict?.rationale).toContain('sandboxed requirement checks configured but no sandbox runner');
  });

  it('rejects unsafe configured commands before calling the runner', async () => {
    let called = false;
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        called = true;
        return completed(0, 'should not run', '', request);
      },
    };

    const result = await runGoal(
      spec({ budget: { maxRounds: 1 } }),
      baseDeps({
        sandboxRunner: runner,
        sandboxedRequirementCommands: [{ requirementId: 'r1', command: 'touch proof' }],
      }),
    );

    expect(called).toBe(false);
    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('couldNotVerify');
    expect(result.finalVerdict?.report?.couldNotVerify[0]).toContain('command rejected');
  });

  it('combines sandbox and LLM route results when goal-setter routes are configured', async () => {
    const requests: SandboxRunRequest[] = [];
    let verifierPinned: PinnedRequirement[] = [];
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        requests.push(request);
        return completed(0, 'ok', '', request);
      },
    };
    const runVerifier: NonNullable<GoalRunDeps['runVerifier']> = async (_objective, pinned): Promise<VerifierReport> => {
      verifierPinned = pinned;
      return {
        feature: 'works',
        expected: 'LLM verifier checks documentation.',
        observed: 'r2: docs mention the sandbox option',
        evidence: 'README contains --sandbox-check-map.',
        perRequirement: [{ requirementId: 'r2', strength: 'proves', scope: 'matched' }],
        couldNotVerify: [],
        rationale: 'LLM route verified.',
      };
    };

    const result = await runGoal(
      spec({ pinned: MIXED_PINNED }),
      baseDeps({
        sandboxRunner: runner,
        sandboxedRequirementCommands: [{ requirementId: 'r1', command: 'git status --short' }],
        goalSetterRequirementRoutes: new Map([
          ['r1', 'sandbox-command'],
          ['r2', 'llm'],
        ]),
        verifierProvider: dummyProvider(),
        runVerifier,
      }),
    );

    expect(result.state).toBe('complete');
    expect(result.finalVerdict?.outcome).toBe('verified');
    expect(requests).toHaveLength(1);
    expect(verifierPinned).toEqual([{ id: 'r2', text: 'README documents the sandbox option' }]);
    expect(result.finalVerdict?.report?.perRequirement).toEqual([
      { requirementId: 'r1', strength: 'proves', scope: 'matched' },
      { requirementId: 'r2', strength: 'proves', scope: 'matched' },
    ]);
  });

  it('parks an LLM-routed requirement when no verifier provider is configured', async () => {
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        return completed(0, 'ok', '', request);
      },
    };

    const result = await runGoal(
      spec({ pinned: MIXED_PINNED, budget: { maxRounds: 1 } }),
      baseDeps({
        sandboxRunner: runner,
        sandboxedRequirementCommands: [{ requirementId: 'r1', command: 'git status --short' }],
        goalSetterRequirementRoutes: new Map([
          ['r1', 'sandbox-command'],
          ['r2', 'llm'],
        ]),
      }),
    );

    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('couldNotVerify');
    expect(result.finalVerdict?.report?.couldNotVerify.join('\n')).toContain('no LLM verifier report configured for r2');
  });

  it('parks human-routed requirements without spawning the LLM verifier', async () => {
    let verifierCalls = 0;
    const runVerifier: NonNullable<GoalRunDeps['runVerifier']> = async () => {
      verifierCalls++;
      throw new Error('human route should not call the LLM verifier');
    };

    const result = await runGoal(
      spec({ pinned: [{ id: 'r1', text: 'Human checks the copy' }], budget: { maxRounds: 1 } }),
      baseDeps({
        goalSetterRequirementRoutes: new Map([['r1', 'human']]),
        verifierProvider: dummyProvider(),
        runVerifier,
      }),
    );

    expect(verifierCalls).toBe(0);
    expect(result.state).toBe('blocked');
    expect(result.finalVerdict?.outcome).toBe('couldNotVerify');
    expect(result.finalVerdict?.report?.couldNotVerify[0]).toContain('human verification required for r1');
  });
});

function completed(exitCode: number, stdout: string, stderr = '', request = sampleRequest()): SandboxRunResult {
  return {
    status: 'completed',
    backend: 'wsl2-unshare',
    audit: {
      backend: 'wsl2-unshare',
      command: request.command,
      cwd: request.cwd,
      mounts: request.mounts,
      networkMode: request.networkMode,
      limits: request.limits,
    },
    exitCode,
    stdout,
    stderr,
    durationMs: 10,
  };
}

function sampleRequest(): SandboxRunRequest {
  return {
    command: ['bash', '--noprofile', '--norc', '-c', 'git status --short'],
    cwd: '/tmp/jarvis-sandbox/project',
    mounts: [{ hostPath: 'H:\\jarvis-agent', sandboxPath: '/tmp/jarvis-sandbox/project', access: 'read-only' }],
    networkMode: 'none',
    limits: { timeoutMs: 30_000, outputBytes: 32_768 },
    reason: 'trusted per-requirement sandbox check',
  };
}
