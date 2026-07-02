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
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  DefaultContextManager,
  buildDefaultRegistry,
  createBashTool,
  assertKeyNotInLaunchEnv,
  createProvider,
  createVisionComplete,
  createVisionTool,
  defaultShellPath,
  loadDoubaoConfig,
  resolveVerifierConfig,
  resolveVisionConfig,
  runCommand,
  scrubProviderKeyFromEnv,
} from '../../core/index.js';
import {
  DefaultPermissionGate,
  FileSessionStore,
  InMemoryEventBus,
  createWsl2UnshareSandboxRunner,
  type Approver,
  type Event,
} from '../../runtime/index.js';
import {
  DEFAULT_CHECK_COMMANDS,
  FileGoalStore,
  ShadowGit,
  derivePinnedRequirements,
  loadSandboxedCheckPlan,
  resolveHooks,
  runGoal,
  type LoadedSandboxedCheckPlan,
  type PinnedRequirement,
  type TestBaseline,
} from '../../capabilities/index.js';
import type { ModelProvider } from '../../core/index.js';
import { safeInline } from './approval.js';
import { createInteractiveApprover, readlineApproverIo } from './interactive-approver.js';
import { initialRenderState, renderEvent } from './render.js';

// Capture BEFORE the runtime .env load: a key present here came from the shell LAUNCH env (it is in
// /proc/<pid>/environ on Linux); a key that appears only after loadEnvFile came from .env (runtime-
// injected after execve, never in /proc). The guard (assertKeyNotInLaunchEnv) uses this for /proc safety.
const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;
// JARVIS_HOOKS is a TRUSTED, launch-controlled source: capture BEFORE .env so an in-repo .env can't
// set it and enable repo-authored hook commands.
const JARVIS_HOOKS_LAUNCH = process.env.JARVIS_HOOKS;
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
    assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV); // /proc safety: refuse a launch-env key on Linux
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
  const sandboxCheckPlanPath = process.env.JARVIS_SANDBOX_CHECKS_FILE?.trim();
  delete process.env.JARVIS_SANDBOX_CHECKS_FILE;
  const forbiddenSandboxPlanRoots = Array.from(new Set([cwd, findWorkspaceRoot(cwd)]));

  let sandboxCheckPlan: LoadedSandboxedCheckPlan | undefined;
  if (sandboxCheckPlanPath) {
    try {
      sandboxCheckPlan = await loadSandboxedCheckPlan({
        path: sandboxCheckPlanPath,
        cwd,
        forbiddenRoots: forbiddenSandboxPlanRoots,
        readText: async (p) => readFile(p, 'utf8').catch(() => null),
        realpath: async (p) => realpath(p).catch(() => null),
      });
    } catch (err) {
      console.error(`[sandbox checks] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  const tools = buildDefaultRegistry();
  tools.register(createBashTool()); // safe to register: every call runs behind the gate below
  // Vision (Phase E multimodal): mirror the REPL — register `vision` ONLY when ARK_VISION_MODEL names a
  // vision model (opt-in, like leg 3). capability=network → the gate routes the call to `ask`, which the
  // goal approver below answers (attended). With no approver it would fail-close to deny — no silent
  // image egress. Reuses the in-memory config key (resolveVisionConfig reads only ARK_VISION_MODEL from
  // the env, which scrubProviderKeyFromEnv above left intact — it is not a secret).
  const vision = resolveVisionConfig(process.env, config);
  if (vision.enabled) tools.register(createVisionTool(createVisionComplete(vision.config)));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // The same interactive approver the loop uses (interactive-approver.ts): renders detailOf +
  // [a]/[s]/[d] (so a network `vision` call is approved KNOWING which image leaves the machine) and
  // now exposes `s` (allow-session) — command-scoped for bash, so approving a shell command once
  // stops re-asking that exact command for the rest of this goal run. Blank/unrecognized re-asks;
  // EOF or exhausted retries → deny (fail-closed).
  const approver: Approver = createInteractiveApprover(readlineApproverIo(rl));
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
  if (sandboxCheckPlan) {
    pinned = sandboxCheckPlan.pinned;
  } else if (verifier.enabled) {
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

  // shadow-git (opt-in via JARVIS_SHADOW_GIT): a side history of the builder's file changes under
  // data/shadow, snapshotted per round, so you can audit / `npm run shadow -- restore <sha>` a bad run.
  // Off by default so a run never silently creates the shadow repo; best-effort when on.
  const shadowGit = process.env.JARVIS_SHADOW_GIT ? new ShadowGit({ shellPath, cwd, gitDir: join(cwd, 'data', 'shadow') }) : undefined;

  // Hooks: trusted sources only — user-home default first, then launch-captured JARVIS_HOOKS.
  // In-repo sources are refused after realpath canonicalization; malformed sources warn per source.
  const { hooks, warning: hookWarning } = await resolveHooks({ hooksPath: JARVIS_HOOKS_LAUNCH, cwd, shellPath });
  if (hookWarning) console.error(`[hooks] ${hookWarning}`);

  console.log(`Jarvis-Agent · goal 模式 · ${safeInline(config.model)}`);
  console.log(`目标: ${objective}`);
  console.log(baseline ? `验收: 四关卡 + 测试篡改检测(baseline ${baseline.headSha.slice(0, 8)})` : '验收: 四关卡(非 git 仓,跳过篡改检测)');
  console.log(
    heldOutCommands.length > 0
      ? `held-out: 已配置 ${heldOutCommands.length} 条隐藏校验(builder 看不到)`
      : 'held-out: 未配置 —— 缺这条腿,verified 置信偏弱,建议加权人工抽查(设 JARVIS_HELDOUT_CHECKS_FILE 启用)',
  );
  console.log(
    sandboxCheckPlan
      ? `腿3: sandbox runtime proof 已启用,固定验收清单 ${pinned.length} 条; LLM 裁判跳过(${verifier.enabled ? safeInline(verifier.config.model) : safeInline(verifier.reason)})`
      : verifier.enabled
      ? `腿3: 独立裁判已启用(${safeInline(verifier.config.model)}),固定验收清单 ${pinned.length} 条`
      : `腿3: 未启用(${safeInline(verifier.reason)})`,
  );
  console.log(
    sandboxCheckPlan
      ? `sandbox checks: enabled from trusted file (${sandboxCheckPlan.commands.length}/${sandboxCheckPlan.pinned.length} requirements have commands); runtime-proof report takes precedence`
      : 'sandbox checks: disabled',
  );
  console.log(
    vision.enabled
      ? `vision: 已启用(${safeInline(vision.config.model)}) —— builder 可看图(发图出网,受闸 ask 批准)`
      : `vision: 未启用(${vision.reason})`,
  );
  console.log(
    shadowGit
      ? 'shadow-git: 已启用 —— 每轮快照工作树到 data/shadow,审计/回滚用 npm run shadow -- log / restore <sha>\n'
      : 'shadow-git: 未启用(设 JARVIS_SHADOW_GIT=1 开启改动审计 + 回滚)\n',
  );

  await runAdvisoryHook(hooks?.sessionStart);
  let result;
  try {
    result = await runGoal(
      { id, objective, sessionId, budget: { maxRounds: 8 }, baseline, pinned },
      {
        model: provider,
        tools,
        bus,
        gate,
        hooks,
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
        sandboxedRequirementCommands: sandboxCheckPlan?.commands,
        sandboxRunner: sandboxCheckPlan ? createWsl2UnshareSandboxRunner() : undefined,
        shadowGit,
      },
    );
  } finally {
    await runAdvisoryHook(hooks?.sessionEnd);
    rl.close();
  }

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

function findWorkspaceRoot(cwd: string): string {
  let cursor = cwd;
  while (true) {
    if (existsSync(join(cursor, '.git'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return cwd;
    cursor = parent;
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

async function runAdvisoryHook(fn: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await fn?.();
  } catch {
    // session hooks are notification-only
  }
}
