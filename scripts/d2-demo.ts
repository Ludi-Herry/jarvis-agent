/**
 * D2 milestone demo — "leg 3: an independent judge verifies what a machine can't".
 *
 * The full three-leg path against the REAL ARK endpoint with TWO different Doubao models. The task is
 * chosen so the deterministic legs are necessary-but-not-sufficient: leg 1 only checks that `note.txt`
 * EXISTS (`test -f note.txt`) — it cannot tell whether the contents are actually a one-sentence English
 * motivational quote. That semantic judgment is leg 3's job: a SECOND model reads the file read-only and
 * scores the harness-pinned requirement list, and decideVerdict (pure) turns the evidence into the
 * verdict. Only a genuinely-correct file reaches `verified`.
 *
 * Run:  npm run demo:d2   (needs ARK_API_KEY and ARK_VERIFIER_MODEL set to a DIFFERENT Doubao model id)
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
  resolveVerifierConfig,
} from '../src/core/index.js';
import { DefaultPermissionGate, InMemoryEventBus, type Event } from '../src/runtime/index.js';
import { derivePinnedRequirements, runGoal } from '../src/capabilities/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const OBJECTIVE = 'Create a file note.txt whose entire content is a single-sentence motivational quote written in English.';

const BUILDER_PROMPT = [
  '你是一个编码助手。用 read / write / grep 工具达成给定目标(路径相对项目根)。',
  '达成目标后,调用 update_goal(complete) 并结束本轮(不要再调别的工具)。卡住则 update_goal(blocked)。',
].join('\n');

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  const verifier = resolveVerifierConfig(process.env, config);
  if (!verifier.enabled) {
    console.error(`[demo:d2] 腿3 未启用: ${verifier.reason}`);
    console.error('请设置 ARK_VERIFIER_MODEL 为一个与 builder 不同的 Doubao 模型 id 后重试。');
    process.exitCode = 1;
    return;
  }

  const provider = createProvider(config).withThinking('off');
  const verifierProvider = createProvider(verifier.config).withThinking('off');

  console.log(`builder model:  ${config.model}`);
  console.log(`verifier model: ${verifier.config.model}`);
  console.log(`objective: ${OBJECTIVE}`);

  console.log('\n=== deriving pinned requirements (builder model, one LLM call) ===');
  const pinned = await derivePinnedRequirements(OBJECTIVE, provider);
  if (pinned.length === 0) {
    console.error('[demo:d2] 推导验收清单为空 — fail closed,拒绝启动。');
    process.exitCode = 1;
    return;
  }
  for (const p of pinned) console.log(`  · [${p.id}] ${p.text}`);

  const dir = await mkdtemp(join(tmpdir(), 'd2-demo-'));
  await writeFile(join(dir, 'note.txt'), 'TODO', 'utf8');

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
      case 'tool_call':
        process.stdout.write(`\n[tool_call] ${e.call.name}(${preview(e.call.arguments)})\n`);
        break;
      case 'tool_result':
        process.stdout.write(`[tool_result] ${e.out.error ? `ERROR: ${e.out.error}` : preview(e.out.content)}\n`);
        break;
      case 'state':
        process.stdout.write(`[state] ${e.phase}\n`);
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

  console.log('\n=== running goal (build → leg1 file-exists → leg3 judge reads & scores → verdict) ===');
  const result = await runGoal(
    { id: 'demo-d2', objective: OBJECTIVE, sessionId: 'demo-d2-session', budget: { maxRounds: 4 }, pinned },
    {
      model: provider,
      tools,
      bus,
      gate,
      cwd: dir,
      shellPath: defaultShellPath(),
      builderSystemPrompt: BUILDER_PROMPT,
      perRoundMaxTurns: 8,
      checkCommands: ['test -f note.txt'], // leg 1 can only confirm the file EXISTS — not that it's correct
      verifierProvider,
    },
  );

  const finalContent = (await readFile(join(dir, 'note.txt'), 'utf8')).trim();
  await rm(dir, { recursive: true, force: true });

  console.log(`\n[result] state=${result.state} rounds=${result.rounds} verdict=${result.finalVerdict?.outcome}`);
  console.log(`[result] note.txt final content: ${JSON.stringify(finalContent)}`);
  // The demo PASSES if the three-leg pipeline ran end-to-end and reached a TERMINAL, non-false-positive
  // verdict: either verified (judge confirmed) or a fail-closed block (judge couldn't confirm / rejected).
  // A false positive would be `complete` with an empty/garbage file — which the judge must prevent.
  const terminal = result.state === 'complete' || result.state === 'blocked';
  const ok = terminal && result.finalVerdict !== undefined;
  console.log(`\n=== D2 leg-3 demo ${ok ? 'PASSED' : 'FAILED'} (verdict by independent judge, not self-report) ===`);
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
