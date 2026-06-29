/**
 * D3 milestone demo — "the held-out leg: a hidden assertion the builder never sees".
 *
 * Leg 1 re-runs the checks the builder KNOWS (catches "suite red"); the held-out leg runs the
 * goal-setter's SECRET assertions (catches "builder wrote weak self-passing tests" — it can't game what
 * it can't see). Two phases:
 *   Phase A (live, real Doubao): the builder writes `reverse.js`; the harness runs a leg-1 smoke check
 *     AND a SECRET held-out check (stricter cases the builder never saw). A correct solution passes both
 *     → verified — the held-out leg ran as a real gate.
 *   Phase B (deterministic, no model): a FAKED `reverse.js` (hard-coded to pass the leg-1 case but wrong
 *     in general) passes leg 1 yet the held-out leg catches it → decideVerdict returns rejected. This is
 *     the anti-gaming catch, shown end-to-end with real commands.
 *
 * Run:  npm run demo:d3   (needs ARK_API_KEY)
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
import { decideVerdict, runDeterministicChecks, runGoal } from '../src/capabilities/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const OBJECTIVE =
  'Create a file reverse.js that uses CommonJS `module.exports = { reverse }` to export a function ' +
  'reverse(s) returning the string s reversed (e.g. reverse("abc") === "cba"). Plain JS, no deps.';

// Leg 1 = a check the builder could anticipate (one basic case). Held-out = SECRET stricter cases the
// builder never sees. Both genuinely test the SAME requirement (correct reversal) — held-out adds no
// scope, it just hides the harder cases so a weak self-written test can't pass for them.
const LEG1 = `node -e "const {reverse}=require('./reverse.js'); process.exit(reverse('ab')==='ba'?0:1)"`;
const HELD_OUT = `node -e "const {reverse}=require('./reverse.js'); process.exit(reverse('hello')==='olleh'&&reverse('')===''&&reverse('a')==='a'?0:1)"`;

const BUILDER_PROMPT = [
  '你是一个编码助手。用 read / write / grep 工具达成给定目标(路径相对项目根)。',
  '达成目标后,调用 update_goal(complete) 并结束本轮(不要再调别的工具)。卡住则 update_goal(blocked)。',
].join('\n');

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  const provider = createProvider(config).withThinking('off');
  const shellPath = defaultShellPath();

  console.log(`model: ${config.model}`);
  console.log(`objective: ${OBJECTIVE}`);
  console.log(`leg 1 (builder may anticipate): ${LEG1}`);
  console.log(`held-out (SECRET, builder never sees this): ${HELD_OUT}`);

  // ── Phase A: live builder, held-out runs as a real gate ──
  console.log('\n=== Phase A (live): build → leg 1 + SECRET held-out → verdict ===');
  const dir = await mkdtemp(join(tmpdir(), 'd3-demo-'));
  const tools = buildDefaultRegistry();
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
      case 'verdict':
        process.stdout.write(`\n[verdict] ${e.outcome} — ${e.rationale}\n`);
        break;
      case 'goal_state':
        process.stdout.write(`[goal_state] → ${e.state}\n`);
        break;
      default:
        break;
    }
  });

  const result = await runGoal(
    { id: 'demo-d3', objective: OBJECTIVE, sessionId: 'demo-d3-session', budget: { maxRounds: 4 } },
    {
      model: provider,
      tools,
      bus,
      gate,
      cwd: dir,
      shellPath,
      builderSystemPrompt: BUILDER_PROMPT,
      perRoundMaxTurns: 8,
      checkCommands: [LEG1],
      heldOutCommands: [HELD_OUT], // the harness runs this; it is NEVER put in the builder's context
    },
  );
  const built = await readFile(join(dir, 'reverse.js'), 'utf8').catch(() => '(no file)');
  await rm(dir, { recursive: true, force: true });
  console.log(`\n[Phase A] state=${result.state} verdict=${result.finalVerdict?.outcome}`);
  const phaseAOk = result.state === 'complete' && result.finalVerdict?.outcome === 'verified';

  // ── Phase B: a FAKED solution passes leg 1 but the held-out leg catches it (deterministic) ──
  console.log('\n=== Phase B (deterministic): a faked reverse.js → leg 1 passes, held-out catches it ===');
  const fakeDir = await mkdtemp(join(tmpdir(), 'd3-fake-'));
  // Hard-coded to satisfy ONLY the leg-1 case ('ab' -> 'ba'); wrong in general.
  await writeFile(join(fakeDir, 'reverse.js'), "module.exports = { reverse: () => 'ba' };\n", 'utf8');
  const checks = await runDeterministicChecks({
    shellPath,
    cwd: fakeDir,
    checkCommands: [LEG1],
    heldOutCommands: [HELD_OUT],
  });
  await rm(fakeDir, { recursive: true, force: true });
  const verdict = decideVerdict(checks);
  console.log(`[Phase B] leg 1 passed=${checks.objectiveChecksPassed}  held-out passed=${checks.heldOut?.passed}`);
  console.log(`[Phase B] verdict=${verdict.outcome} — ${verdict.rationale}`);
  const phaseBOk =
    checks.objectiveChecksPassed === true && checks.heldOut?.passed === false && verdict.outcome === 'rejected';

  console.log(`\nbuilt reverse.js (Phase A):\n${built.trim()}`);
  const ok = phaseAOk && phaseBOk;
  console.log(
    `\n=== D3 held-out demo ${ok ? 'PASSED' : 'FAILED'} ` +
      `(A: real work verified by a secret check; B: faked work caught by the same secret check) ===`,
  );
  if (!ok) process.exitCode = 1;
}

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
