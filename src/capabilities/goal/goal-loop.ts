/**
 * GoalLoop — the goal-driven OUTER loop over runAgent (Phase D; blueprint §9, Part7 §3.3).
 *
 * runAgent stays an inner, single-message loop that knows nothing about goals. runGoal wraps it:
 * it owns one `messages` array (reused across rounds so the builder sees its own history + feedback),
 * one bus, and a `claim` slot. Each round it runs the builder (with the `update_goal` tool), and when
 * the builder claims completion it VERIFIES INDEPENDENTLY — the deterministic two legs (checks.ts) +
 * the pure decideVerdict — never the builder's self-report. rejected → continuation + keep going;
 * verified → complete; couldNotVerify/blocked → hand to a human.
 *
 * The circuit breaker is REALLY wired in here (Part7 P0-2): both reject paths go through
 * rejectAndAdvance, which calls recordReject AND reads its return — consecutive rejects halt the loop
 * to `blocked` rather than burning budget forever. The integration test asserts that wiring.
 */
import type { ModelProvider } from '../../core/model/types.js';
import type { ToolRegistry } from '../../core/tools/types.js';
import type { PermissionGate } from '../../runtime/permission/permission-gate.js';
import type { ContextManager } from '../../core/context/context-manager.js';
import type { EventBus } from '../../runtime/event-bus.js';
import type { SessionStore } from '../../runtime/session/session-store.js';
import type { Message } from '../../core/types.js';
import type { HookRunner } from '../hooks/index.js';
import type { SandboxLimits, SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../../runtime/sandbox/index.js';
import { type AgentContext, type RunOutcome, runAgent } from '../../core/loop/run-agent.js';
import { hardenSandboxInspectionCommand, validateSandboxInspectionCommand } from '../../core/tools/sandboxed-inspection-command.js';
import { redactSecrets } from '../../core/model/errors.js';
import { decideVerdict } from './verdict.js';
import { advanceGoalState } from './state.js';
import { DEFAULT_CHECK_COMMANDS, runDeterministicChecks, type CheckDeps } from './checks.js';
import { FileGoalStore, assertObjectiveUnchanged, hashObjective, type GoalRoundRecord } from './goal-store.js';
import { createUpdateGoalTool, takeClaim, type ClaimSlot } from './update-goal-tool.js';
import { couldNotVerifyReport, runVerifier as defaultRunVerifier } from './verifier.js';
import { reportFromSandboxedRequirementChecks, type SandboxedRequirementCheck } from './sandboxed-check-report.js';
import type { SandboxedRequirementCommand } from './sandboxed-check-config.js';
import { composeVerifierReport } from './composite-verifier-report.js';
import type { GoalSetterRequirementRoute } from './goal-setter-requirements.js';
import type {
  DeterministicChecks,
  Goal,
  GoalBudget,
  GoalState,
  PinnedRequirement,
  TestBaseline,
  Verdict,
  VerifierReport,
  WorktreeChangePolicy,
  WorktreeStatusBaseline,
} from './goal.js';

/** Consecutive rejects before the breaker halts the loop (borrowed A=3; Part7 §6.1). The sliding
 *  window is intentionally dropped this batch — in this state machine only rejected→active resets
 *  the counter, so the consecutive latch fires first anyway (Part7 §6.1 window-reachability note). */
const MAX_CONSECUTIVE_REJECTS = 3;
const SANDBOX_CHECK_CWD = '/tmp/jarvis-sandbox/project';
const SANDBOX_CHECK_LIMITS: SandboxLimits = { timeoutMs: 30_000, outputBytes: 32_768 };

/** A pure-ish breaker: count rejects → halt + latch at {@link MAX_CONSECUTIVE_REJECTS}. The count is
 *  consecutive IN THE WIRING — a non-reject verdict (verified/couldNotVerify) ends the loop (break), so
 *  rejects can't be interleaved with non-rejects within one goal. (An earlier `recordNonReject` reset
 *  was removed: in this state machine it ran one statement before an unconditional break, so it could
 *  never influence a later iteration — a VerifierMonitor-class unreachable branch, fail-safe but dead.) */
export class VerifierCircuitBreaker {
  private consecutive = 0;
  private tripped = false;

  constructor(initialRejects = 0) {
    this.consecutive = initialRejects;
    this.tripped = initialRejects >= MAX_CONSECUTIVE_REJECTS;
  }

  recordReject(): 'continue' | 'halt' {
    this.consecutive++;
    if (!this.tripped && this.consecutive >= MAX_CONSECUTIVE_REJECTS) {
      this.tripped = true;
      return 'halt';
    }
    return 'continue';
  }
}

export interface GoalSpec {
  id: string;
  objective: string;
  sessionId: string;
  budget: GoalBudget;
  /** Leg-2 baseline, snapshotted by the caller at creation (undefined → leg 2 inert). */
  baseline?: TestBaseline;
  /** Worktree status captured before the goal run for audit/no-change enforcement. */
  worktreeBaseline?: WorktreeStatusBaseline;
  /** Harness-pinned requirement list (leg 3), derived by the caller at creation. Omitted/empty →
   *  batch-1 deterministic-only (no verifier). The caller fail-closes on empty WHEN it configures a
   *  verifier, since decideVerdict step 5 makes verified unreachable for an empty list. */
  pinned?: PinnedRequirement[];
  /** Existing goal/session state loaded from JSONL. Present only when loop resume continues an in-flight goal. */
  resume?: GoalResumeState;
}

export interface GoalResumeState {
  goal: Goal;
  rounds: GoalRoundRecord[];
  messages: Message[];
}

export interface ShadowSnapshotHandle {
  /** Resolves when the working-tree state for this label has been captured into the shadow index. */
  captured: Promise<unknown>;
  /** Resolves when the full snapshot operation (commit/rev-parse) is finished. */
  done: Promise<unknown>;
}

export interface ShadowSnapshotter {
  snapshot(label: string): Promise<unknown>;
  snapshotAsync?(label: string): ShadowSnapshotHandle;
}

export interface GoalRunDeps {
  model: ModelProvider;
  /** The builder's tool registry. The `update_goal` tool is registered into it by runGoal. */
  tools: ToolRegistry;
  bus: EventBus;
  gate?: PermissionGate;
  /** Optional hooks. Forwarded verbatim into each round's runAgent ctx — PreToolUse can fail-closed
   *  block a gate-allowed call; PostToolUse and Round hooks are advisory. Off the verdict path
   *  entirely (the verifier legs are unaffected). Absent → no hooks. */
  hooks?: HookRunner;
  context?: ContextManager;
  /** Builder conversation log (runAgent persists messages here). */
  store?: SessionStore;
  /** Goal lifecycle log. */
  goalStore?: FileGoalStore;
  cwd: string;
  shellPath: string;
  builderSystemPrompt: string;
  /** Per-round runAgent turn ceiling. */
  perRoundMaxTurns: number;
  /** Fixed check commands (leg 1). NEVER sourced from the builder's claim. Defaults to the four gates. */
  checkCommands?: string[];
  /** Held-out leg: SECRET hidden-assertion commands the builder never sees (config, NEVER the claim).
   *  Absent/empty → no held-out leg. The harness runs them and trusts the real exit codes, but never
   *  surfaces them to the builder — see {@link continuationFromVerdict}. */
  heldOutCommands?: readonly string[];
  /** `audit` records worktree status drift; `forbid` rejects if status changes after the baseline. */
  worktreeChangePolicy?: WorktreeChangePolicy;
  /** Leg 3: the SECOND (independent, different-model) provider. Present → leg 3 runs after the
   *  deterministic legs pass; absent → batch-1 deterministic-only (decideVerdict's no-report path). */
  verifierProvider?: ModelProvider;
  /** Trusted per-requirement inspection commands. These must come from a trusted source outside cwd,
   *  never from the builder/model. Present -> run through sandboxRunner and map to a VerifierReport. */
  sandboxedRequirementCommands?: SandboxedRequirementCommand[];
  /** Trusted goal-setter route map. Present -> compose sandbox, LLM, and human per-requirement reports. */
  goalSetterRequirementRoutes?: ReadonlyMap<string, GoalSetterRequirementRoute>;
  sandboxRunner?: SandboxRunner;
  /** The judge's per-run turn ceiling (read a few files, then report). Defaults to {@link DEFAULT_VERIFIER_MAX_TURNS}. */
  verifierMaxTurns?: number;
  signal?: AbortSignal;
  /** Optional shadow-git: a best-effort per-round snapshot of the working tree for audit / rollback of
   *  what the builder changed. PURE OBSERVABILITY — its result is ignored and a throw is swallowed, so
   *  it can NEVER affect the verdict or the loop. */
  shadowGit?: ShadowSnapshotter;
  /** Injected for tests; default {@link runAgent} / {@link runDeterministicChecks} / {@link defaultRunVerifier}. */
  run?: (ctx: AgentContext) => Promise<RunOutcome>;
  check?: (deps: CheckDeps, baseline?: TestBaseline) => Promise<DeterministicChecks>;
  runVerifier?: (
    objective: string,
    pinned: PinnedRequirement[],
    deps: { verifierProvider: ModelProvider; cwd: string; maxTurns: number; signal?: AbortSignal },
  ) => Promise<VerifierReport>;
}

/** Default judge turn ceiling — it should read a handful of files and report, not loop. */
const DEFAULT_VERIFIER_MAX_TURNS = 12;

export interface GoalRunResult {
  goal: Goal;
  state: GoalState;
  rounds: number;
  tokens: number;
  finalVerdict?: Verdict;
}

export async function runGoal(spec: GoalSpec, deps: GoalRunDeps): Promise<GoalRunResult> {
  const run = deps.run ?? runAgent;
  const check = deps.check ?? runDeterministicChecks;
  const runVerifierFn = deps.runVerifier ?? defaultRunVerifier;
  const stamp = (): string => new Date().toISOString();

  const resume = spec.resume;
  const objectiveHash = resume?.goal.objectiveHash ?? hashObjective(spec.objective);
  const pinned: PinnedRequirement[] = spec.pinned ?? [];
  let goal: Goal =
    resume?.goal ?? {
      id: spec.id,
      objective: spec.objective,
      objectiveHash,
      state: 'active',
      budget: spec.budget,
      testBaseline: spec.baseline,
      worktreeBaseline: spec.worktreeBaseline,
      pinned,
      sessionId: spec.sessionId,
      createdAt: stamp(),
    };
  if (resume) {
    assertResumeMatchesSpec(spec, goal);
    goal = { ...goal, budget: spec.budget, testBaseline: spec.baseline, worktreeBaseline: spec.worktreeBaseline ?? goal.worktreeBaseline, pinned };
  }

  if (resume && goal.state !== 'active') {
    const finalVerdict = resume.rounds.at(-1)?.verdict;
    const resumedTokens = sumRoundTokens(resume.rounds);
    if (goal.state !== 'complete') {
      return { goal, state: goal.state, rounds: resume.rounds.length, tokens: resumedTokens, finalVerdict };
    }
    if (finalVerdict?.outcome !== 'verified') {
      throw new Error('resumed complete goal is missing a verified verdict');
    }
    const verification = await verifyGoalCompletion(goal, deps, check, runVerifierFn, true);
    deps.bus.emit({
      type: 'verdict',
      goalId: goal.id,
      outcome: verification.verdict.outcome,
      rationale: redactSecrets(verification.verdict.rationale),
    });
    const recheckRound = resume.rounds.length + 1;
    await deps.goalStore?.recordRound({
      round: recheckRound,
      turns: 0,
      tokens: 0,
      claim: { status: 'complete' },
      checks: verification.persistedChecks,
      verdict: verification.verdict,
      at: stamp(),
    });
    if (verification.verdict.outcome !== 'verified') {
      const blocked = await transition(deps, goal, 'blocked', undefined, stamp);
      goal = { ...goal, state: blocked };
      return { goal, state: blocked, rounds: recheckRound, tokens: resumedTokens, finalVerdict: verification.verdict };
    }
    return { goal, state: 'complete', rounds: recheckRound, tokens: resumedTokens, finalVerdict: verification.verdict };
  }

  if (!resume) {
    await deps.goalStore?.writeCreated({
      id: goal.id,
      objective: goal.objective,
      objectiveHash,
      budget: goal.budget,
      testBaseline: goal.testBaseline,
      worktreeBaseline: goal.worktreeBaseline,
      pinned,
      sessionId: goal.sessionId,
      createdAt: goal.createdAt,
    });
  }

  const slot: ClaimSlot = {};
  deps.tools.register(createUpdateGoalTool(slot));

  const messages: Message[] =
    resume && resume.messages.length > 0
      ? [...resume.messages]
      : [
          { role: 'system', content: deps.builderSystemPrompt },
          { role: 'user', content: spec.objective },
        ];

  // Accumulate tokens from the bus the builder already emits (no change to runAgent).
  let totalTokens = sumRoundTokens(resume?.rounds ?? []);
  const unsubscribe = deps.bus.subscribe((e) => {
    if (e.type === 'usage') totalTokens += e.inputTokens + e.outputTokens;
  });

  const initialRejects = countTrailingRejects(resume?.rounds ?? []);
  const breaker = new VerifierCircuitBreaker(initialRejects);
  const shadowSnapshots = createShadowSnapshotQueue(deps.shadowGit);
  const transitionAfterSnapshots = async (
    nextState: GoalState,
    haltReason: 'budget' | undefined = undefined,
  ): Promise<GoalState> => {
    await shadowSnapshots.drain();
    return transition(deps, goal, nextState, haltReason, stamp);
  };
  let round = resume?.rounds.length ?? 0;
  let totalTurns = sumRoundTurns(resume?.rounds ?? []);
  let finalVerdict: Verdict | undefined;
  let state: GoalState = 'active';

  try {
    if (initialRejects >= MAX_CONSECUTIVE_REJECTS) {
      deps.bus.emit({ type: 'halt', reason: 'guardrail' });
      state = await transitionAfterSnapshots(advanceGoalState('rejected', true));
    }
    while (state === 'active' && round < goal.budget.maxRounds) {
      round++;
      emitGoalRoundStart(deps, goal, round, totalTurns, totalTokens);

      const tokensBeforeRound = totalTokens;
      const outcome = await run({
        model: deps.model,
        tools: deps.tools,
        bus: deps.bus,
        messages,
        toolCtx: { cwd: deps.cwd, signal: deps.signal },
        budget: { maxTurns: deps.perRoundMaxTurns },
        context: deps.context,
        gate: deps.gate,
        hooks: deps.hooks,
        store: deps.store,
        signal: deps.signal,
      });
      totalTurns += outcome.turns;
      const roundTokens = totalTokens - tokensBeforeRound;
      // shadow-git: snapshot the working tree after this round's builder work (audit + rollback of what
      // the agent changed). Best-effort and OFF the verdict path — wait only for the shadow index capture
      // here, then let commit/rev-parse finish in the queue before terminal state/return.
      await shadowSnapshots.enqueue(`goal ${goal.id} round ${round}`);
      // Read (and clear) the claim the builder may have set via the update_goal tool this round.
      const claim = takeClaim(slot);

      // No completion claim this round → either out of budget, or nudge and keep going.
      if (claim === undefined) {
        await deps.goalStore?.recordRound({ round, turns: outcome.turns, tokens: roundTokens, at: stamp() });
        const budgetExceeded = overBudget(totalTurns, totalTokens, goal.budget) || round >= goal.budget.maxRounds;
        emitGoalRoundEnd(deps, goal, {
          round,
          turns: outcome.turns,
          roundTokens,
          totalTurns,
          totalTokens,
          state: budgetExceeded ? 'blocked' : 'active',
        });
        if (budgetExceeded) {
          state = await transitionAfterSnapshots('blocked', 'budget');
          break;
        }
        messages.push({
          role: 'user',
          content:
            '<continuation>目标尚未完成。继续推进——完成后调用 update_goal(complete)，卡住则 update_goal(blocked)。</continuation>',
        });
        continue;
      }

      if (claim.status === 'blocked') {
        state = await transitionAfterSnapshots('blocked');
        await deps.goalStore?.recordRound({ round, turns: outcome.turns, tokens: roundTokens, claim, at: stamp() });
        emitGoalRoundEnd(deps, goal, {
          round,
          turns: outcome.turns,
          roundTokens,
          totalTurns,
          totalTokens,
          claimStatus: claim.status,
          state,
        });
        break;
      }

      const { checks, persistedChecks, verdict } = await verifyGoalCompletion(goal, deps, check, runVerifierFn, resume !== undefined);
      finalVerdict = verdict;
      // NOTE: no verifier-health (couldNotVerify-rate) monitor here. That signal is inherently
      // CROSS-GOAL — within one goal, couldNotVerify is terminal (→ blocked), so a per-goal monitor can
      // never accumulate enough samples to trip and would be a dead guardrail. It belongs in a future
      // multi-goal session / Loop scheduler (where many goals share a verifier); deferred until then.
      // EventBus stays small + secret-free: only goalId/outcome/rationale, rationale redacted. The FULL
      // report (evidence/observed) goes to the local goalStore only, never the (potentially remote) bus.
      deps.bus.emit({ type: 'verdict', goalId: goal.id, outcome: verdict.outcome, rationale: redactSecrets(verdict.rationale) });
      await deps.goalStore?.recordRound({ round, turns: outcome.turns, tokens: roundTokens, claim, checks: persistedChecks, verdict, at: stamp() });

      if (verdict.outcome === 'rejected') {
        const action = breaker.recordReject(); // ← really read the breaker (no dead code)
        if (action === 'halt') {
          deps.bus.emit({ type: 'halt', reason: 'guardrail' });
          state = await transitionAfterSnapshots(advanceGoalState('rejected', true)); // forceBlocked
          emitGoalRoundEnd(deps, goal, {
            round,
            turns: outcome.turns,
            roundTokens,
            totalTurns,
            totalTokens,
            claimStatus: claim.status,
            verdict: verdict.outcome,
            state,
          });
          break;
        }
        const budgetExceeded = overBudget(totalTurns, totalTokens, goal.budget) || round >= goal.budget.maxRounds;
        state = budgetExceeded ? await transitionAfterSnapshots('blocked', 'budget') : advanceGoalState('rejected');
        if (!budgetExceeded) deps.bus.emit({ type: 'goal_state', goalId: goal.id, state });
        emitGoalRoundEnd(deps, goal, {
          round,
          turns: outcome.turns,
          roundTokens,
          totalTurns,
          totalTokens,
          claimStatus: claim.status,
          verdict: verdict.outcome,
          state,
        });
        if (budgetExceeded) break;
        messages.push({ role: 'user', content: continuationFromVerdict(checks, verdict) });
        continue;
      }

      state = await transitionAfterSnapshots(advanceGoalState(verdict.outcome));
      emitGoalRoundEnd(deps, goal, {
        round,
        turns: outcome.turns,
        roundTokens,
        totalTurns,
        totalTokens,
        claimStatus: claim.status,
        verdict: verdict.outcome,
        state,
      });
      break;
    }

    // Loop exited still active → ran out of rounds without verifying. Fail closed.
    if (state === 'active') {
      deps.bus.emit({ type: 'halt', reason: 'budget' });
      state = await transitionAfterSnapshots('blocked');
    }
  } finally {
    unsubscribe();
    await shadowSnapshots.drain();
  }

  goal = { ...goal, state };
  return { goal, state, rounds: round, tokens: totalTokens, finalVerdict };
}

function emitGoalRoundStart(
  deps: GoalRunDeps,
  goal: Goal,
  round: number,
  totalTurns: number,
  totalTokens: number,
): void {
  deps.bus.emit({
    type: 'goal_round_start',
    goalId: goal.id,
    round,
    maxRounds: goal.budget.maxRounds,
    totalTurns,
    ...optionalEventField('maxTotalTurns', goal.budget.maxTotalTurns),
    totalTokens,
    ...optionalEventField('maxTotalTokens', goal.budget.maxTotalTokens),
  });
}

function emitGoalRoundEnd(
  deps: GoalRunDeps,
  goal: Goal,
  input: {
    round: number;
    turns: number;
    roundTokens: number;
    totalTurns: number;
    totalTokens: number;
    claimStatus?: 'complete' | 'blocked';
    verdict?: 'verified' | 'rejected' | 'couldNotVerify';
    state: GoalState;
  },
): void {
  deps.bus.emit({
    type: 'goal_round_end',
    goalId: goal.id,
    round: input.round,
    turns: input.turns,
    roundTokens: input.roundTokens,
    totalTurns: input.totalTurns,
    ...optionalEventField('maxTotalTurns', goal.budget.maxTotalTurns),
    totalTokens: input.totalTokens,
    ...optionalEventField('maxTotalTokens', goal.budget.maxTotalTokens),
    maxRounds: goal.budget.maxRounds,
    ...optionalEventField('claimStatus', input.claimStatus),
    ...optionalEventField('verdict', input.verdict),
    state: input.state,
  });
}

function optionalEventField<K extends string, T>(key: K, value: T | undefined): { [P in K]: T } | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as { [P in K]: T };
}

