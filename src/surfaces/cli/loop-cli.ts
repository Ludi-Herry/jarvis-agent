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
 * approver, so the gate fail-closes every `ask` to deny, and the default policy has NO write-allowing
 * rule, so EVERY write and bash is `ask` and thus denied. Only read/grep-only goals complete
 * unattended; everything that writes blocks safely. Truly unattended bash autonomy waits for the OS
 * sandbox (a config bash allow-list is unsafe); this entry adds no bash auto-allow.
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
 * held-out hidden-assertion leg is NOT wired here (it is a per-objective secret; one shared file across
 * a heterogeneous queue is meaningless); set it per single goal via `npm run goal` if you need it.
 *
 * Run:  npm run loop -- <objectives-file>            (needs ARK_API_KEY in .env)
 *       npm run loop -- <objectives-file> --unattended
 *       ARK_VERIFIER_MODEL=<id> npm run loop -- <objectives-file>   (enable leg 3 + the health monitor)
 *       npm run resume:loop -- --verifier-map <trusted-json>  (use {"goals":[]} for deterministic-only resume)
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
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
  assertResumeVerifierMapMatches,
  buildLoopVerifierPlan,
  derivePinnedRequirements,
  latestLoopPath,
  loadLoopVerifierMap,
  loadLoop,
  resolveHooks,
  runGoal,
  runLoop,
  type GoalRunSummary,
  type LoadedLoopVerifierMap,
  type LoopContract,
  type LoopVerifierDecision,
  type PinnedRequirement,
  type TestBaseline,
  type VerifierOutcomeSample,
  type VerdictOutcome,
} from '../../capabilities/index.js';
import type { ModelProvider } from '../../core/index.js';
import { safeInline } from './approval.js';
import { createInteractiveApprover, readlineApproverIo } from './interactive-approver.js';
import { parseLoopArgs } from './loop-args.js';
import { loadLoopGoalResume } from './loop-resume.js';
import { initialRenderState, renderEvent } from './render.js';

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
const MAX_WALL_CLOCK_MS = 2 * 60 * 60 * 1000; // 2h per invocation
const MAX_CONSECUTIVE_BLOCKED = 3;
const CNV_WINDOW = 3;
const CNV_THRESHOLD = 3;
const PER_ROUND_MAX_TURNS = 16;

const BUILDER_PROMPT = [
  'You are an autonomous coding assistant working in a terminal to complete one goal.',
  'Use the read / write / grep / bash tools to make progress. Paths are relative to the project root. Dangerous or secret-touching actions may be blocked or require approval.',
  'When you believe the goal is complete, call update_goal(complete) and end the round; the harness will independently rerun project checks to verify it.',
  'Do not weaken or delete tests to get green; that will be detected and rejected. If you are stuck, call update_goal(blocked).',
].join('\n');

/** Hand-to-human halt reasons. A `--resume` past one of these requires `--force`. */
const NEEDS_HUMAN: ReadonlySet<string> = new Set(['verifier-health', 'consecutive-blocked']);

