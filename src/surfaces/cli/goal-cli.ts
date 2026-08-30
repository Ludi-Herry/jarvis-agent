/**
 * surfaces/cli/goal-cli — the `goal` entry point (Phase D, D4).
 *
 * A SEPARATE entry from the REPL (not folded into startRepl): one objective in, the GoalLoop drives
 * a builder agent toward it autonomously, the harness runs independent project/tamper checks plus
 * configured objective evidence, and the loop self-stops at complete / blocked. Tool side effects still pass the
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
  buildConfigPermissionPolicy,
  DefaultPermissionGate,
  FileSessionStore,
  InMemoryEventBus,
  NO_DYNAMIC_ADDENDUM,
  createSessionComposition,
  createEmergencyStopSignal,
  createWsl2UnshareSandboxRunner,
  type Approver,
  type Event,
} from '../../runtime/index.js';
import {
  DEFAULT_CHECK_COMMANDS,
  FileGoalStore,
  ShadowGit,
  derivePinnedRequirements,
  resolveHooks,
  runGoal,
  snapshotWorktreeStatus,
  updateGoalToolSchema,
  type PinnedRequirement,
  type TestBaseline,
} from '../../capabilities/index.js';
import type { ModelProvider } from '../../core/index.js';
import { safeInline } from './approval.js';
import { formatGoalTerminalGuidance } from './terminal-guidance.js';
import { createApprovalEventApprover, FileApprovalAuditStore } from './approval-events.js';
import { registerBuilderSandboxTools } from './builder-sandbox-tools.js';
import { extractConfigCliOptions } from './config-options.js';
import {
  appendConfigPermissionBoundary,
  loadCliConfig,
  reportConfigWarnings,
} from './config.js';
import { parseGoalArgs } from './goal-args.js';
import { createInteractiveApprover, readlineApproverIo } from './interactive-approver.js';
import { loadGoalCliTrustedRequirements } from './goal-trusted-requirements.js';
import { initialRenderState, renderEvent } from './render.js';
import { CLI_EXIT } from './exit-codes.js';
import { decideGitTrust } from './git-trust.js';
import { JARVIS_VERSION } from './package-info.js';
import { createProcessInterruptSignal, persistInterruptedGoal } from './process-interrupt.js';
import {
  createProcessAgentEventWriter,
  goalRunFinished,
  isHeadlessAgentEventMode,
  scrubHeadlessAgentEventEnv,
} from './headless-events.js';

// Capture BEFORE the runtime .env load: a key present here came from the shell LAUNCH env (it is in
// /proc/<pid>/environ on Linux); a key that appears only after loadEnvFile came from .env (runtime-
// injected after execve, never in /proc). The guard (assertKeyNotInLaunchEnv) uses this for /proc safety.
const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;
// JARVIS_HOOKS is a TRUSTED, launch-controlled source: capture BEFORE .env so an in-repo .env can't
// set it and enable repo-authored hook commands.
const JARVIS_HOOKS_LAUNCH = process.env.JARVIS_HOOKS;
// Goal-setter requirements are trusted launch input; repo-authored .env cannot select verifier routes.
const JARVIS_GOAL_SETTER_REQUIREMENTS_LAUNCH = process.env.JARVIS_GOAL_SETTER_REQUIREMENTS_FILE;
if (existsSync('.env')) process.loadEnvFile('.env');

const OUTPUT_RESERVE_TOKENS = 16_384;
const GOAL_MAX_WALL_CLOCK_MS = 15 * 60 * 1000;

const BUILDER_PROMPT = [
  '你是一个在终端里自主工作的编码助手,正在达成一个目标。',
  '用 read / write / grep / bash 工具推进(路径相对项目根)。危险或涉密操作会被权限闸门拦下或需用户批准。',
  '修改已有文件前先 read,把返回的 version 传给 write.expectedVersion; 新建文件使用 createOnly:true。',
  '可调用 sandboxed_check,用 check=typecheck|lint|test|build 在 OS sandbox 里跑项目检查; 根据 stdout/stderr 继续修失败。',
  '可调用 browser_smoke,用 profile=static-dist 在 OS sandbox 里检查 dist/index.html 是否能被预装浏览器打开; 结果只作为修复反馈。',
  '你认为目标已达成时,调用 update_goal(complete) 并结束本轮——harness 会独立重跑项目检查来验证;',
  '不要删改测试来凑绿(会被检测并拒绝)。如果卡住无法完成,调用 update_goal(blocked)。',
].join('\n');

async function main(): Promise<void> {
  const headless = isHeadlessAgentEventMode();
  let configCli;
  let args;
  try {
    configCli = extractConfigCliOptions(process.argv.slice(2));
    args = parseGoalArgs(configCli.argv);
  } catch (err) {
    console.error(safeInline(err instanceof Error ? err.message : String(err)));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  const { objective } = args;
  if (objective === '') {
    console.error('用法: npm run goal -- [--allow-no-git] "<objective>"');
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }

  const cwd = process.cwd();
  let effectiveConfig;
  try {
    effectiveConfig = await loadCliConfig({ cwd, options: configCli.options });
    reportConfigWarnings(effectiveConfig);
  } catch (err) {
    console.error(`[config] ${safeInline(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = CLI_EXIT.STATE_CORRUPT;
    return;
  }

  let config;
  try {
    assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV); // /proc safety: refuse a launch-env key on Linux
    config = loadDoubaoConfig(process.env, {
      model: effectiveConfig.model,
      baseURL: effectiveConfig.baseURL,
    });
  } catch (err) {
    console.error(safeInline(err instanceof Error ? err.message : String(err)));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }

  const builderPrompt = appendConfigPermissionBoundary(BUILDER_PROMPT, effectiveConfig);
  const provider = createProvider(config).withThinking('off');
  // The provider captured the key; remove it from the env so the goal builder's bash can't read it back
  // via /proc/<pid>/environ (Linux). Keeps ARK_VERIFIER_MODEL (read by resolveVerifierConfig below).
  scrubProviderKeyFromEnv();
  const shellPath = defaultShellPath();
  const emergencyStop = createEmergencyStopSignal({
    cwd,
    onStop: (state) => {
      console.error(`\n[emergency-stop] ${safeInline(state.record?.reason ?? state.error ?? 'stop requested')}`);
    },
  });
  const sandboxCheckPlanPath = process.env.JARVIS_SANDBOX_CHECKS_FILE?.trim();
  delete process.env.JARVIS_SANDBOX_CHECKS_FILE;
  const goalSetterRequirementsPath = JARVIS_GOAL_SETTER_REQUIREMENTS_LAUNCH?.trim();
  delete process.env.JARVIS_GOAL_SETTER_REQUIREMENTS_FILE;
  const forbiddenRequirementRoots = Array.from(new Set([cwd, findWorkspaceRoot(cwd)]));

  let trustedRequirements;
  try {
    trustedRequirements = await loadGoalCliTrustedRequirements({
      sandboxCheckPlanPath,
      goalSetterRequirementsPath,
      cwd,
      forbiddenRoots: forbiddenRequirementRoots,
      readText: async (p) => readFile(p, 'utf8').catch(() => null),
      realpath: async (p) => realpath(p).catch(() => null),
    });
  } catch (err) {
    console.error(`[trusted requirements] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  const sandboxCheckPlan = trustedRequirements.kind === 'sandbox-checks' ? trustedRequirements.plan : undefined;
  const goalSetterRequirements = trustedRequirements.kind === 'goal-setter-requirements' ? trustedRequirements.plan : undefined;

  const tools = buildDefaultRegistry();
  tools.register(createBashTool()); // safe to register: every call runs behind the gate below
  const builderSandboxRunner = createWsl2UnshareSandboxRunner();
  registerBuilderSandboxTools(tools, builderSandboxRunner);
  // Vision (Phase E multimodal): mirror the REPL — register `vision` ONLY when ARK_VISION_MODEL names a
  // vision model (opt-in, like leg 3). capability=network → the gate routes the call to `ask`, which the
  // goal approver below answers (attended). With no approver it would fail-close to deny — no silent
  // image egress. Reuses the in-memory config key (resolveVisionConfig reads only ARK_VISION_MODEL from
  // the env, which scrubProviderKeyFromEnv above left intact — it is not a secret).
  const vision = resolveVisionConfig(process.env, config);
  if (vision.enabled) tools.register(createVisionTool(createVisionComplete(vision.config)));

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionId = `goal-${id}`;
  const agentEvents = createProcessAgentEventWriter({
    invocationId: id,
    defaultSessionId: sessionId,
    root: 'goal',
    cwd,
  });
  if (headless) scrubHeadlessAgentEventEnv();
  const bus = new InMemoryEventBus(agentEvents === undefined ? undefined : (err) => { throw err; });
  if (agentEvents !== undefined) bus.subscribe((event) => agentEvents.accept(event));
  let rstate = initialRenderState();
  bus.subscribe((e: Event) => {
    const { output, state } = renderEvent(rstate, e);
    rstate = state;
    if (output) process.stdout.write(output);
  });

  const rl = headless ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  // The same interactive approver the loop uses (interactive-approver.ts): renders detailOf +
  // [a]/[s]/[d] (so a network `vision` call is approved KNOWING which image leaves the machine) and
  // now exposes `s` (allow-session) — command-scoped for bash, so approving a shell command once
  // stops re-asking that exact command for the rest of this goal run. Blank/unrecognized re-asks;
  // EOF or exhausted retries → deny (fail-closed).
  const interactiveApprover: Approver = headless
    ? async () => 'deny'
    : createInteractiveApprover(readlineApproverIo(rl!));
  const approver: Approver = createApprovalEventApprover({
    approver: interactiveApprover,
    bus,
    store: new FileApprovalAuditStore(join(cwd, 'data', 'approvals', `${sessionId}.jsonl`)),
    sessionId,
  });
  const gate = new DefaultPermissionGate({
    approver,
    policy: buildConfigPermissionPolicy(effectiveConfig),
  });
  const context = new DefaultContextManager({
    summarizer: provider,
    maxContextTokens: provider.capability.maxContextTokens,
    maxOutputTokens: OUTPUT_RESERVE_TOKENS,
  });

  const baseline = await snapshotBaseline(shellPath, cwd, emergencyStop.signal);
  const gitTrust = decideGitTrust(baseline !== undefined, args.allowNoGit);
  if (gitTrust === 'reject') {
    console.error(
      '[goal] No usable Git baseline was found. Autonomous goal mode requires Git for tamper detection. ' +
        'Initialize/commit the repository, or rerun with --allow-no-git to accept a checks-only result.',
    );
    rl?.close();
    emergencyStop.dispose();
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  if (gitTrust === 'checks-only') {
    console.error('[goal] WARNING: --allow-no-git enabled; verified completion is disabled and checks-only is the highest possible outcome.');
  }
  const worktreeBaseline = await snapshotWorktreeStatus(shellPath, cwd, emergencyStop.signal);
  const goalLogPath = join(cwd, 'data', 'goals', `${id}.jsonl`);
  const sessionLogPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
  const goalStore = new FileGoalStore(goalLogPath);
  const sessionStore = new FileSessionStore(sessionLogPath);
  await sessionStore.writeHeader({
    id: sessionId,
    model: config.model,
    cwd,
    startedAt: new Date().toISOString(),
    composition: createSessionComposition({
      root: 'goal',
      runtimeVersion: JARVIS_VERSION,
      permissionMode: headless ? 'unattended' : 'interactive',
      toolSchemas: [...tools.schemasForModel(), updateGoalToolSchema()],
      systemPrompt: builderPrompt,
      dynamicAddendum: NO_DYNAMIC_ADDENDUM,
    }),
  });
  agentEvents?.sessionStarted({ sessionId, resumed: false, model: config.model });

  // Leg 3 (independent LLM judge): enabled only when ARK_VERIFIER_MODEL names a DIFFERENT model. When
  // enabled, derive the pinned requirement list once (builder model) and fail closed if it comes back
  // empty — an empty list makes `verified` unreachable, so starting would only burn budget to a block.
  let verifierProvider: ModelProvider | undefined;
  let pinned: PinnedRequirement[] = [];
  const verifier = resolveVerifierConfig(process.env, config);
  const goalSetterNeedsLlm =
    goalSetterRequirements !== undefined && [...goalSetterRequirements.routes.values()].some((route) => route === 'llm');
  if (goalSetterRequirements) {
    pinned = goalSetterRequirements.pinned;
    if (goalSetterNeedsLlm && verifier.enabled) verifierProvider = createProvider(verifier.config).withThinking('off');
  } else if (sandboxCheckPlan) {
    pinned = sandboxCheckPlan.pinned;
  } else if (verifier.enabled) {
    verifierProvider = createProvider(verifier.config).withThinking('off');
    pinned = await derivePinnedRequirements(objective, provider, emergencyStop.signal);
    if (emergencyStop.signal.aborted) {
      console.error('[goal] emergency stop requested before builder started; no new agent action will run.');
      rl?.close();
      emergencyStop.dispose();
      process.exitCode = CLI_EXIT.INTERRUPTED;
      agentEvents?.runFinished({
        status: 'interrupted',
        exitCode: CLI_EXIT.INTERRUPTED,
        completion: { granted: false, authority: 'none' },
      });
      return;
    }
    if (pinned.length === 0) {
      console.error(
        '[goal] 腿3 已启用但未能从目标推导出验收清单(pinned requirements 为空)。\n' +
          '没有可逐条打分的清单,verified 不可达——拒绝启动,避免空烧预算。请把目标写得更具体后重试。',
      );
      rl?.close();
      emergencyStop.dispose();
      process.exitCode = CLI_EXIT.UNVERIFIED;
      agentEvents?.runFinished({
        status: 'unverified',
        exitCode: CLI_EXIT.UNVERIFIED,
        completion: { granted: false, authority: 'none' },
      });
      return;
    }
  }

  // Held-out leg: secret hidden-assertion commands from a FILE (kept off the command line / shell
  // history). Absent → the leg is explicitly declared absent (a known weaker-confidence state).
  const heldOutCommands = [
    ...loadHeldOutCommands(),
    ...(goalSetterRequirements?.heldOutCommands ?? []),
  ];
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
  console.log(
    baseline
      ? `验收: 四关卡 + 测试篡改检测(baseline ${baseline.headSha.slice(0, 8)})`
      : '验收: checks-only(无 Git baseline,不能授权 verified)',
  );
  console.log(
    worktreeBaseline
      ? `worktree: ${args.failOnWorktreeChange ? 'forbid changes' : 'audit changes'} (${safeInline(worktreeBaseline.command)})`
      : 'worktree: status audit unavailable',
  );
  console.log(
    heldOutCommands.length > 0
      ? `held-out: 已配置 ${heldOutCommands.length} 条隐藏校验(builder 看不到)`
      : 'held-out: 未配置 —— 默认档只确认项目检查通过,目标达成需人工复核或启用腿3/held-out/trusted requirements',
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
  if (goalSetterRequirements) {
    console.log(
      `goal-setter requirements: enabled; routes=${formatGoalSetterRouteCounts(goalSetterRequirements.routes)}; LLM=${goalSetterNeedsLlm ? (verifier.enabled ? safeInline(verifier.config.model) : `unavailable:${safeInline(verifier.reason)}`) : 'not-needed'}`,
    );
  }
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

  const processInterrupt = createProcessInterruptSignal({
    ...(rl === undefined ? {} : { input: rl }),
    onInterrupt: (signal) => {
      console.error(`\n[goal] ${signal} received; stopping the active run...`);
      rl?.close();
    },
  });
  const goalSignal = AbortSignal.any([emergencyStop.signal, processInterrupt.signal]);
  let result;
  const sandboxedRequirementCommands = goalSetterRequirements
    ? goalSetterRequirements.commands.length > 0
      ? goalSetterRequirements.commands
      : undefined
    : sandboxCheckPlan?.commands;
  try {
    await runAdvisoryHook(hooks?.sessionStart);
    result = await runGoal(
      { id, objective, sessionId, budget: { maxRounds: 8, maxWallClockMs: GOAL_MAX_WALL_CLOCK_MS }, baseline, worktreeBaseline, pinned },
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
        builderSystemPrompt: builderPrompt,
        perRoundMaxTurns: 16,
        checkCommands: DEFAULT_CHECK_COMMANDS,
        heldOutCommands: heldOutCommands.length > 0 ? heldOutCommands : undefined,
        worktreeChangePolicy: args.failOnWorktreeChange ? 'forbid' : 'audit',
        verifierProvider,
        sandboxedRequirementCommands,
        goalSetterRequirementRoutes: goalSetterRequirements?.routes,
        sandboxRunner: sandboxedRequirementCommands && sandboxedRequirementCommands.length > 0 ? builderSandboxRunner : undefined,
        shadowGit,
        signal: goalSignal,
      },
    );
  } catch (err) {
    if (processInterrupt.signal.aborted) {
      const signal = processInterrupt.received() ?? 'SIGINT';
      const goalInitialized = existsSync(goalLogPath);
      if (goalInitialized) await persistInterruptedGoal({ goalId: id, store: goalStore, bus });
      console.error(
        goalInitialized
          ? `[goal] interrupted by ${signal}; goal recorded as blocked and JSONL logs were preserved.`
          : `[goal] interrupted by ${signal} before goal state initialization; existing JSONL logs were preserved.`,
      );
      process.exitCode = CLI_EXIT.INTERRUPTED;
      agentEvents?.runFinished({
        status: 'interrupted',
        exitCode: CLI_EXIT.INTERRUPTED,
        completion: { granted: false, authority: 'none' },
      });
      return;
    }
    if (emergencyStop.signal.aborted) {
      bus.emit({ type: 'halt', reason: 'emergency-stop' });
      console.error('\n[goal] emergency stop requested; run aborted and JSONL logs were left in place.');
      process.exitCode = CLI_EXIT.INTERRUPTED;
      agentEvents?.runFinished({
        status: 'interrupted',
        exitCode: CLI_EXIT.INTERRUPTED,
        completion: { granted: false, authority: 'none' },
      });
      return;
    }
    agentEvents?.runFinished({
      status: 'failed',
      exitCode: CLI_EXIT.RUNTIME,
      completion: { granted: false, authority: 'none' },
    });
    throw err;
  } finally {
    processInterrupt.dispose();
    emergencyStop.dispose();
    await runAdvisoryHook(hooks?.sessionEnd);
    rl?.close();
  }

  const verdict = result.finalVerdict?.outcome ?? '—';
  const displayedVerdict = verdict === 'checksOnly' ? 'checks-only' : verdict;
  console.log(`\n=== goal ${result.state} (rounds=${result.rounds}, verdict=${displayedVerdict}) ===`);
  if (verdict === 'checksOnly') {
    console.log(
      '[goal] 项目检查已通过，目标完成仍缺少可信证据。请人工复核，或启用 ARK_VERIFIER_MODEL、JARVIS_HELDOUT_CHECKS_FILE / trusted requirements。',
    );
  }
  if (result.state !== 'complete') {
    for (const line of formatGoalTerminalGuidance({
      state: result.state,
      verdict: displayedVerdict,
      ...(result.haltReason === undefined ? {} : { haltReason: safeInline(result.haltReason) }),
      goalLogPath: safeInline(goalLogPath),
      sessionLogPath: safeInline(sessionLogPath),
    })) console.log(line);
  }
  const terminal = goalRunFinished({
    state: result.state,
    outcome: result.finalVerdict?.outcome,
    haltReason: result.haltReason,
  });
  process.exitCode = terminal.exitCode;
  agentEvents?.runFinished(terminal);
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

function formatGoalSetterRouteCounts(routes: ReadonlyMap<string, string>): string {
  return `sandbox-command:${countRoutes(routes, 'sandbox-command')},llm:${countRoutes(routes, 'llm')},human:${countRoutes(routes, 'human')}`;
}

function countRoutes(routes: ReadonlyMap<string, string>, route: string): number {
  let count = 0;
  for (const value of routes.values()) {
    if (value === route) count++;
  }
  return count;
}

/** Snapshot the leg-2 baseline. Production callers reject absence unless checks-only is explicit. */
async function snapshotBaseline(shellPath: string, cwd: string, signal?: AbortSignal): Promise<TestBaseline | undefined> {
  const res = await runCommand(shellPath, 'git rev-parse HEAD', cwd, 10_000, 1_000, signal);
  if (res.code !== 0) return undefined;
  return { headSha: res.output.trim(), testFiles: [] };
}

main().catch((err: unknown) => {
  console.error('\n[goal] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = CLI_EXIT.RUNTIME;
});

async function runAdvisoryHook(fn: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await fn?.();
  } catch {
    // session hooks are notification-only
  }
}