/** Emit + persist a state transition. */
async function transition(
  deps: GoalRunDeps,
  goal: Goal,
  state: GoalState,
  haltReason: 'budget' | undefined,
  stamp: () => string,
): Promise<GoalState> {
  if (haltReason) deps.bus.emit({ type: 'halt', reason: haltReason });
  deps.bus.emit({ type: 'goal_state', goalId: goal.id, state });
  await deps.goalStore?.recordState(state, stamp());
  return state;
}

interface VerificationRun {
  checks: DeterministicChecks;
  persistedChecks: DeterministicChecks;
  verdict: Verdict;
}

async function verifyGoalCompletion(
  goal: Goal,
  deps: GoalRunDeps,
  check: (deps: CheckDeps, baseline?: TestBaseline) => Promise<DeterministicChecks>,
  runVerifierFn: NonNullable<GoalRunDeps['runVerifier']>,
  strictPinnedVerifier: boolean,
): Promise<VerificationRun> {
  // claim === complete → INDEPENDENT verification. Objective is immutable (fail closed if not).
  assertObjectiveUnchanged(goal.objective, goal.objectiveHash);
  const checks = await check(
    {
      shellPath: deps.shellPath,
      cwd: deps.cwd,
      checkCommands: deps.checkCommands ?? DEFAULT_CHECK_COMMANDS, // from config, NEVER the claim
      heldOutCommands: deps.heldOutCommands, // secret hidden assertions; from config, NEVER the claim
      worktreeBaseline: goal.worktreeBaseline,
      worktreeChangePolicy: deps.worktreeChangePolicy ?? 'audit',
      signal: deps.signal,
    },
    goal.testBaseline,
  );

  // All deterministic legs clean (leg 1 + leg 2 + held-out) before spawning the judge. A held-out
  // failure short-circuits leg 3 too (`heldOut?.passed ?? true` — absent held-out is not a failure).
  const worktreeClean = !(checks.worktreeStatus?.policy === 'forbid' && checks.worktreeStatus.changed);
  const legsClean =
    checks.objectiveChecksPassed && checks.testTamper === 'clean' && worktreeClean && (checks.heldOut?.passed ?? true);
  let report: VerifierReport | undefined;

  if (legsClean && deps.goalSetterRequirementRoutes !== undefined) {
    const sandboxChecks = await runConfiguredSandboxChecks(deps);
    const llmPinned = goal.pinned.filter((requirement) => deps.goalSetterRequirementRoutes?.get(requirement.id) === 'llm');
    let llmReport: VerifierReport | undefined;
    if (llmPinned.length > 0 && deps.verifierProvider) {
      deps.bus.emit({ type: 'state', phase: 'leg-3 verifier…' });
      llmReport = (await runVerifierFn(goal.objective, llmPinned, {
        verifierProvider: deps.verifierProvider,
        cwd: deps.cwd,
        maxTurns: deps.verifierMaxTurns ?? DEFAULT_VERIFIER_MAX_TURNS,
        signal: deps.signal,
      })) as VerifierReport | undefined;
      if (llmReport === undefined) llmReport = couldNotVerifyReport('leg 3 enabled but the verifier returned no report');
    }
    report = composeVerifierReport({
      pinned: goal.pinned,
      routes: deps.goalSetterRequirementRoutes,
      sandboxChecks,
      llmReport,
    });
  } else if (legsClean && deps.sandboxedRequirementCommands !== undefined) {
    report = reportFromSandboxedRequirementChecks(goal.pinned, await runConfiguredSandboxChecks(deps));
  } else if (legsClean && deps.verifierProvider) {
    deps.bus.emit({ type: 'state', phase: 'leg-3 verifier…' });
    report = await runVerifierFn(goal.objective, goal.pinned, {
      verifierProvider: deps.verifierProvider,
      cwd: deps.cwd,
      maxTurns: deps.verifierMaxTurns ?? DEFAULT_VERIFIER_MAX_TURNS,
      signal: deps.signal,
    });
  }

  if (legsClean && strictPinnedVerifier && !deps.verifierProvider && report === undefined && goal.pinned.length > 0) {
    report = couldNotVerifyReport('resumed goal has pinned requirements but no verifier provider is configured');
  }

  // Defense in depth (separate statement so TS does not narrow `report` to non-undefined): leg 3 is
  // enabled but the verifier returned no report — a misbehaving (mis-typed) injected runVerifier.
  // Fail CLOSED rather than let decideVerdict take the report===undefined → verified path on clean
  // legs. The default runVerifier never does this (it always synthesizes a report), so this only
  // backstops a contract violation — the cardinal sin here is a false-positive verified.
  if (legsClean && deps.verifierProvider && report === undefined) {
    report = couldNotVerifyReport('leg 3 enabled but the verifier returned no report');
  }

  const verdict = decideVerdict(checks, report, goal.pinned);
  const persistedChecks = persistableChecks(checks);
  return { checks, persistedChecks, verdict };
}

