/**
 * Manual real-model autonomous coding smoke.
 *
 * Creates a temp fixture outside this repo, gives a real builder model only read/write/grep plus
 * sandboxed_check feedback, and requires the loop to see test red -> fix -> test green before
 * update_goal(complete). This script is intentionally opt-in and is not part of default tests.
 *
 * Run: npm run sandbox:autonomous-model-smoke
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildDefaultRegistry,
  createProvider,
  createSandboxedBuilderCheckTool,
  defaultShellPath,
  loadDoubaoConfig,
  scrubProviderKeyFromEnv,
  type ModelProvider,
} from '../src/core/index.js';
import { FileGoalStore, runGoal, type TestBaseline } from '../src/capabilities/index.js';
import { createWsl2UnshareSandboxRunner, InMemoryEventBus, type Event } from '../src/runtime/index.js';

const OBJECTIVE =
  'Fix the temp fixture so add(a, b) returns the mathematical sum. First run sandboxed_check(test) to observe the failing test, then edit only src/add.js, rerun sandboxed_check(test) until it is green, and only then call update_goal(complete).';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  let provider: ModelProvider;
  try {
    const config = loadDoubaoConfig();
    provider = createProvider(config).withThinking('off');
    scrubProviderKeyFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const fixture = await createFixture();
  const baseline = initGitBaseline(fixture.cwd);
  const events: string[] = [];
  const sandboxExits: number[] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe((event: Event) => {
    if (event.type === 'tool_call') events.push(`tool_call=${event.call.name}`);
    if (event.type === 'tool_result') {
      const exit = /\[sandboxed check: test\][\s\S]*?\[exit code: (\d+)\]/.exec(event.out.content);
      if (exit) sandboxExits.push(Number(exit[1]));
      if (event.out.error) events.push(`tool_error=${event.out.error}`);
    }
    if (event.type === 'verdict') events.push(`verdict=${event.outcome}: ${event.rationale}`);
    if (event.type === 'goal_state') events.push(`goal_state=${event.state}`);
    if (event.type === 'halt') events.push(`halt=${event.reason}`);
  });

  const tools = buildDefaultRegistry();
  tools.register(createSandboxedBuilderCheckTool({ runner: createWsl2UnshareSandboxRunner({ retainTempDirs: true }) }));

  const result = await runGoal(
    {
      id: 'autonomous-model-smoke',
      objective: OBJECTIVE,
      sessionId: 'autonomous-model-smoke-session',
      budget: { maxRounds: 3, maxTotalTurns: 36 },
      baseline,
    },
    {
      model: provider,
      tools,
      bus,
      cwd: fixture.cwd,
      shellPath: defaultShellPath(),
      builderSystemPrompt: [
        'You are running a real-model autonomous coding smoke in a temporary fixture.',
        'Use only read, write, grep, and sandboxed_check. Do not use network or shell commands.',
        'You must run sandboxed_check with check=test before editing so you can see the red test output.',
        'Edit only src/add.js. Do not edit package.json or test files.',
        'After sandboxed_check(test) is green, call update_goal(complete) and stop.',
      ].join('\n'),
      perRoundMaxTurns: 12,
      checkCommands: ['npm test'],
      heldOutCommands: [
        'node -e "import(\'./src/add.js\').then(({ add }) => { if (add(-2, 5) !== 3 || add(10, -7) !== 3) process.exit(1); }).catch(() => process.exit(1));"',
      ],
      goalStore: new FileGoalStore(join(fixture.cwd, 'data', 'goals', 'autonomous-model-smoke.jsonl')),
    },
  );

  console.log(`fixture=${fixture.cwd}`);
  console.log(`baseline=${baseline?.headSha ?? 'unavailable'}`);
  for (const event of events) console.log(event);
  console.log(`sandbox_test_exits=${sandboxExits.join(',') || 'none'}`);
  console.log(`state=${result.state}`);
  console.log(`verdict=${result.finalVerdict?.outcome ?? 'missing'}`);

  const sawRedThenGreen = sawExitBefore(sandboxExits, 1, 0);
  const ok = result.state === 'complete' && result.finalVerdict?.outcome === 'verified' && sawRedThenGreen;
  if (!sawRedThenGreen) console.error('expected to observe sandboxed_check(test) red before green');
  console.log(`\n=== autonomous model smoke ${ok ? 'PASSED' : 'FAILED'} ===`);
  if (!ok) process.exitCode = 1;
}

async function createFixture(): Promise<{ cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-autonomous-model-smoke-'));
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify(
      {
        type: 'module',
        scripts: {
          test: 'node test/add.test.mjs',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(join(cwd, 'src', 'add.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
  await writeFile(
    join(cwd, 'test', 'add.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/add.js';",
      '',
      'assert.equal(add(2, 3), 5);',
      "console.log('add test passed');",
      '',
    ].join('\n'),
    'utf8',
  );
  return { cwd };
}

function initGitBaseline(cwd: string): TestBaseline | undefined {
  const commands: Array<[string, string[]]> = [
    ['git', ['init']],
    ['git', ['config', 'user.email', 'jarvis-smoke@example.invalid']],
    ['git', ['config', 'user.name', 'Jarvis Smoke']],
    ['git', ['add', '.']],
    ['git', ['commit', '-m', 'baseline']],
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return undefined;
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
  if (head.status !== 0) return undefined;
  return { headSha: head.stdout.trim(), testFiles: [] };
}

function sawExitBefore(exits: readonly number[], first: number, later: number): boolean {
  const firstIndex = exits.findIndex((exit) => exit === first);
  if (firstIndex < 0) return false;
  return exits.slice(firstIndex + 1).some((exit) => exit === later);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
