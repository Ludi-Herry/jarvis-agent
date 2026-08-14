/**
 * surfaces/cli/loop-cli - the `loop` entry point (Phase E).
 *
 * One objectives FILE in (one objective per line), the LoopRunner drains the queue: each objective is
 * driven to a terminal state by the UNCHANGED runGoal (independent verification), the loop records
 * orchestration to data/loops/<id>.jsonl, accumulates cross-goal verifier health, and self-stops at a
 * numeric stop condition. Crash/budget-stopped runs resume with `--resume`; cwd loop logs only provide
 * goalIds to recheck, then runGoal records fresh finishes. The loop has ZERO completion authority:
 * runGoal alone decides `complete`.
 *
 * Approver modes (the honest sandbox boundary): `--attended` (default) uses an interactive readline
 * approver, so a human approves each gated write/bash across the queue. `--unattended` injects NO
 * approver. In the plain loop, every `ask` still fail-closes to deny. In `--unattended --parallel`,
 * each goal gate auto-allows only the built-in `write` tool whose effective target stays inside that
 * goal's worktree; bash, vision, unknown write-like tools, secrets, git metadata, and path escapes
 * still fail closed. Host integration stays manual through `loop:finalize --merge`.
 *
 * Vision (opt-in via ARK_VISION_MODEL) is a BUILDER tool only, with capability=network (it sends a
 * local image to a remote VLM). The gate routes it to `ask` like write/bash: attended it is approved,
 * unattended it fail-closes to deny: no silent image egress even in an unattended loop. The read-only
 * leg-3 judge deliberately has NO vision (network would break "an injected judge cannot act"); a visual
 * requirement the judge cannot confirm by reading files routes to couldNotVerify for a human.
 *
 * Verification surface (honest): each goal is verified by the UNCHANGED runGoal = deterministic leg 1
 * (re-run checks) + leg 2 (tamper). Leg 3 (the LLM judge) runs only when `ARK_VERIFIER_MODEL` names a
 * different model, and ONLY then can a goal return couldNotVerify, which is the sole input to the
 * cross-goal VerifierHealthMonitor. So the headline monitor is INERT in the default `npm run loop`
 * (correctly: no shared judge, no judge-health signal) and LIVE once ARK_VERIFIER_MODEL is set. The
 * held-out hidden-assertion commands can be supplied per objective through the trusted
 * --goal-setter-requirements-map. They stay out of cwd logs/builder context and flow only into runGoal.
 *
 * Run:  npm run loop -- <objectives-file>            (needs ARK_API_KEY in .env)
 *       npm run loop -- <objectives-file> --unattended
 *       ARK_VERIFIER_MODEL=<id> npm run loop -- <objectives-file>   (enable leg 3 + the health monitor)
 *       npm run resume:loop -- --verifier-map <trusted-json> --hook-map <trusted-json>
 *         (use {"goals":[]} for deterministic-only verifier and no per-goal hook overrides)
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
import {
  DefaultPermissionGate,
  FileSessionStore,
  InMemoryEventBus,
  NO_DYNAMIC_ADDENDUM,
  SessionCompositionMismatchError,
  createSessionComposition,
  createEmergencyStopSignal,
  createWsl2UnshareSandboxRunner,
  type Approver,
  type Event,
} from '../../runtime/index.js';
import {
  DEFAULT_CHECK_COMMANDS,
  FileGoalStore,
  FileLoopStore,
  ShadowGit,
  assertResumeHookMapMatches,
  assertResumeGoalSetterRequirementsMatch,
  assertResumeSandboxCheckMapMatches,
  assertResumeVerifierMapMatches,
  assertWorktreeRootOutsideCwd,
  buildLoopGoalSetterRequirementsPlan,
  buildLoopHookPlan,
  buildLoopSandboxCheckPlan,
  buildLoopVerifierPlan,
  createGoalWorktree,
  derivePinnedRequirements,
  latestLoopPath,
  loadLoopGoalSetterRequirementsMap,
  loadLoopHookMap,
  loadLoopSandboxCheckMap,
  loadLoopVerifierMap,
  loadLoop,
  loopWorktreeRoot,
  resolveExistingGoalWorktree,
  resolveHooks,
  runGoal,
  runLoop,
  runParallelLoop,
  snapshotWorktreeStatus,
  updateGoalToolSchema,
  type LoadedLoopVerifierMap,
  type LoadedLoopHookMap,
  type LoadedLoopSandboxCheckMap,
  type LoadedLoopGoalSetterRequirementsMap,
  type LoopContract,
  type ParallelGoalRunSummary,
  type LoopVerifierDecision,
  type PinnedRequirement,
  type TestBaseline,
  type VerifierOutcomeSample,
  type VerdictOutcome,
} from '../../capabilities/index.js';
import type { ModelProvider } from '../../core/index.js';
import { safeInline } from './approval.js';
import { formatLoopTerminalGuidance } from './terminal-guidance.js';
import { createApprovalEventApprover, FileApprovalAuditStore } from './approval-events.js';
import { registerBuilderSandboxTools } from './builder-sandbox-tools.js';
import { createInteractiveApprover, readlineApproverIo } from './interactive-approver.js';
import { parseLoopArgs } from './loop-args.js';
import { assertParallelHooksCompatible } from './loop-guards.js';
import { createGoalHookResolver, preloadGoalHookOverrides } from './loop-hooks.js';
import { formatLoopCliError, loadLoopGoalResume, type LoadedLoopGoalResume } from './loop-resume.js';
import { initialRenderState, renderEvent } from './render.js';
import { CLI_EXIT, exitCodeForLoop } from './exit-codes.js';
import { decideGitTrust } from './git-trust.js';
import { JARVIS_VERSION } from './package-info.js';

// Capture BEFORE the runtime .env load (see goal-cli): a key here came from the shell LAUNCH env
// (in /proc on Linux); the guard refuses it so the provider key only ever arrives via .env.
const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;
// JARVIS_HOOKS is a TRUSTED, launch-controlled source: capture BEFORE .env so an in-repo .env can't
// set it and enable repo-authored hook commands.
const JARVIS_HOOKS_LAUNCH = process.env.JARVIS_HOOKS;
if (existsSync('.env')) process.loadEnvFile('.env');

const OUTPUT_RESERVE_TOKENS = 16_384;

// First-slice budget defaults: HARD ceilings, plain constants (operational env knobs are a deferred
// follow-up, kept out to stay minimal). perGoalBudget is handed to every runGoal.
const PER_GOAL_ROUNDS = 8;
const MAX_TOTAL_TOKENS = 4_000_000;
// A per-goal token cap so a single goal can't overshoot the loop budget before the between-goals check
// notices (goal-loop's overBudget() blocks the goal once its own usage crosses this). Bounds the
// composite ceiling to cumulative + one perGoalBudget rather than cumulative + an 8-round goal.
const PER_GOAL_MAX_TOKENS = 1_000_000;
const PER_GOAL_MAX_WALL_CLOCK_MS = 15 * 60 * 1000;
const MAX_WALL_CLOCK_MS = 2 * 60 * 60 * 1000; // 2h per invocation
const MAX_CONSECUTIVE_BLOCKED = 3;
const CNV_WINDOW = 3;
const CNV_THRESHOLD = 3;
const PER_ROUND_MAX_TURNS = 16;

const BUILDER_PROMPT = [
  'You are an autonomous coding assistant working in a terminal to complete one goal.',
  'Use the read / write / grep / bash tools to make progress. Paths are relative to the project root. Dangerous or secret-touching actions may be blocked or require approval.',
  'Read an existing file before changing it and pass the returned version as write.expectedVersion. Use createOnly:true for a new path.',
  'You may call sandboxed_check with check=typecheck|lint|test|build to run project checks inside an OS sandbox. Use its stdout/stderr to keep fixing failures.',
  'You may call browser_smoke with profile=static-dist to open dist/index.html with a preinstalled browser inside the OS sandbox. Use the result as feedback only.',
  'When you believe the goal is complete, call update_goal(complete) and end the round; the harness will independently rerun project checks to verify it.',
  'Do not weaken or delete tests to get green; that will be detected and rejected. If you are stuck, call update_goal(blocked).',
].join('\n');

/** Hand-to-human halt reasons. A `--resume` past one of these requires `--force`. */
const NEEDS_HUMAN: ReadonlySet<string> = new Set(['verifier-health', 'consecutive-blocked', 'blocked-goals']);