async function runConfiguredSandboxChecks(deps: GoalRunDeps): Promise<SandboxedRequirementCheck[]> {
  if (deps.sandboxedRequirementCommands === undefined) return [];
  deps.bus.emit({ type: 'state', phase: 'sandboxed verifier...' });
  if (deps.sandboxRunner === undefined) {
    return deps.sandboxedRequirementCommands.map((command) => ({
      requirementId: command.requirementId,
      command: command.command,
      result: sandboxUnavailableForCommand(deps.cwd, command.command),
    }));
  }
  return runSandboxedRequirementChecks({
    cwd: deps.cwd,
    runner: deps.sandboxRunner,
    commands: deps.sandboxedRequirementCommands,
  });
}

async function runSandboxedRequirementChecks(input: {
  cwd: string;
  runner: SandboxRunner;
  commands: readonly SandboxedRequirementCommand[];
}): Promise<SandboxedRequirementCheck[]> {
  const out: SandboxedRequirementCheck[] = [];
  for (const command of input.commands) {
    const request = sandboxRequestForCommand(input.cwd, command.command);
    const decision = validateSandboxInspectionCommand(command.command);
    const result: SandboxRunResult = decision.ok
      ? await input.runner.run(request)
      : {
          status: 'failed-to-start',
          backend: input.runner.backend,
          audit: {
            backend: input.runner.backend,
            command: request.command,
            cwd: request.cwd,
            mounts: request.mounts,
            networkMode: request.networkMode,
            limits: request.limits,
          },
          reason: `sandboxed requirement command rejected: ${decision.reason ?? 'not allowed'}`,
        };
    out.push({ requirementId: command.requirementId, command: command.command, result });
  }
  return out;
}

