/**
 * surfaces/cli/loop-cli — the `loop` entry point (Phase E).
 *
 * One objectives FILE in (one objective per line), the LoopRunner drains the queue: each objective is
 * driven to a terminal state by the UNCHANGED runGoal (independent verification), the loop records
 * orchestration to data/loops/<id>.jsonl, accumulates cross-goal verifier health, and self-stops at a
 * numeric stop condition. Crash/budget-stopped runs resume with `--resume` (never re-running a
 * finished goal). The loop has ZERO completion authority — runGoal alone decides `complete`.
 *
 * Approver modes (the honest sandbox boundary): `--attended` (default) uses an interactive readline
 * approver, so a human approves each gated write/bash across the queue. `--unattended` injects NO
 * approver, so the gate fail-closes every `ask` to deny — and the default policy has NO write-allowing
 * rule, so EVERY write and bash is `ask` and thus denied. Only read/grep-only goals complete
 * unattended; everything that writes blocks safely. Truly unattended bash autonomy waits for the OS
 * sandbox (a config bash allow-list is unsafe); this entry adds no bash auto-allow.
 *
 * Vision (opt-in via ARK_VISION_MODEL) is a BUILDER tool only, with capability=network (it sends a
 * local image to a remote VLM). The gate routes it to `ask` like write/bash: attended it is approved,
 * unattended it fail-closes to deny — no silent image egress even in an unattended loop. The read-only
 * leg-3 judge deliberately has NO vision (network would break "an injected judge cannot act"); a visual
 * requirement the judge cannot confirm by reading files routes to couldNotVerify → a human.
 *
 * Verification surface (honest): each goal is verified by the UNCHANGED runGoal = deterministic leg 1
 * (re-run checks) + leg 2 (tamper). Leg 3 (the LLM judge) runs only when `ARK_VERIFIER_MODEL` names a
 * different model — and ONLY then can a goal return couldNotVerify, which is the sole input to the
 * cross-goal VerifierHealthMonitor. So the headline monitor is INERT in the default `npm run loop`
 * (correctly — no shared judge, no judge-health signal) and LIVE once ARK_VERIFIER_MODEL is set. The
 * held-out hidden-assertion leg is NOT wired here (it is a per-objective secret; one shared file across
 * a heterogeneous queue is meaningless) — set it per single goal via `npm run goal` if you need it.
 *
 * Run:  npm run loop -- <objectives-file>            (needs ARK_API_KEY in .env)
 *       npm run loop -- <objectives-file> --unattended
 *       ARK_VERIFIER_MODEL=<id> npm run loop -- <objectives-file>   (enable leg 3 + the health monitor)
 *       npm run resume:loop                           (continue the newest data/loops/*.jsonl)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
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
import { DefaultPermissionGate, FileSessionStore, InMemoryEventBus, type Approver, type Event } from '../../runtime/index.js';
import {
  DEFAULT_CHECK_COMMANDS,
  FileGoalStore,
  FileLoopStore,
  ShadowGit,
  derivePinnedRequirements,
  latestLoopPath,
  loadLoop,
  resolveHooks,
  runGoal,
  runLoop,
  type GoalRunSummary,
  type LoopContract,
  type PinnedRequirement,
  type TestBaseline,
} from '../../capabilities/index.js';
import type { ModelProvider } from '../../core/index.js';
import { detailOf, safeInline } from './approval.js';
import { initialRenderState, renderEvent } from './render.js';

// Capture BEFORE the runtime .env load (see goal-cli): a key here came from the shell LAUNCH env
// (in /proc on Linux); the guard refuses it so the provider key only ever arrives via .env.
const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;
// JARVIS_HOOKS is a TRUSTED, launch-controlled source: capture BEFORE .env so an in-repo .env can't
// set it and enable repo-authored hook commands.
const JARVIS_HOOKS_LAUNCH = process.env.JARVIS_HOOKS;
if (existsSync('.env')) process.loadEnvFile('.env');

const OUTPUT_RESERVE_TOKENS = 16_384;

// First-slice budget defaults — HARD ceilings, plain constants (operational env knobs are a deferred
// follow-up, kept out to stay minimal). perGoalBudget is handed to every runGoal.
const PER_GOAL_ROUNDS = 8;
const MAX_TOTAL_TOKENS = 4_000_000;
// A per-goal token cap so a single goal can't overshoot the loop budget before the between-goals check
// notices (goal-loop's overBudget() blocks the goal once its own usage crosses this). Bounds the
// composite ceiling to cumulative + one perGoalBudget rather than cumulative + an 8-round goal.
const PER_GOAL_MAX_TOKENS = 1_000_000;
const MAX_WALL_CLOCK_MS = 2 * 60 * 60 * 1000; // 2h per invocation
const MAX_CONSECUTIVE_BLOCKED = 3;
const CNV_WINDOW = 3;
const CNV_THRESHOLD = 3;
const PER_ROUND_MAX_TURNS = 16;

const BUILDER_PROMPT = [
  '你是一个在终端里自主工作的编码助手,正在达成一个目标。',
  '用 read / write / grep / bash 工具推进(路径相对项目根)。危险或涉密操作会被权限闸门拦下或需用户批准。',
  '你认为目标已达成时,调用 update_goal(complete) 并结束本轮——harness 会独立重跑项目检查来验证;',
  '不要删改测试来凑绿(会被检测并拒绝)。如果卡住无法完成,调用 update_goal(blocked)。',
].join('\n');

/** Hand-to-human halt reasons — a `--resume` past one of these requires `--force`. */
const NEEDS_HUMAN: ReadonlySet<string> = new Set(['verifier-health', 'consecutive-blocked']);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const resume = argv.includes('--resume');
  const force = argv.includes('--force');
  const unattended = argv.includes('--unattended');
  const positional = argv.filter((a) => !a.startsWith('--'));

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
  // The provider captured the key; scrub it from the env so a goal builder's bash can't read it back.
  scrubProviderKeyFromEnv();
  const cwd = process.cwd();
  const shellPath = defaultShellPath();
  const loopsDir = join(cwd, 'data', 'loops');

  // ── Resolve the loop: a fresh queue from a file, or a replayed one to resume. ──
  let loopId: string;
  let objectives: string[];
  let contract: LoopContract;
  let loopPath: string;

  // Held in outer scope so the fresh/resume branches can both populate the runLoop call.
  let seedFinished: Set<number> | undefined;
  let seedOutcomes: ('verified' | 'rejected' | 'couldNotVerify')[] | undefined;
  let seedConsecutiveBlocked: number | undefined;
  let seedCumulativeTokens: number | undefined;

  if (resume) {
    const latest = await latestLoopPath(loopsDir);
    if (latest === null) {
      console.error('没有可恢复的 loop(data/loops/ 为空)。');
      process.exitCode = 1;
      return;
    }
    const replay = await loadLoop(latest);
    if (replay.contract === undefined || replay.id === undefined) {
      console.error(`loop 日志损坏或缺少 header: ${latest}`);
      process.exitCode = 1;
      return;
    }
    // The human checkpoint must hold even if the loop-halted record never flushed (a crash at the halt
    // boundary). Derive needs-human from the RECONSTRUCTED state, not only the durable reason: a re-folded
    // breaker at the ceiling, or a re-warmed cnv window at threshold, demands --force just as a recorded
    // verifier-health / consecutive-blocked halt does.
    const recentCnv = replay.outcomes.slice(-replay.contract.cnvWindow).filter((o) => o === 'couldNotVerify').length;
    const needsHuman =
      (replay.halted !== undefined && NEEDS_HUMAN.has(replay.halted)) ||
      replay.consecutiveBlocked >= replay.contract.maxConsecutiveBlocked ||
      recentCnv >= replay.contract.cnvThreshold;
    if (needsHuman && !force) {
      const why = replay.halted ?? (recentCnv >= replay.contract.cnvThreshold ? 'verifier-health' : 'consecutive-blocked');
      console.error(`该 loop 处于需人工检查状态(${why})。确认裁判/状态无误后,用 --resume --force 续跑。`);
      process.exitCode = 1;
      return;
    }
    loopId = replay.id;
    objectives = replay.objectives;
    contract = replay.contract;
    loopPath = latest;
    seedFinished = replay.finished;
    seedOutcomes = replay.outcomes;
    seedConsecutiveBlocked = replay.consecutiveBlocked;
    seedCumulativeTokens = replay.cumulativeTokens;
  } else {
    const file = positional[0];
    if (!file) {
      console.error('用法: npm run loop -- <objectives 文件>  (一行一个目标;# 注释与空行忽略)');
      process.exitCode = 1;
      return;
    }
    objectives = loadObjectives(file);
    if (objectives.length === 0) {
      console.error(`目标文件为空或不可读: ${file}`);
      process.exitCode = 1;
      return;
    }
    loopId = new Date().toISOString().replace(/[:.]/g, '-');
    contract = {
      maxGoals: objectives.length,
      maxTotalTokens: MAX_TOTAL_TOKENS,
      maxWallClockMs: MAX_WALL_CLOCK_MS,
      maxConsecutiveBlocked: MAX_CONSECUTIVE_BLOCKED,
      cnvWindow: CNV_WINDOW,
      cnvThreshold: CNV_THRESHOLD,
      perGoalBudget: { maxRounds: PER_GOAL_ROUNDS, maxTotalTokens: PER_GOAL_MAX_TOKENS },
    };
    loopPath = join(loopsDir, `${loopId}.jsonl`);
  }

  const loopStore = new FileLoopStore(loopPath);
  if (!resume) {
    await loopStore.writeCreated({ id: loopId, contract, objectives, createdAt: new Date().toISOString() });
  }

  // ── Shared, once: bus + render, context, gate (+ optional interactive approver), verifier provider. ──
  const bus = new InMemoryEventBus();
  let rstate = initialRenderState();
  bus.subscribe((e: Event) => {
    const { output, state } = renderEvent(rstate, e);
    rstate = state;
    if (output) process.stdout.write(output);
  });

  let rl: Interface | undefined;
  let approver: Approver | undefined;
  if (!unattended) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = rl;
    approver = async (req) => {
      // Show detailOf(req) so a network `vision` call is approved KNOWING which image leaves the
      // machine, not blind on tool name alone (codex review). Same detail the REPL surfaces.
      const answer = await new Promise<string>((resolve) =>
        ask.question(`\n批准 ${req.toolName}? ${req.reason}\n  ${detailOf(req)}\n  [a]llow once / [d]eny: `, resolve),
      );
      return answer.trim().toLowerCase().startsWith('a') ? 'allow-once' : 'deny';
    };
  }
  // --unattended → no approver → the gate fail-closes every `ask` to deny (honest boundary).
  const gate = new DefaultPermissionGate({ approver });
  const context = new DefaultContextManager({
    summarizer: provider,
    maxContextTokens: provider.capability.maxContextTokens,
    maxOutputTokens: OUTPUT_RESERVE_TOKENS,
  });

  const verifier = resolveVerifierConfig(process.env, config);
  const verifierProvider: ModelProvider | undefined = verifier.enabled
    ? createProvider(verifier.config).withThinking('off')
    : undefined;

  // shadow-git (opt-in via JARVIS_SHADOW_GIT): one side history under data/shadow for the WHOLE loop —
  // every goal's per-round snapshots accumulate into the same repo, so `npm run shadow -- log / restore`
  // audits/rolls back across the queue. Off by default (a run never silently creates the shadow repo);
  // best-effort when on (snapshot failures never touch verification). Constructed once and shared by every
  // runGoal: it is keyed only on cwd/gitDir and stateless between snapshots.
  const shadowGit = process.env.JARVIS_SHADOW_GIT
    ? new ShadowGit({ shellPath, cwd, gitDir: join(cwd, 'data', 'shadow') })
    : undefined;

  // Vision (Phase E multimodal): resolve once and build the tool a single time — it is STATELESS (its
  // run() reads per-call ctx), so the same instance is registered into every goal's fresh registry.
  // Opt-in via ARK_VISION_MODEL, like leg 3. capability=network → the gate routes it to `ask`: attended
  // the approver answers it, unattended (no approver) it fail-closes to deny. So even an unattended loop
  // never silently sends an image out — the builder's vision call blocks exactly like its write/bash.
  const vision = resolveVisionConfig(process.env, config);
  const visionTool = vision.enabled ? createVisionTool(createVisionComplete(vision.config)) : undefined;

  // Hooks (slice 1): opt-in via JARVIS_HOOKS (TRUSTED path). Built once, shared across the queue.
  // In-repo / malformed config is refused with a warning. Especially relevant unattended — a
  // PreToolUse hook is a fail-closed guardrail with no human in the loop.
  const { hooks, warning: hookWarning } = await resolveHooks({ hooksPath: JARVIS_HOOKS_LAUNCH, cwd, shellPath });
  if (hookWarning) console.error(`[hooks] ${hookWarning}`);

  console.log(`Jarvis-Agent · loop 模式 · ${safeInline(config.model)}`);
  console.log(`队列: ${objectives.length} 个目标${resume ? `(恢复,已完成 ${seedFinished?.size ?? 0})` : ''}`);
  console.log(`审批: ${unattended ? '无人值守(fail-closed,受闸操作自动拒绝)' : 'attended(交互批准)'}`);
  console.log(verifier.enabled ? `腿3: 独立裁判已启用(${safeInline(verifier.config.model)})` : `腿3: 未启用(${safeInline(verifier.reason)})`);
  console.log(
    vision.enabled
      ? `vision: 已启用(${safeInline(vision.config.model)}) —— builder 可看图(发图出网,受闸 ask;无人值守自动拒绝)`
      : `vision: 未启用(${vision.reason})`,
  );
  console.log(
    shadowGit
      ? 'shadow-git: 已启用 —— 每轮快照工作树到 data/shadow(跨整个队列累积),审计/回滚用 npm run shadow -- log / restore <sha>\n'
      : 'shadow-git: 未启用(设 JARVIS_SHADOW_GIT=1 开启改动审计 + 回滚)\n',
  );

  // runOne — the SOLE seam to runGoal. Per goal: NEW tools registry (registry.register throws on a
  // duplicate update_goal, so it can't be shared), fresh baseline, derived pinned (block-and-continue
  // on empty rather than exiting the process), own goal/session stores, then the UNCHANGED runGoal.
  const runOne = async (objective: string, goalId: string): Promise<GoalRunSummary> => {
    const tools = buildDefaultRegistry();
    tools.register(createBashTool());
    if (visionTool) tools.register(visionTool); // opt-in vision (network → gate ask / unattended deny)

    let pinned: PinnedRequirement[] = [];
    if (verifierProvider) {
      pinned = await derivePinnedRequirements(objective, provider);
      if (pinned.length === 0) {
        // Verifier on but no pinned list → decideVerdict makes `verified` unreachable, so running would
        // only burn budget to a block. Block this goal immediately and let the loop continue. No outcome
        // → not a verifier-health sample (the judge never ran).
        bus.emit({ type: 'goal_state', goalId, state: 'blocked' });
        return { state: 'blocked', rounds: 0 };
      }
    }

    const baseline = await snapshotBaseline(shellPath, cwd);
    const goalStore = new FileGoalStore(join(cwd, 'data', 'goals', `${goalId}.jsonl`));
    const sessionStore = new FileSessionStore(join(cwd, 'data', 'sessions', `${goalId}.jsonl`));
    await sessionStore.writeHeader({ id: goalId, model: config.model, cwd, startedAt: new Date().toISOString() });

    const result = await runGoal(
      { id: goalId, objective, sessionId: goalId, budget: contract.perGoalBudget, baseline, pinned },
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
        perRoundMaxTurns: PER_ROUND_MAX_TURNS,
        checkCommands: DEFAULT_CHECK_COMMANDS,
        verifierProvider,
        shadowGit,
      },
    );
    return { state: result.state, outcome: result.finalVerdict?.outcome, rounds: result.rounds };
  };

  // try/finally so a thrown goal run (provider/network/disk error from inside runOne→runGoal) still
  // CLOSES the readline — an open interface keeps stdin referenced and the event loop alive, so without
  // this the process would hang after the fatal error instead of exiting with the intended code.
  try {
    const result = await runLoop(
      { id: loopId, objectives, contract },
      {
        bus,
        loopStore,
        runOne,
        finished: seedFinished,
        outcomes: seedOutcomes,
        consecutiveBlocked: seedConsecutiveBlocked,
        cumulativeTokens: seedCumulativeTokens,
      },
    );
    console.log(
      `\n=== loop ${result.reason} · 本次 started=${result.started} completed=${result.completed} blocked=${result.blocked} ` +
        `· 累计 finished=${result.goalsFinished}/${objectives.length} tokens=${result.cumulativeTokens} ===`,
    );
    if (NEEDS_HUMAN.has(result.reason)) process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

/**
 * Read objectives from a file: one objective per line, `#` comments and blank lines skipped (mirrors
 * goal-cli's loadHeldOutCommands). Returns [] when missing/unreadable.
 */
function loadObjectives(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/** Snapshot the leg-2 baseline (current HEAD sha). Undefined when not a git repo (leg 2 inert). */
async function snapshotBaseline(shellPath: string, cwd: string): Promise<TestBaseline | undefined> {
  const res = await runCommand(shellPath, 'git rev-parse HEAD', cwd, 10_000, 1_000);
  if (res.code !== 0) return undefined;
  return { headSha: res.output.trim(), testFiles: [] };
}

main().catch((err: unknown) => {
  console.error('\n[loop] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
