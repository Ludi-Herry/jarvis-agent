/**
 * surfaces/cli/goal-cli — the `goal` entry point (Phase D, D4).
 *
 * A SEPARATE entry from the REPL (not folded into startRepl): one objective in, the GoalLoop drives
 * a builder agent toward it autonomously, the harness verifies independently (deterministic two
 * legs), and the loop self-stops at complete / blocked. Tool side effects still pass the
 * PermissionGate — an interactive approver, same as the REPL.
 *
 * Run:  npm run goal -- "<objective>"   (needs ARK_API_KEY)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  DefaultContextManager,
  buildDefaultRegistry,
  createBashTool,
  createProvider,
  defaultShellPath,
  loadDoubaoConfig,
  resolveVerifierConfig,
  runCommand,
  scrubProviderKeyFromEnv,
} from '../../core/index.js';
import {
  DefaultPermissionGate,
  FileSessionStore,
  InMemoryEventBus,
  type Approver,
  type Event,
} from '../../runtime/index.js';
import {
  DEFAULT_CHECK_COMMANDS,
  FileGoalStore,
  derivePinnedRequirements,
  runGoal,
  type PinnedRequirement,
  type TestBaseline,
} from '../../capabilities/index.js';
import type { ModelProvider } from '../../core/index.js';
import { initialRenderState, renderEvent } from './render.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const OUTPUT_RESERVE_TOKENS = 16_384;

const BUILDER_PROMPT = [
  '你是一个在终端里自主工作的编码助手,正在达成一个目标。',
  '用 read / write / grep / bash 工具推进(路径相对项目根)。危险或涉密操作会被权限闸门拦下或需用户批准。',
  '你认为目标已达成时,调用 update_goal(complete) 并结束本轮——harness 会独立重跑项目检查来验证;',
  '不要删改测试来凑绿(会被检测并拒绝)。如果卡住无法完成,调用 update_goal(blocked)。',
].join('\n');

async function main(): Promise<void> {
  const objective = process.argv.slice(2).join(' ').trim();
  if (objective === '') {
    console.error('用法: npm run goal -- "<objective>"');
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = loadDoubaoConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const provider = createProvider(config).withThinking('off');
  // The provider captured the key; remove it from the env so the goal builder's bash can't read it back
  // via /proc/<pid>/environ (Linux). Keeps ARK_VERIFIER_MODEL (read by resolveVerifierConfig below).
  scrubProviderKeyFromEnv();
  const cwd = process.cwd();
  const shellPath = defaultShellPath();

  const tools = buildDefaultRegistry();
  tools.register(createBashTool()); // safe to register: every call runs behind the gate below

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const approver: Approver = async (req) => {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`\n批准 ${req.toolName}? ${req.reason}\n  [a]llow once / [d]eny: `, resolve),
    );
    return answer.trim().toLowerCase().startsWith('a') ? 'allow-once' : 'deny';
  };
  const gate = new DefaultPermissionGate({ approver });
  const context = new DefaultContextManager({
    summarizer: provider,
    maxContextTokens: provider.capability.maxContextTokens,
    maxOutputTokens: OUTPUT_RESERVE_TOKENS,
  });

  const bus = new InMemoryEventBus();
  let rstate = initialRenderState();
  bus.subscribe((e: Event) => {
    const { output, state } = renderEvent(rstate, e);
    rstate = state;
    if (output) process.stdout.write(output);
  });

  const baseline = await snapshotBaseline(shellPath, cwd); // leg-2 baseline; undefined if not a git repo
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionId = `goal-${id}`;
  const goalStore = new FileGoalStore(join(cwd, 'data', 'goals', `${id}.jsonl`));
  const sessionStore = new FileSessionStore(join(cwd, 'data', 'sessions', `${sessionId}.jsonl`));
  await sessionStore.writeHeader({ id: sessionId, model: config.model, cwd, startedAt: new Date().toISOString() });

  // Leg 3 (independent LLM judge): enabled only when ARK_VERIFIER_MODEL names a DIFFERENT model. When
  // enabled, derive the pinned requirement list once (builder model) and fail closed if it comes back
  // empty — an empty list makes `verified` unreachable, so starting would only burn budget to a block.
  let verifierProvider: ModelProvider | undefined;
  let pinned: PinnedRequirement[] = [];
  const verifier = resolveVerifierConfig(process.env, config);
  if (verifier.enabled) {
    verifierProvider = createProvider(verifier.config).withThinking('off');
    pinned = await derivePinnedRequirements(objective, provider);
    if (pinned.length === 0) {
      console.error(
        '[goal] 腿3 已启用但未能从目标推导出验收清单(pinned requirements 为空)。\n' +
          '没有可逐条打分的清单,verified 不可达——拒绝启动,避免空烧预算。请把目标写得更具体后重试。',
      );
      rl.close();
      process.exitCode = 1;
      return;
    }
  }

  // Held-out leg: secret hidden-assertion commands from a FILE (kept off the command line / shell
  // history). Absent → the leg is explicitly declared absent (a known weaker-confidence state).
  const heldOutCommands = loadHeldOutCommands();

  console.log(`Jarvis-Agent · goal 模式 · ${config.model}`);
  console.log(`目标: ${objective}`);
  console.log(baseline ? `验收: 四关卡 + 测试篡改检测(baseline ${baseline.headSha.slice(0, 8)})` : '验收: 四关卡(非 git 仓,跳过篡改检测)');
  console.log(
    heldOutCommands.length > 0
      ? `held-out: 已配置 ${heldOutCommands.length} 条隐藏校验(builder 看不到)`
      : 'held-out: 未配置 —— 缺这条腿,verified 置信偏弱,建议加权人工抽查(设 JARVIS_HELDOUT_CHECKS_FILE 启用)',
  );
  console.log(
    verifier.enabled
      ? `腿3: 独立裁判已启用(${verifier.config.model}),固定验收清单 ${pinned.length} 条\n`
      : `腿3: 未启用(${verifier.reason})\n`,
  );

  const result = await runGoal(
    { id, objective, sessionId, budget: { maxRounds: 8 }, baseline, pinned },
    {
      model: provider,
      tools,
      bus,
      gate,
      context,
      store: sessionStore,
      goalStore,
      cwd,
      shellPath,
      builderSystemPrompt: BUILDER_PROMPT,
      perRoundMaxTurns: 16,
      checkCommands: DEFAULT_CHECK_COMMANDS,
      heldOutCommands: heldOutCommands.length > 0 ? heldOutCommands : undefined,
      verifierProvider,
    },
  );

  rl.close();
  console.log(
    `\n=== goal ${result.state} (rounds=${result.rounds}, verdict=${result.finalVerdict?.outcome ?? '—'}) ===`,
  );
  if (result.state !== 'complete') process.exitCode = 1;
}

/**
 * Load held-out commands from the file named by `JARVIS_HELDOUT_CHECKS_FILE` (one command per line; `#`
 * comments and blanks skipped). A file keeps the commands off the command line / shell history. For the
 * assertions to truly be held-out, the file AND any test files it references should live OUTSIDE the
 * project directory — the builder's read/grep are confined to cwd, so it can't discover them there.
 * Returns [] when unset/missing/unreadable (the leg is then explicitly declared absent).
 */
function loadHeldOutCommands(): string[] {
  const path = process.env.JARVIS_HELDOUT_CHECKS_FILE?.trim();
  // Scrub it from the environment immediately: the builder's bash tool inherits process.env (shellEnv
  // copies it per exec), so leaving it set would let the builder `echo $JARVIS_HELDOUT_CHECKS_FILE` then
  // `cat` the file — defeating the held-out secrecy. We read it once here, before runGoal, then delete.
  delete process.env.JARVIS_HELDOUT_CHECKS_FILE;
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/** Snapshot the leg-2 baseline: the current HEAD sha. Undefined when not a git repo (leg 2 inert). */
async function snapshotBaseline(shellPath: string, cwd: string): Promise<TestBaseline | undefined> {
  const res = await runCommand(shellPath, 'git rev-parse HEAD', cwd, 10_000, 1_000);
  if (res.code !== 0) return undefined;
  return { headSha: res.output.trim(), testFiles: [] };
}

main().catch((err: unknown) => {
  console.error('\n[goal] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