function sandboxRequestForCommand(cwd: string, command: string): SandboxRunRequest {
  const hardenedCommand = hardenSandboxInspectionCommand(command);
  return {
    command: ['bash', '--noprofile', '--norc', '-c', hardenedCommand],
    cwd: SANDBOX_CHECK_CWD,
    mounts: [{ hostPath: cwd, sandboxPath: SANDBOX_CHECK_CWD, access: 'read-only' }],
    networkMode: 'none',
    limits: SANDBOX_CHECK_LIMITS,
    reason: 'trusted per-requirement sandbox check',
  };
}

function sandboxUnavailableForCommand(cwd: string, command: string): SandboxRunResult {
  const request = sandboxRequestForCommand(cwd, command);
  return {
    status: 'unavailable',
    backend: 'unavailable',
    audit: {
      backend: 'unavailable',
      command: request.command,
      cwd: request.cwd,
      mounts: request.mounts,
      networkMode: request.networkMode,
      limits: request.limits,
    },
    reason: 'sandboxed requirement checks configured but no sandbox runner is configured',
  };
}

function persistableChecks(checks: DeterministicChecks): DeterministicChecks {
  // The goalStore lives UNDER cwd (data/goals/…), which the builder's read/grep/bash can read — so it
  // is NOT a safe sink for the held-out leg's secret command+output. Persist only pass/fail; dropping
  // `heldOut.results` keeps the hidden assertions hidden across rounds (replayGoal never reads them).
  return checks.heldOut ? { ...checks, heldOut: { passed: checks.heldOut.passed, results: [] } } : checks;
}

