/**
 * D1 milestone demo — "it can run a goal to completion, verified independently".
 *
 * GoalLoop + deterministic verification (Phase D) against the REAL Doubao endpoint. A self-contained
 * task: `answer.txt` starts as "wrong"; the objective is to make its only line exactly `42`. The
 * builder reads/writes the file and claims completion; the harness INDEPENDENTLY re-runs the check
 * command (`grep -qx 42 answer.txt`) and trusts the real exit code — only a correct fix verifies.
 *
 * Run:  npm run demo:d1   (needs ARK_API_KEY in the environment)
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDefaultRegistry,
  createProvider,
  defaultShellPath,
  loadDoubaoConfig,
} from '../src/core/index.js';
import { DefaultPermissionGate, InMemoryEventBus, type Event } from '../src/runtime/index.js';
import { runGoal } from '../src/capabilities/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const BUILDER_PROMPT = [
  '你是一个编码助手。用 read / write / grep 工具达成给定目标(路径相对项目根)。',
  '达成目标后,调用 update_goal(complete) 并结束本轮(不要再调别的工具)。卡住则 update_goal(blocked)。',
].join('\n');

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  const provider = createProvider(config).withThinking('off');

  const dir = await mkdtemp(join(tmpdir(), 'd1-demo-'));
  await writeFile(join(dir, 'answer.txt'), 'wrong', 'utf8');

  const tools = buildDefaultRegistry(); // read/write/grep
  const gate = new DefaultPermissionGate({
    approver: async (r) => {
      console.log(`\n[approver] ${r.toolName} — ${r.reason}? → allow-once (demo auto-approve)`);
      return 'allow-once';
    },
  });
  const bus = new InMemoryEventBus();
  bus.subscribe((e: Event) => {
    switch (e.type) {
      case 'message_delta':
        process.stdout.write(e.text);
        break;
      case 'tool_call':
        process.stdout.write(`\n[tool_call] ${e.call.name}(${preview(e.call.arguments)})\n`);
        break;
      case 'tool_result':
        process.stdout.write(`[tool_result] ${e.out.error ? `ERROR: ${e.out.error}` : preview(e.out.content)}\n`);
        break;
      case 'verdict':
        process.stdout.write(`\n[verdict] ${e.outcome} — ${e.rationale}\n`);
        break;
      case 'goal_state':
        process.stdout.write(`[goal_state] → ${e.state}\n`);
        break;
      case 'halt':
        process.stdout.write(`[halt] ${e.reason}\n`);
        break;
      default:
        break;
    }
  });

  console.log(`model: ${config.model}`);
  console.log(`cwd:   ${dir}`);
  console.log('objective: edit answer.txt so its only line is exactly 42 (starts as "wrong")');
  console.log('\n=== running goal (autonomous: build → claim → harness verifies via grep exit code) ===');

  const result = await runGoal(
    {
      id: 'demo',
      objective: 'Edit the file answer.txt so that its only line is exactly: 42',
      sessionId: 'demo-session',
      budget: { maxRounds: 4 },
    },
    {
      model: provider,
      tools,
      bus,
      gate,
      cwd: dir,
      shellPath: defaultShellPath(),
      builderSystemPrompt: BUILDER_PROMPT,
      perRoundMaxTurns: 8,
      checkCommands: ['grep -qx 42 answer.txt'], // leg 1: the harness re-runs THIS and trusts the exit code
    },
  );

  const finalContent = (await readFile(join(dir, 'answer.txt'), 'utf8')).trim();
  await rm(dir, { recursive: true, force: true });

  console.log(`\n[result] state=${result.state} rounds=${result.rounds} verdict=${result.finalVerdict?.outcome}`);
  console.log(`[result] answer.txt final content: ${JSON.stringify(finalContent)}`);
  const ok =
    result.state === 'complete' && result.finalVerdict?.outcome === 'verified' && finalContent === '42';
  console.log(`\n=== D1 goal demo ${ok ? 'PASSED' : 'FAILED'} ===`);
  if (!ok) process.exitCode = 1;
}

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