async function main(): Promise<void> {
  let args;
  try {
    args = parseLoopArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { resume, force, unattended, noVerifierMap, positional, verifierMapPath } = args;
  if (noVerifierMap) {
    console.error('--no-verifier-map is unsafe for resume; use --verifier-map <trusted empty map>');
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
  // The provider captured the key; scrub it from the env so a goal builder's bash can't read it back.
  scrubProviderKeyFromEnv();
  const cwd = process.cwd();
  const shellPath = defaultShellPath();
  const loopsDir = join(cwd, 'data', 'loops');

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
      console.error(`[loop verifier] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
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

  if (resume) {
    const latest = await latestLoopPath(loopsDir);
    if (latest === null) {
      console.error('No resumable loop found (data/loops/ is empty).');
      process.exitCode = 1;
      return;
    }
    const replay = await loadLoop(latest);
    if (replay.contract === undefined || replay.id === undefined) {
      console.error(`loop 鏃ュ織鎹熷潖鎴栫己灏?header: ${latest}`);
      process.exitCode = 1;
      return;
    }
    loopId = replay.id;
    objectives = replay.objectives;
    contract = replay.contract;
    loopPath = latest;
    replayVerifierMapPath = replay.verifierMapPath;
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
      process.exitCode = 1;
      return;
    }
    objectives = loadObjectives(file);
    if (objectives.length === 0) {
      console.error(`objectives file is empty or unreadable: ${file}`);
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

  try {
    if (resume) assertResumeVerifierMapMatches(replayVerifierMapPath, verifierMap?.path, noVerifierMap);
  } catch (err) {
    console.error(`[loop verifier] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const verifier = resolveVerifierConfig(process.env, config);
  let verifierPlan;
  try {
    verifierPlan = buildLoopVerifierPlan({
      objectivesCount: objectives.length,
      builderConfig: config,
      globalVerifier: verifier,
      map: verifierMap,
    });
  } catch (err) {
    console.error(`[loop verifier] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
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
      console.error(`该 loop 处于需人工检查状态(${why})。确认裁判/状态无误后,用 --resume --force 续跑。`);
      process.exitCode = 1;
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
  if (!resume) {
    await loopStore.writeCreated({ id: loopId, contract, objectives, createdAt: new Date().toISOString(), verifierMapPath: verifierMap?.path });
  }

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
    approver = createInteractiveApprover(readlineApproverIo(ask));
  }
  // --unattended means no approver, so the gate fail-closes every `ask` to deny.
  const gate = new DefaultPermissionGate({ approver });
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
  const shadowGit = process.env.JARVIS_SHADOW_GIT
    ? new ShadowGit({ shellPath, cwd, gitDir: join(cwd, 'data', 'shadow') })
    : undefined;

  // Vision (Phase E multimodal): resolve once and build the tool a single time. It is STATELESS (its
  // run() reads per-call ctx), so the same instance is registered into every goal's fresh registry.
  // Opt-in via ARK_VISION_MODEL, like leg 3. capability=network, so the gate routes it to `ask`: attended
  // the approver answers it, unattended (no approver) it fail-closes to deny. So even an unattended loop
  // never silently sends an image out; the builder's vision call blocks exactly like its write/bash.
  const vision = resolveVisionConfig(process.env, config);
  const visionTool = vision.enabled ? createVisionTool(createVisionComplete(vision.config)) : undefined;

  // Hooks: trusted sources only: user-home default first, then launch-captured JARVIS_HOOKS.
  // Built once and shared across the queue. Especially relevant unattended: a PreToolUse hook is a
  // fail-closed guardrail with no human in the loop.
  const { hooks, warning: hookWarning } = await resolveHooks({ hooksPath: JARVIS_HOOKS_LAUNCH, cwd, shellPath });
  if (hookWarning) console.error(`[hooks] ${hookWarning}`);

  console.log(`Jarvis-Agent loop mode - ${safeInline(config.model)}`);
  console.log(`Queue: ${objectives.length} goals${resume ? ` (resume, recheck ${seedInFlight?.size ?? 0} logged attempts)` : ''}`);
  console.log(`Approval: ${unattended ? 'unattended (fail-closed)' : 'attended (interactive)'}`);
  const enabledVerifierCount = verifierPlan.decisions.filter((decision) => decision.enabled).length;
  const disabledVerifierReason = verifier.enabled ? 'verifier plan has no enabled objectives' : verifier.reason;
  console.log(
    enabledVerifierCount > 0
      ? `Leg 3: ${enabledVerifierCount}/${objectives.length} goals use an independent verifier` +
          (verifierPlan.overrideCount > 0 ? `, verifier-map overrides ${verifierPlan.overrideCount}` : '')
      : `Leg 3: disabled (${safeInline(disabledVerifierReason)})`,
  );
  console.log(
    vision.enabled
      ? `vision: enabled (${safeInline(vision.config.model)}), builder-only, gated as network`
      : `vision: disabled (${vision.reason})`,
  );
  console.log(
    shadowGit
      ? 'shadow-git: enabled, snapshots go to data/shadow; audit/restore with npm run shadow -- log / restore <sha>\n'
      : 'shadow-git: disabled; set JARVIS_SHADOW_GIT=1 to enable audit/restore\n',
  );

  // runOne is the SOLE seam to runGoal. Per goal: NEW tools registry (registry.register throws on a
  // duplicate update_goal, so it can't be shared), fresh baseline, derived pinned (block-and-continue
  // on empty rather than exiting the process), own goal/session stores, then the UNCHANGED runGoal.
  const runOne = async (objective: string, goalId: string, attempt: { index: number; resumed: boolean }): Promise<GoalRunSummary> => {
    const tools = buildDefaultRegistry();
    tools.register(createBashTool());
    if (visionTool) tools.register(visionTool); // opt-in vision (network -> gate ask / unattended deny)

    const goalPath = join(cwd, 'data', 'goals', `${goalId}.jsonl`);
    const sessionPath = join(cwd, 'data', 'sessions', `${goalId}.jsonl`);
    const loadedResume = attempt.resumed ? await loadLoopGoalResume(goalPath, sessionPath, goalId, cwd) : undefined;
    const resumeState = loadedResume?.resume;
    const verifierDecision = verifierPlan.decisions[attempt.index];
    if (verifierDecision === undefined) {
      throw new Error(`missing verifier decision for objective index ${attempt.index}`);
    }
    const verifierProvider = providerForVerifier(verifierDecision);

    let pinned: PinnedRequirement[] = [];
    if (verifierProvider) {
      pinned = await derivePinnedRequirements(objective, provider);
      if (pinned.length === 0) {
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

    const baseline = await snapshotBaseline(shellPath, cwd);
    const goalStore = new FileGoalStore(goalPath);
    const sessionStore = new FileSessionStore(sessionPath, loadedResume?.initialCursor ?? 0);
    if (!attempt.resumed) {
      await sessionStore.writeHeader({ id: goalId, model: config.model, cwd, startedAt: new Date().toISOString() });
    }

    const result = await runGoal(
      { id: goalId, objective, sessionId: goalId, budget: contract.perGoalBudget, baseline, pinned, resume: resumeState },
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
    return {
      state: result.state,
      outcome: result.finalVerdict?.outcome,
      verifierKey: verifierDecision.enabled ? verifierDecision.key : undefined,
      rounds: result.rounds,
      tokens: result.tokens,
    };
  };

  // try/finally so a thrown goal run (provider/network/disk error from inside runOne/runGoal) still
  // CLOSES the readline. An open interface keeps stdin referenced and the event loop alive, so without
  // this the process would hang after the fatal error instead of exiting with the intended code.
  await runAdvisoryHook(hooks?.sessionStart);
  try {
    const result = await runLoop(
      { id: loopId, objectives, contract },
      {
        bus,
        loopStore,
        runOne,
        finished: seedFinished,
        outcomes: seedOutcomes,
        inFlight: seedInFlight,
        consecutiveBlocked: seedConsecutiveBlocked,
        cumulativeTokens: seedCumulativeTokens,
      },
    );
    console.log(
      `\n=== loop ${result.reason} - this run started=${result.started} completed=${result.completed} blocked=${result.blocked} ` +
        `- cumulative finished=${result.goalsFinished}/${objectives.length} tokens=${result.cumulativeTokens} ===`,
    );
    if (NEEDS_HUMAN.has(result.reason)) process.exitCode = 1;
  } finally {
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