interface ShadowSnapshotQueue {
  enqueue(label: string): Promise<void>;
  drain(): Promise<void>;
}

/** Per-goal async shadow queue: enqueue waits only until the work-tree has been captured into the
 *  shadow index (preserving per-round labels), while commit/rev-parse drain in the background before
 *  the goal returns. */
function createShadowSnapshotQueue(shadowGit: ShadowSnapshotter | undefined): ShadowSnapshotQueue {
  let queue = Promise.resolve();
  return {
    async enqueue(label: string): Promise<void> {
      if (!shadowGit) return;
      let releaseCapture!: () => void;
      const captured = new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      queue = queue
        .then(async () => {
          const handle = startShadowSnapshot(shadowGit, label);
          const done = handle.done.catch(() => undefined);
          try {
            await handle.captured;
          } catch {
            // best-effort: a capture failure must not break the goal loop
          } finally {
            releaseCapture();
          }
          try {
            await done;
          } catch {
            // best-effort: a commit failure must not break the goal loop
          }
        })
        .catch(() => {
          releaseCapture();
        });
      await captured;
    },
    async drain(): Promise<void> {
      await queue;
    },
  };
}

function startShadowSnapshot(shadowGit: ShadowSnapshotter, label: string): ShadowSnapshotHandle {
  if (shadowGit.snapshotAsync) return shadowGit.snapshotAsync(label);
  const done = snapshotShadow(shadowGit, label);
  return { captured: done, done };
}

