/**
 * End-to-end smoke for trusted sandbox checks in GoalLoop.
 *
 * It creates a trusted check plan outside the repo, loads it through the same config parser as the
 * CLI, runs a one-round GoalLoop with a fake builder/model, and verifies completion through the real
 * WSL2 sandbox runner. The temp plan and WSL payload folders are left in place for inspection.
 *
 * Run: npm run sandbox:goal-smoke
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultShellPath,
  InMemoryToolRegistry,
  type ModelDelta,
  type ModelProvider,
  type ModelResult,
} from '../src/core/index.js';
import { loadSandboxedCheckPlan, runGoal, type GoalRunDeps } from '../src/capabilities/index.js';
import { createWsl2UnshareSandboxRunner, InMemoryEventBus, type Event } from '../src/runtime/index.js';

function dummyProvider(): ModelProvider {
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield* [];
      return {
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function claimingRun(): NonNullable<GoalRunDeps['run']> {
  return async (ctx) => {
    await ctx.tools.run({ id: 'claim', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) }, ctx.toolCtx);
    return { finalText: 'claimed complete for sandbox goal smoke', turns: 1 };
  };
}

const passingCheck: NonNullable<GoalRunDeps['check']> = async () => ({
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
});

async function main(): Promise<void> {
  const cwd = process.cwd();
  const planDir = join(tmpdir(), `jarvis-sandbox-goal-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(planDir, { recursive: true });

  const planPath = join(planDir, 'sandbox-checks.json');
  await writeFile(
    planPath,
    JSON.stringify(
      {
        requirements: [
          {
            id: 'r1',
            text: 'The project package file is visible inside the sandbox.',
            command: 'stat package.json',
          },
          {
            id: 'r2',
            text: 'A second read-only inspection command can run inside the sandbox.',
            command: 'wc -l package.json',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const plan = await loadSandboxedCheckPlan({
    path: planPath,
    cwd,
    readText: async (path) => readFile(path, 'utf8').catch(() => null),
    realpath: async (path) => realpath(path).catch(() => null),
  });

  const events: string[] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe((event: Event) => {
    if (event.type === 'state') events.push(`phase=${event.phase}`);
    if (event.type === 'verdict') events.push(`verdict=${event.outcome}: ${event.rationale}`);
    if (event.type === 'goal_state') events.push(`goal_state=${event.state}`);
  });

  const result = await runGoal(
    {
      id: 'sandbox-goal-smoke',
      objective: 'Verify trusted sandbox checks can complete a goal.',
      sessionId: 'sandbox-goal-smoke-session',
      budget: { maxRounds: 1 },
      pinned: plan.pinned,
    },
    {
      model: dummyProvider(),
      tools: new InMemoryToolRegistry(),
      bus,
      cwd,
      shellPath: defaultShellPath(),
      builderSystemPrompt: 'Claim completion for this smoke test.',
      perRoundMaxTurns: 2,
      run: claimingRun(),
      check: passingCheck,
      sandboxedRequirementCommands: plan.commands,
      sandboxRunner: createWsl2UnshareSandboxRunner({ retainTempDirs: true }),
    },
  );

  console.log(`trusted plan: ${planPath}`);
  for (const event of events) console.log(event);
  console.log(`state=${result.state}`);
  console.log(`verdict=${result.finalVerdict?.outcome ?? 'missing'}`);

  const ok = result.state === 'complete' && result.finalVerdict?.outcome === 'verified';
  console.log(`\n=== sandbox goal smoke ${ok ? 'PASSED' : 'FAILED'} ===`);
  if (!ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