async function main(): Promise<void> {
  let args;
  try {
    args = parseLoopArgs(process.argv.slice(2));
  } catch (err) {
    console.error(formatLoopCliError('', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  const {
    resume,
    force,
    unattended,
    noVerifierMap,
    allowNoGit,
    positional,
    verifierMapPath,
    hookMapPath,
    sandboxCheckMapPath,
    goalSetterRequirementsMapPath,
    parallel,
    worktreeRootPath,
    failOnWorktreeChange,
  } = args;
  const parallelMode = parallel > 1;
  if (noVerifierMap) {
    console.error('--no-verifier-map is unsafe for resume; use --verifier-map <trusted empty map>');
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }

  let config;
  try {
    assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV); // /proc safety: refuse a launch-env key on Linux
    config = loadDoubaoConfig();
  } catch (err) {
    console.error(formatLoopCliError('', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }

  const provider = createProvider(config).withThinking('off');
  // The provider captured the key; scrub it from the env so a goal builder's bash can't read it back.
  scrubProviderKeyFromEnv();
  const cwd = process.cwd();
  const shellPath = defaultShellPath();
  const loopsDir = join(cwd, 'data', 'loops');
  const worktreeBaseRoot = worktreeRootPath ?? join(homedir(), '.jarvis', 'worktrees', basename(cwd));
  const forbiddenSandboxCheckMapRoots = Array.from(
    new Set([cwd, findWorkspaceRoot(cwd), ...(parallelMode ? [worktreeBaseRoot] : [])]),
  );
  const repositoryBaseline = await snapshotBaseline(shellPath, cwd);
  const gitTrust = decideGitTrust(repositoryBaseline !== undefined, allowNoGit);
  if (gitTrust === 'reject') {
    console.error(
      '[loop] No usable Git baseline was found. Autonomous loop mode requires Git for tamper detection. ' +
        'Initialize/commit the repository, or rerun a serial loop with --allow-no-git to accept checks-only results.',
    );
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  if (gitTrust === 'checks-only') {
    console.error('[loop] WARNING: --allow-no-git enabled; verified completion is disabled and checks-only is the highest possible outcome.');
  }

  let verifierMap: LoadedLoopVerifierMap | undefined;
  if (verifierMapPath !== undefined) {
    try {
      verifierMap = await loadLoopVerifierMap({
        path: verifierMapPath,
        cwd,
        readText: async (p) => readFile(p, 'utf8').catch(() => null),
        realpath: async (p) => realpath(p).catch(() => null),
      });
    } catch (err) {
      console.error(formatLoopCliError('[loop verifier]', err));
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }
  }

  let hookMap: LoadedLoopHookMap | undefined;
  if (hookMapPath !== undefined) {
    try {
      hookMap = await loadLoopHookMap({
        path: hookMapPath,
        cwd,
        readText: async (p) => readFile(p, 'utf8').catch(() => null),
        realpath: async (p) => realpath(p).catch(() => null),
      });
    } catch (err) {
      console.error(formatLoopCliError('[loop hooks]', err));
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }
  }

  let sandboxCheckMap: LoadedLoopSandboxCheckMap | undefined;
  if (sandboxCheckMapPath !== undefined) {
    try {
      sandboxCheckMap = await loadLoopSandboxCheckMap({
        path: sandboxCheckMapPath,
        cwd,
        forbiddenRoots: forbiddenSandboxCheckMapRoots,
        readText: async (p) => readFile(p, 'utf8').catch(() => null),
        realpath: async (p) => realpath(p).catch(() => null),
      });
    } catch (err) {
      console.error(formatLoopCliError('[loop sandbox checks]', err));
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }
  }

  let goalSetterRequirementsMap: LoadedLoopGoalSetterRequirementsMap | undefined;
  if (goalSetterRequirementsMapPath !== undefined) {
    try {
      goalSetterRequirementsMap = await loadLoopGoalSetterRequirementsMap({
        path: goalSetterRequirementsMapPath,
        cwd,
        forbiddenRoots: forbiddenSandboxCheckMapRoots,
        readText: async (p) => readFile(p, 'utf8').catch(() => null),
        realpath: async (p) => realpath(p).catch(() => null),
      });
    } catch (err) {
      console.error(formatLoopCliError('[loop goal-setter requirements]', err));
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }
  }

  // Resolve the loop: a fresh queue from a file, or a replayed one to resume.
  let loopId: string;
  let objectives: string[];
  let contract: LoopContract;
  let loopPath: string;

  // Held in outer scope so the fresh/resume branches can both populate the runLoop call.
  let seedFinished: Set<number> | undefined;
  let seedOutcomes: Array<VerdictOutcome | VerifierOutcomeSample> | undefined;
  let seedInFlight: Map<number, string> | undefined;
  let seedConsecutiveBlocked: number | undefined;
  let seedCumulativeTokens: number | undefined;
  let seedHalted: string | undefined;
  let replayVerifierMapPath: string | undefined;
  let replayHookMapPath: string | undefined;
  let replaySandboxCheckMapPath: string | undefined;
  let replayGoalSetterRequirementsMapPath: string | undefined;
  let replayGoalSetterRequirementsMapHash: string | undefined;

  if (resume) {
    const latest = await latestLoopPath(loopsDir);
    if (latest === null) {
      console.error('No resumable loop found (data/loops/ is empty).');
      process.exitCode = CLI_EXIT.NEEDS_HUMAN;
      return;
    }
    const replay = await loadLoop(latest);
    if (replay.contract === undefined || replay.id === undefined) {
      console.error(`loop 日志损坏或缺少 header: ${safeInline(latest)}`);
      process.exitCode = CLI_EXIT.STATE_CORRUPT;
      return;
    }
    loopId = replay.id;
    objectives = replay.objectives;
    contract = replay.contract;
    loopPath = latest;
    replayVerifierMapPath = replay.verifierMapPath;
    replayHookMapPath = replay.hookMapPath;
    replaySandboxCheckMapPath = replay.sandboxCheckMapPath;
    replayGoalSetterRequirementsMapPath = replay.goalSetterRequirementsMapPath;
    replayGoalSetterRequirementsMapHash = replay.goalSetterRequirementsMapHash;
    seedFinished = replay.finished;
    seedOutcomes = replay.outcomes;
    seedInFlight = replay.inFlight;
    seedConsecutiveBlocked = replay.consecutiveBlocked;
    seedCumulativeTokens = replay.cumulativeTokens;
    seedHalted = replay.halted;
  } else {
    const file = positional[0];
    if (!file) {
      console.error('Usage: npm run loop -- <objectives-file>  (one objective per line; # comments and blank lines are ignored)');
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }
    objectives = loadObjectives(file);
    if (objectives.length === 0) {
      console.error(`objectives file is empty or unreadable: ${safeInline(file)}`);
      process.exitCode = CLI_EXIT.USAGE;
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
      perGoalBudget: {
        maxRounds: PER_GOAL_ROUNDS,
        maxTotalTokens: PER_GOAL_MAX_TOKENS,
        maxWallClockMs: PER_GOAL_MAX_WALL_CLOCK_MS,
      },
    };
    loopPath = join(loopsDir, `${loopId}.jsonl`);
  }

  try {
    if (resume) assertResumeVerifierMapMatches(replayVerifierMapPath, verifierMap?.path, noVerifierMap);
  } catch (err) {
    console.error(formatLoopCliError('[loop verifier]', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  try {
    if (resume) assertResumeHookMapMatches(replayHookMapPath, hookMap?.path);
  } catch (err) {
    console.error(formatLoopCliError('[loop hooks]', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  try {
    if (resume) assertResumeSandboxCheckMapMatches(replaySandboxCheckMapPath, sandboxCheckMap?.path);
  } catch (err) {
    console.error(formatLoopCliError('[loop sandbox checks]', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  try {
    if (resume) {
      assertResumeGoalSetterRequirementsMatch(
        replayGoalSetterRequirementsMapPath === undefined && replayGoalSetterRequirementsMapHash === undefined
          ? undefined
          : {
              path: replayGoalSetterRequirementsMapPath ?? '(missing path)',
              hash: replayGoalSetterRequirementsMapHash ?? '(missing hash)',
            },
        goalSetterRequirementsMap,
      );
    }
  } catch (err) {
    console.error(formatLoopCliError('[loop goal-setter requirements]', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }

  const verifier = resolveVerifierConfig(process.env, config);
  let verifierPlan;
  let hookPlan;
  let sandboxCheckPlan;
  let goalSetterRequirementsPlan;
  try {
    verifierPlan = buildLoopVerifierPlan({
      objectivesCount: objectives.length,
      builderConfig: config,
      globalVerifier: verifier,
      map: verifierMap,
    });
    hookPlan = buildLoopHookPlan({
      objectivesCount: objectives.length,
      map: hookMap,
    });
    sandboxCheckPlan = buildLoopSandboxCheckPlan({
      objectivesCount: objectives.length,
      map: sandboxCheckMap,
    });
    goalSetterRequirementsPlan = buildLoopGoalSetterRequirementsPlan({
      objectivesCount: objectives.length,
      map: goalSetterRequirementsMap,
    });
  } catch (err) {
    console.error(formatLoopCliError('[loop config]', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  if (seedOutcomes !== undefined) seedOutcomes = attachTrustedVerifierKeys(seedOutcomes, verifierPlan.decisions);
  if (resume) {
    // Rebuild human checkpoints from the current trusted verifier plan. The loop log lives under cwd,
    // so replayed verifierKey values are audit-only and never decide health buckets.
    const verifierHealthTripped = replayVerifierHealthTripped(seedOutcomes ?? [], contract.cnvWindow, contract.cnvThreshold);
    const needsHuman =
      (seedHalted !== undefined && NEEDS_HUMAN.has(seedHalted)) ||
      (seedConsecutiveBlocked ?? 0) >= contract.maxConsecutiveBlocked ||
      verifierHealthTripped;
    if (needsHuman && !force) {
      const why = seedHalted ?? (verifierHealthTripped ? 'verifier-health' : 'consecutive-blocked');
      console.error(`该 loop 处于需人工检查状态(${safeInline(why)})。确认裁判/状态无误后,用 --resume --force 续跑。`);
      process.exitCode = CLI_EXIT.NEEDS_HUMAN;
      return;
    }
  }
  const verifierProviders = new Map<string, ModelProvider>();
  const providerForVerifier = (decision: LoopVerifierDecision): ModelProvider | undefined => {
    if (!decision.enabled) return undefined;
    let cached = verifierProviders.get(decision.key);
    if (cached === undefined) {
      cached = createProvider(decision.config).withThinking('off');
      verifierProviders.set(decision.key, cached);
    }
    return cached;
  };

  const loopStore = new FileLoopStore(loopPath);
  const worktreeRoot = loopWorktreeRoot(worktreeBaseRoot, loopId);
  if (parallelMode) {
    try {
      await assertWorktreeRootOutsideCwd(worktreeBaseRoot, cwd);
    } catch (err) {
      console.error(formatLoopCliError('[worktree]', err));
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }
  }
  // Hooks: trusted sources only. Resolve and preload before writing loop-created, so bad configs or
  // parallel incompatibility fail without polluting data/loops with an unusable latest loop.
  const { hooks, warning: hookWarning } = await resolveHooks({ hooksPath: JARVIS_HOOKS_LAUNCH, cwd, shellPath });
  if (hookWarning) console.error(formatLoopCliError('[hooks]', hookWarning));
  const hooksForGoal = createGoalHookResolver({
    globalHooks: hooks,
    hookPathByIndex: hookPlan.hookPathByIndex,
    load: async (hookPath, index) => {
      const resolved = await resolveHooks({ hooksPath: hookPath, userHooksPath: false, cwd, shellPath });
      if (resolved.warning) throw new Error(`hook map index ${index}: ${resolved.warning}`);
      return resolved.hooks;
    },
  });
  try {
    assertParallelHooksCompatible(parallelMode, hooks !== undefined || hookPlan.overrideCount > 0);
    await preloadGoalHookOverrides(hooksForGoal, hookPlan.hookPathByIndex.keys());
  } catch (err) {
    console.error(formatLoopCliError('[hooks]', err));
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  if (!resume) {
    await loopStore.writeCreated({
      id: loopId,
      contract,
      objectives,
      createdAt: new Date().toISOString(),
      verifierMapPath: verifierMap?.path,
      hookMapPath: hookMap?.path,
      sandboxCheckMapPath: sandboxCheckMap?.path,
      goalSetterRequirementsMapPath: goalSetterRequirementsMap?.path,
      goalSetterRequirementsMapHash: goalSetterRequirementsMap?.hash,
    });
  }

  const emergencyStop = createEmergencyStopSignal({
    cwd,
    onStop: (state) => {
      console.error(`\n[emergency-stop] ${safeInline(state.record?.reason ?? state.error ?? 'stop requested')}`);
    },
  });

  // Shared once: bus + render, context, gate (+ optional interactive approver), verifier provider.
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
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    rl = ask;
    // The same interactive approver goal uses (interactive-approver.ts): renders detailOf +
    // [a]/[s]/[d] and now exposes `s` (allow-session). For bash the gate's grant is command-scoped,
    // so approving one shell command stops re-asking that EXACT command for the rest of the queue
    // (the gate is shared across goals by loop-cli and remembers the exact command
    // string, never bash wholesale, deciding a deny first). Unattended (no approver) still
    // fail-closes every ask.
    approver = createApprovalEventApprover({
      approver: createInteractiveApprover(readlineApproverIo(ask)),
      bus,
      store: new FileApprovalAuditStore(join(cwd, 'data', 'approvals', `${loopId}.jsonl`)),
      sessionId: `loop-${loopId}`,
    });
  }
  // Plain --unattended still has no approver, so the shared gate fail-closes every `ask` to deny.
  const gate = new DefaultPermissionGate({ approver });
  const parallelApprover = parallelMode ? serializeApprover(approver) : approver;
  const context = new DefaultContextManager({
    summarizer: provider,
    maxContextTokens: provider.capability.maxContextTokens,
    maxOutputTokens: OUTPUT_RESERVE_TOKENS,
  });

  // shadow-git (opt-in via JARVIS_SHADOW_GIT): one side history under data/shadow for the WHOLE loop.
  // Every goal's per-round snapshots accumulate into the same repo, so `npm run shadow -- log / restore`
  // audits/rolls back across the queue. Off by default (a run never silently creates the shadow repo);
  // best-effort when on (snapshot failures never touch verification). Constructed once and shared by every
  // runGoal: it is keyed only on cwd/gitDir and stateless between snapshots.
  const shadowGitEnabled = process.env.JARVIS_SHADOW_GIT !== undefined;
  const shadowGit = shadowGitEnabled && !parallelMode
    ? new ShadowGit({ shellPath, cwd, gitDir: join(cwd, 'data', 'shadow') })
    : undefined;

  // Vision (Phase E multimodal): resolve once and build the tool a single time. It is STATELESS (its
  // run() reads per-call ctx), so the same instance is registered into every goal's fresh registry.
  // Opt-in via ARK_VISION_MODEL, like leg 3. capability=network, so the gate routes it to `ask`: attended
  // the approver answers it, unattended (no approver) it fail-closes to deny. So even an unattended loop
  // never silently sends an image out; the builder's vision call blocks exactly like its write/bash.
  const vision = resolveVisionConfig(process.env, config);
  const visionTool = vision.enabled ? createVisionTool(createVisionComplete(vision.config)) : undefined;
  const buildGoalTools = () => {
    const sandboxRunner = createWsl2UnshareSandboxRunner();
    const goalTools = buildDefaultRegistry();
    goalTools.register(createBashTool());
    registerBuilderSandboxTools(goalTools, sandboxRunner);
    if (visionTool) goalTools.register(visionTool);
    return { tools: goalTools, sandboxRunner };
  };
  const loopSessionComposition = (goalTools: ReturnType<typeof buildGoalTools>['tools']) => createSessionComposition({
    root: 'loop',
    runtimeVersion: JARVIS_VERSION,
    permissionMode: unattended ? (parallelMode ? 'worktree-unattended' : 'unattended') : 'interactive',
    toolSchemas: [...goalTools.schemasForModel(), updateGoalToolSchema()],
    systemPrompt: BUILDER_PROMPT,
    dynamicAddendum: NO_DYNAMIC_ADDENDUM,
  });

  console.log(`Jarvis-Agent loop mode - ${safeInline(config.model)}`);
  console.log(`Queue: ${objectives.length} goals${resume ? ` (resume, recheck ${seedInFlight?.size ?? 0} logged attempts)` : ''}`);
  console.log(parallelMode ? `Parallel: ${parallel} worktree goals, root ${safeInline(worktreeRoot)}` : 'Parallel: disabled');
  console.log(`Approval: ${unattended ? 'unattended (fail-closed)' : 'attended (interactive)'}`);
  console.log(`Worktree baseline: ${failOnWorktreeChange ? 'forbid changes' : 'audit changes'}`);
  console.log(
    repositoryBaseline
      ? `Trust: Git tamper baseline ${repositoryBaseline.headSha.slice(0, 8)}`
      : 'Trust: checks-only (--allow-no-git); verified completion disabled',
  );
  const enabledVerifierCount = verifierPlan.decisions.filter(
    (decision, index) =>
      decision.enabled &&
      !sandboxCheckPlan.pinnedByIndex.has(index) &&
      (!goalSetterRequirementsPlan.routesByIndex.has(index) || goalSetterRoutesNeedLlm(goalSetterRequirementsPlan.routesByIndex.get(index))),
  ).length;
  const disabledVerifierReason = verifier.enabled ? 'verifier plan has no enabled objectives' : verifier.reason;
  console.log(
    enabledVerifierCount > 0
      ? `Leg 3: ${enabledVerifierCount}/${objectives.length} goals use an independent verifier` +
          (verifierPlan.overrideCount > 0 ? `, verifier-map overrides ${verifierPlan.overrideCount}` : '')
      : `Leg 3: disabled (${safeInline(disabledVerifierReason)})`,
  );
  console.log(
    hookPlan.overrideCount > 0
      ? `Hooks: per-goal hook-map overrides ${hookPlan.overrideCount}/${objectives.length} goals`
      : hooks
        ? 'Hooks: global trusted hooks enabled'
        : 'Hooks: disabled',
  );
  console.log(
    sandboxCheckPlan.overrideCount > 0
      ? `Sandbox checks: per-goal sandbox-check-map overrides ${sandboxCheckPlan.overrideCount}/${objectives.length} goals`
      : 'Sandbox checks: disabled',
  );
  console.log(
    goalSetterRequirementsPlan.overrideCount > 0
      ? `Goal-setter requirements: per-goal route-map overrides ${goalSetterRequirementsPlan.overrideCount}/${objectives.length} goals`
      : 'Goal-setter requirements: disabled',
  );
  console.log(
    goalSetterRequirementsPlan.heldOutCommandsByIndex.size > 0
      ? `Held-out: per-goal hidden checks configured for ${goalSetterRequirementsPlan.heldOutCommandsByIndex.size}/${objectives.length} goals`
      : 'Held-out: no per-goal hidden checks',
  );
  console.log(
    vision.enabled
      ? `vision: enabled (${safeInline(vision.config.model)}), builder-only, gated as network`
      : `vision: disabled (${safeInline(vision.reason)})`,
  );
  console.log(
    shadowGitEnabled
      ? parallelMode
        ? `shadow-git: enabled per goal under data/shadow/${safeInline(loopId)}/gN; audit/restore each branch separately\n`
        : 'shadow-git: enabled, snapshots go to data/shadow; audit/restore with npm run shadow -- log / restore <sha>\n'
      : 'shadow-git: disabled; set JARVIS_SHADOW_GIT=1 to enable audit/restore\n',
  );

  const worktrees = new Map<number, string>();
  const goalCwdFor = async (index: number, resumed: boolean): Promise<string> => {
    if (!parallelMode) return cwd;
    const existing = worktrees.get(index);
    if (existing !== undefined) return existing;
    const path = resumed
      ? await resolveExistingGoalWorktree({ cwd, root: worktreeBaseRoot, loopId, index })
      : await createGoalWorktree({ shellPath, cwd, root: worktreeBaseRoot, loopId, index });
    worktrees.set(index, path);
    console.log(`[worktree] goal ${index + 1}/${objectives.length}: ${safeInline(path)}${resumed ? ' (resume)' : ''}`);
    return path;
  };
  const resumeCache = new Map<number, LoadedLoopGoalResume>();
  const loadResumeFor = async (
    index: number,
    goalId: string,
    goalCwd: string,
    expectedComposition: ReturnType<typeof createSessionComposition>,
  ): Promise<LoadedLoopGoalResume> => {
    const cached = resumeCache.get(index);
    if (cached !== undefined) return cached;
    const goalPath = join(cwd, 'data', 'goals', `${goalId}.jsonl`);
    const sessionPath = join(cwd, 'data', 'sessions', `${goalId}.jsonl`);
    const loaded = await loadLoopGoalResume(
      goalPath,
      sessionPath,
      goalId,
      goalCwd,
      expectedComposition,
      config.model,
    );
    resumeCache.set(index, loaded);
    return loaded;
  };

  // runOne is the SOLE seam to runGoal. Per goal: NEW tools registry (registry.register throws on a
  // duplicate update_goal, so it can't be shared), fresh baseline, derived pinned (block-and-continue
  // on empty rather than exiting the process), own goal/session stores, then the UNCHANGED runGoal.
  const runOne = async (objective: string, goalId: string, attempt: { index: number; resumed: boolean }): Promise<ParallelGoalRunSummary> => {
    const goalCwd = await goalCwdFor(attempt.index, attempt.resumed);
    const goalHooks = await hooksForGoal(attempt.index);
    const goalHookOverride = hookPlan.hookPathByIndex.has(attempt.index);
    const { tools, sandboxRunner: goalSandboxRunner } = buildGoalTools();
    const sessionComposition = loopSessionComposition(tools);

    const goalPath = join(cwd, 'data', 'goals', `${goalId}.jsonl`);
    const sessionPath = join(cwd, 'data', 'sessions', `${goalId}.jsonl`);
    const loadedResume = attempt.resumed
      ? await loadResumeFor(attempt.index, goalId, goalCwd, sessionComposition)
      : undefined;
    const resumeState = loadedResume?.resume;
    const verifierDecision = verifierPlan.decisions[attempt.index];
    if (verifierDecision === undefined) {
      throw new Error(`missing verifier decision for objective index ${attempt.index}`);
    }
    const sandboxPinned = sandboxCheckPlan.pinnedByIndex.get(attempt.index);
    const sandboxCommands = sandboxCheckPlan.commandsByIndex.get(attempt.index);
    const goalSetterPinned = goalSetterRequirementsPlan.pinnedByIndex.get(attempt.index);
    const goalSetterRoutes = goalSetterRequirementsPlan.routesByIndex.get(attempt.index);
    const goalSetterCommands = goalSetterRequirementsPlan.commandsByIndex.get(attempt.index);
    const goalSetterHeldOutCommands = goalSetterRequirementsPlan.heldOutCommandsByIndex.get(attempt.index);
    const verifierProvider =
      goalSetterPinned !== undefined
        ? goalSetterRoutesNeedLlm(goalSetterRoutes)
          ? providerForVerifier(verifierDecision)
          : undefined
        : sandboxPinned === undefined
          ? providerForVerifier(verifierDecision)
          : undefined;

    let pinned: PinnedRequirement[] = [];
    if (goalSetterPinned !== undefined) {
      pinned = goalSetterPinned;
    } else if (sandboxPinned !== undefined) {
      pinned = sandboxPinned;
    } else if (verifierProvider) {
      pinned = await derivePinnedRequirements(objective, provider, emergencyStop.signal);
      if (pinned.length === 0) {
        if (emergencyStop.signal.aborted) {
          bus.emit({ type: 'halt', reason: 'emergency-stop' });
          return { state: 'blocked', rounds: resumeState?.rounds.length ?? 0, tokens: sumRoundTokens(resumeState?.rounds ?? []) };
        }
        // Verifier on but no pinned list makes `verified` unreachable, so running would
        // only burn budget to a block. Block this goal immediately and let the loop continue. No outcome
        // Not a verifier-health sample because the judge never ran.
        bus.emit({ type: 'goal_state', goalId, state: 'blocked' });
        return { state: 'blocked', rounds: resumeState?.rounds.length ?? 0, tokens: sumRoundTokens(resumeState?.rounds ?? []) };
      }
    } else if (resumeState && resumeState.goal.pinned.length > 0) {
      bus.emit({ type: 'goal_state', goalId, state: 'blocked' });
      return { state: 'blocked', rounds: resumeState.rounds.length, tokens: sumRoundTokens(resumeState.rounds) };
    }

    const baseline = await snapshotBaseline(shellPath, goalCwd, emergencyStop.signal);
    const worktreeBaseline = await snapshotWorktreeStatus(shellPath, goalCwd, emergencyStop.signal);
    const goalStore = new FileGoalStore(goalPath);
    const sessionStore = new FileSessionStore(sessionPath, loadedResume?.initialCursor ?? 0, {
      format: loadedResume?.sessionFormat ?? 'v2',
      initialSequence: loadedResume?.initialSequence ?? 0,
    });
    if (!attempt.resumed) {
      await sessionStore.writeHeader({
        id: goalId,
        model: config.model,
        cwd: goalCwd,
        startedAt: new Date().toISOString(),
        composition: sessionComposition,
      });
    }
    const goalGate = parallelMode
      ? new DefaultPermissionGate({
          approver: parallelApprover,
          goalWorktreeWriteRoot: unattended ? goalCwd : undefined,
        })
      : gate;
    const goalContext = parallelMode
      ? new DefaultContextManager({
          summarizer: provider,
          maxContextTokens: provider.capability.maxContextTokens,
          maxOutputTokens: OUTPUT_RESERVE_TOKENS,
        })
      : context;
    const goalShadowGit =
      shadowGitEnabled && parallelMode
        ? new ShadowGit({ shellPath, cwd: goalCwd, gitDir: join(cwd, 'data', 'shadow', loopId, `g${attempt.index}`) })
        : shadowGit;

    await runAdvisoryHook(goalHookOverride ? goalHooks?.sessionStart : undefined);
    let result;
    const sandboxedRequirementCommands =
      goalSetterPinned !== undefined
        ? goalSetterCommands && goalSetterCommands.length > 0
          ? goalSetterCommands
          : undefined
        : sandboxCommands;
    try {
      result = await runGoal(
        { id: goalId, objective, sessionId: goalId, budget: contract.perGoalBudget, baseline, worktreeBaseline, pinned, resume: resumeState },
        {
          model: provider,
          tools,
          bus,
          gate: goalGate,
          hooks: goalHooks,
          context: goalContext,
          store: sessionStore,
          goalStore,
          cwd: goalCwd,
          shellPath,
          builderSystemPrompt: BUILDER_PROMPT,
          perRoundMaxTurns: PER_ROUND_MAX_TURNS,
          checkCommands: DEFAULT_CHECK_COMMANDS,
          heldOutCommands: goalSetterHeldOutCommands,
          worktreeChangePolicy: failOnWorktreeChange ? 'forbid' : 'audit',
          verifierProvider,
          sandboxedRequirementCommands,
          goalSetterRequirementRoutes: goalSetterRoutes,
          sandboxRunner: sandboxedRequirementCommands && sandboxedRequirementCommands.length > 0 ? goalSandboxRunner : undefined,
          shadowGit: goalShadowGit,
          signal: emergencyStop.signal,
        },
      );
    } finally {
      await runAdvisoryHook(goalHookOverride ? goalHooks?.sessionEnd : undefined);
    }
    return {
      state: result.state,
      outcome: result.finalVerdict?.outcome,
      verifierKey:
        goalSetterPinned !== undefined
          ? `goal-setter-requirements:${goalSetterRequirementsMap?.hash ?? 'unknown'}`
          : sandboxPinned !== undefined
            ? 'sandbox:wsl2-unshare'
            : verifierDecision.enabled
              ? verifierDecision.key
              : undefined,
      rounds: result.rounds,
      tokens: result.tokens,
      haltReason: result.haltReason,
    };
  };

  if (parallelMode && resume && seedInFlight !== undefined) {
    try {
      for (const [index, goalId] of seedInFlight) {
        const goalCwd = await goalCwdFor(index, true);
        const { tools: resumeTools } = buildGoalTools();
        await loadResumeFor(index, goalId, goalCwd, loopSessionComposition(resumeTools));
      }
    } catch (err) {
      console.error(formatLoopCliError('[loop resume]', err));
      emergencyStop.dispose();
      rl?.close();
      process.exitCode = err instanceof SessionCompositionMismatchError
        ? CLI_EXIT.NEEDS_HUMAN
        : CLI_EXIT.STATE_CORRUPT;
      return;
    }
  }

  // try/finally so a thrown goal run (provider/network/disk error from inside runOne/runGoal) still
  // CLOSES the readline. An open interface keeps stdin referenced and the event loop alive, so without
  // this the process would hang after the fatal error instead of exiting with the intended code.
  await runAdvisoryHook(hooks?.sessionStart);
  try {
    const loopDeps = {
      bus,
      loopStore,
      runOne,
      finished: seedFinished,
      outcomes: seedOutcomes,
      inFlight: seedInFlight,
      consecutiveBlocked: seedConsecutiveBlocked,
      cumulativeTokens: seedCumulativeTokens,
      signal: emergencyStop.signal,
    };
    const result = parallelMode
      ? await runParallelLoop({ id: loopId, objectives, contract }, { ...loopDeps, maxParallel: parallel })
      : await runLoop({ id: loopId, objectives, contract }, loopDeps);
    console.log(
      `\n=== loop ${result.reason} - this run started=${result.started} completed=${result.completed} blocked=${result.blocked} ` +
        `needsVerification=${result.needsVerification} runtimeFailures=${result.runtimeFailures} ` +
        `- cumulative finished=${result.goalsFinished}/${objectives.length} tokens=${result.cumulativeTokens} ===`,
    );
    if (result.reason !== 'queue-empty') {
      for (const line of formatLoopTerminalGuidance({
        reason: safeInline(result.reason),
        needsVerification: result.needsVerification,
        runtimeFailures: result.runtimeFailures,
        loopLogPath: safeInline(loopPath),
      })) console.log(line);
    }
    if (parallelMode) console.log(`Worktrees kept for inspection: ${safeInline(worktreeRoot)}`);
    process.exitCode = exitCodeForLoop(result);
  } catch (err) {
    if (emergencyStop.signal.aborted) {
      await loopStore.recordHalted('emergency-stop', new Date().toISOString()).catch(() => undefined);
      bus.emit({ type: 'loop_halt', loopId, reason: 'emergency-stop' });
      bus.emit({ type: 'halt', reason: 'emergency-stop' });
      console.error('\n[loop] emergency stop requested; no new goals will launch and JSONL logs were left in place.');
      process.exitCode = CLI_EXIT.INTERRUPTED;
      return;
    }
    throw err;
  } finally {
    emergencyStop.dispose();
    await runAdvisoryHook(hooks?.sessionEnd);
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

function findWorkspaceRoot(cwd: string): string {
  let cursor = cwd;
  while (true) {
    if (existsSync(join(cursor, '.git'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return cwd;
    cursor = parent;
  }
}

/** Snapshot the leg-2 baseline. Production callers reject absence unless checks-only is explicit. */
async function snapshotBaseline(shellPath: string, cwd: string, signal?: AbortSignal): Promise<TestBaseline | undefined> {
  const res = await runCommand(shellPath, 'git rev-parse HEAD', cwd, 10_000, 1_000, signal);
  if (res.code !== 0) return undefined;
  return { headSha: res.output.trim(), testFiles: [] };
}

main().catch((err: unknown) => {
  console.error(formatLoopCliError('[loop] fatal:', err));
  process.exitCode = err instanceof SessionCompositionMismatchError
    ? CLI_EXIT.NEEDS_HUMAN
    : CLI_EXIT.RUNTIME;
});

async function runAdvisoryHook(fn: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await fn?.();
  } catch {
    // session hooks are notification-only
  }
}

function sumRoundTokens(rounds: Array<{ tokens?: number }>): number {
  return rounds.reduce((sum, round) => sum + (round.tokens ?? 0), 0);
}

function attachTrustedVerifierKeys(
  outcomes: Array<VerdictOutcome | VerifierOutcomeSample>,
  decisions: LoopVerifierDecision[],
): Array<VerdictOutcome | VerifierOutcomeSample> {
  return outcomes.map((sample) => {
    if (typeof sample === 'string') return sample;
    const decision = sample.index === undefined ? undefined : decisions[sample.index];
    return {
      index: sample.index,
      outcome: sample.outcome,
      verifierKey: decision?.enabled ? decision.key : undefined,
    };
  });
}

function replayVerifierHealthTripped(
  outcomes: Array<VerdictOutcome | VerifierOutcomeSample>,
  windowSize: number,
  threshold: number,
): boolean {
  const windows = new Map<string, boolean[]>();
  for (const outcome of outcomes) {
    const key = typeof outcome === 'string' ? '__default__' : (outcome.verifierKey ?? '__default__');
    const value = typeof outcome === 'string' ? outcome : outcome.outcome;
    const window = windows.get(key) ?? [];
    window.push(value === 'couldNotVerify');
    if (window.length > windowSize) window.shift();
    windows.set(key, window);
    if (window.filter(Boolean).length >= threshold) return true;
  }
  return false;
}

function goalSetterRoutesNeedLlm(routes: ReadonlyMap<string, string> | undefined): boolean {
  if (routes === undefined) return false;
  for (const route of routes.values()) {
    if (route === 'llm') return true;
  }
  return false;
}

function serializeApprover(approver: Approver | undefined): Approver | undefined {
  if (approver === undefined) return undefined;
  let tail = Promise.resolve();
  return async (req) => {
    const run = tail.then(() => approver(req));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