function assertResumeMatchesSpec(spec: GoalSpec, goal: Goal): void {
  if (goal.id !== spec.id) throw new Error('resumed goal id does not match the requested goal id');
  if (goal.sessionId !== spec.sessionId) throw new Error('resumed goal session id does not match the requested session id');
  if (!sameJson(goal.budget, spec.budget)) throw new Error('resumed goal budget does not match the requested goal budget');
  assertObjectiveUnchanged(spec.objective, goal.objectiveHash);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function countTrailingRejects(rounds: GoalRoundRecord[]): number {
  let count = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const outcome = rounds[i].verdict?.outcome;
    if (outcome === undefined) continue;
    if (outcome === 'rejected') {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function sumRoundTurns(rounds: GoalRoundRecord[]): number {
  return rounds.reduce((sum, round) => sum + (round.turns ?? 0), 0);
}

function sumRoundTokens(rounds: GoalRoundRecord[]): number {
  return rounds.reduce((sum, round) => sum + (round.tokens ?? 0), 0);
}

/** Best-effort shadow snapshot: never throws, never returns anything the loop acts on. Observability
 *  must not be able to break (or change the verdict of) the goal it observes. */
async function snapshotShadow(shadowGit: ShadowSnapshotter | undefined, label: string): Promise<void> {
  if (!shadowGit) return;
  try {
    await shadowGit.snapshot(label);
  } catch {
    // swallow — a snapshot failure is not a goal failure
  }
}

function overBudget(totalTurns: number, totalTokens: number, budget: GoalBudget): boolean {
  if (budget.maxTotalTurns !== undefined && totalTurns >= budget.maxTotalTurns) return true;
  if (budget.maxTotalTokens !== undefined && totalTokens >= budget.maxTotalTokens) return true;
  return false;
}

/** Build the rejection continuation from the REAL evidence, so the builder sees what failed. Covers a
 *  deterministic-leg reject (failed commands / tamper) AND a leg-3 reject (the judge's rationale +
 *  observed) — the latter only when the deterministic legs were clean, i.e. the reject came from leg 3. */
function continuationFromVerdict(checks: DeterministicChecks, verdict: Verdict): string {
  const parts: string[] = [
    '<verification_feedback>',
    '独立验收未通过。修复后再调用 update_goal(complete)。不要删改测试或验收脚本/配置来凑绿——会被检测并拒绝。',
  ];
  const failed = checks.results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    parts.push('以下检查需要修复（harness 实跑、真实退出码）：');
    parts.push(failed.map((r) => `$ ${r.command}\n[exit ${r.code ?? 'killed'}]\n${tail(r.output, 1500)}`).join('\n\n'));
  }
  if (checks.testTamper !== 'clean') parts.push(`[测试/验收脚本改动] ${checks.tamperReason}`);
  // A held-out reject: SECRET hidden assertions failed. Feed back ONLY a generic message — NEVER the
  // held-out command or its output, or the assertion stops being held-out (the builder could special-
  // case it next round). The point is to push real work, not to reveal which check to target.
  if (checks.heldOut && !checks.heldOut.passed) {
    parts.push(
      '[独立隐藏校验] 一项你看不到的隐藏验收检查未通过——实现并未真正满足需求。请做真正的修复，' +
        '不要针对具体测试做特例或弱化断言（隐藏检查你无法逐一规避）。',
    );
  }
  // A leg-3 reject: deterministic legs were clean, so the rejection is the judge's. Surface its reason
  // + what it observed so the builder can make a real fix (not a workaround).
  if (verdict.report && failed.length === 0 && checks.testTamper === 'clean' && (checks.heldOut?.passed ?? true)) {
    parts.push(`[独立裁判] ${verdict.rationale}`);
    if (verdict.report.observed) parts.push(`实际观察：${tail(verdict.report.observed, 1500)}`);
  }
  parts.push('</verification_feedback>');
  return parts.join('\n');
}

function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}
