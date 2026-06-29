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
import { type AgentContext, type RunOutcome, runAgent } from '../../core/loop/run-agent.js';
import { redactSecrets } from '../../core/model/errors.js';
import { decideVerdict } from './verdict.js';
import { advanceGoalState } from './state.js';
import { DEFAULT_CHECK_COMMANDS, runDeterministicChecks, type CheckDeps } from './checks.js';
import { FileGoalStore, assertObjectiveUnchanged, hashObjective } from './goal-store.js';
import { createUpdateGoalTool, takeClaim, type ClaimSlot } from './update-goal-tool.js';
import { couldNotVerifyReport, runVerifier as defaultRunVerifier } from './verifier.js';
import { VerifierMonitor } from './verifier-monitor.js';
import type {
  DeterministicChecks,
  Goal,
  GoalBudget,
  GoalState,
  PinnedRequirement,
  TestBaseline,
  Verdict,
  VerifierReport,
} from './goal.js';

/** Consecutive rejects before the breaker halts the loop (borrowed A=3; Part7 §6.1). The sliding
 *  window is intentionally dropped this batch — in this state machine only rejected→active resets
 *  the counter, so the consecutive latch fires first anyway (Part7 §6.1 window-reachability note). */
const MAX_CONSECUTIVE_REJECTS = 3;

/** A pure-ish breaker: consecutive rejects → halt. Reset on any non-reject. Latches once. */
export class VerifierCircuitBreaker {
  private consecutive = 0;
  private tripped = false;
  recordReject(): 'continue' | 'halt' {
    this.consecutive++;
    if (!this.tripped && this.consecutive >= MAX_CONSECUTIVE_REJECTS) {
      this.tripped = true;
      return 'halt';
    }
    return 'continue';
  }
  recordNonReject(): void {
    this.consecutive = 0;
  }
}

export interface GoalSpec {
  id: string;
  objective: string;
  sessionId: string;
  budget: GoalBudget;
  /** Leg-2 baseline, snapshotted by the caller at creation (undefined → leg 2 inert). */
  baseline?: TestBaseline;
  /** Harness-pinned requirement list (leg 3), derived by the caller at creation. Omitted/empty →
   *  batch-1 deterministic-only (no verifier). The caller fail-closes on empty WHEN it configures a
   *  verifier, since decideVerdict step 5 makes verified unreachable for an empty list. */
  pinned?: PinnedRequirement[];
}

export interface GoalRunDeps {
  model: ModelProvider;
  /** The builder's tool registry. The `update_goal` tool is registered into it by runGoal. */
  tools: ToolRegistry;
  bus: EventBus;
  gate?: PermissionGate;
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
  heldOutCommands?: string[];
  /** Leg 3: the SECOND (independent, different-model) provider. Present → leg 3 runs after the
   *  deterministic legs pass; absent → batch-1 deterministic-only (decideVerdict's no-report path). */
  verifierProvider?: ModelProvider;
  /** The judge's per-run turn ceiling (read a few files, then report). Defaults to {@link DEFAULT_VERIFIER_MAX_TURNS}. */
  verifierMaxTurns?: number;
  signal?: AbortSignal;
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
  finalVerdict?: Verdict;
}

export async function runGoal(spec: GoalSpec, deps: GoalRunDeps): Promise<GoalRunResult> {
  const run = deps.run ?? runAgent;
  const check = deps.check ?? runDeterministicChecks;
  const runVerifierFn = deps.runVerifier ?? defaultRunVerifier;
  const monitor = new VerifierMonitor();
  const stamp = (): string => new Date().toISOString();

  const objectiveHash = hashObjective(spec.objective);
  const pinned: PinnedRequirement[] = spec.pinned ?? [];
  let goal: Goal = {
    id: spec.id,
    objective: spec.objective,
    objectiveHash,
    state: 'active',
    budget: spec.budget,
    testBaseline: spec.baseline,
    pinned,
    sessionId: spec.sessionId,
    createdAt: stamp(),
  };
  await deps.goalStore?.writeCreated({
    id: goal.id,
    objective: goal.objective,
    objectiveHash,
    budget: goal.budget,
    testBaseline: goal.testBaseline,
    pinned,
    sessionId: goal.sessionId,
    createdAt: goal.createdAt,
  });

  const slot: ClaimSlot = {};
  deps.tools.register(createUpdateGoalTool(slot));

  const messages: Message[] = [
    { role: 'system', content: deps.builderSystemPrompt },
    { role: 'user', content: spec.objective },
  ];

  // Accumulate tokens from the bus the builder already emits (no change to runAgent).
  let totalTokens = 0;
  const unsubscribe = deps.bus.subscribe((e) => {
    if (e.type === 'usage') totalTokens += e.inputTokens + e.outputTokens;
  });

  const breaker = new VerifierCircuitBreaker();
  let round = 0;
  let totalTurns = 0;
  let finalVerdict: Verdict | undefined;
  let state: GoalState = 'active';

  try {
    while (state === 'active' && round < goal.budget.maxRounds) {
      round++;

      const outcome = await run({
        model: deps.model,
        tools: deps.tools,
        bus: deps.bus,
        messages,
        toolCtx: { cwd: deps.cwd, signal: deps.signal },
        budget: { maxTurns: deps.perRoundMaxTurns },
        context: deps.context,
        gate: deps.gate,
        store: deps.store,
        signal: deps.signal,
      });
      totalTurns += outcome.turns;
      // Read (and clear) the claim the builder may have set via the update_goal tool this round.
      const claim = takeClaim(slot);

      // No completion claim this round → either out of budget, or nudge and keep going.
      if (claim === undefined) {
        if (overBudget(totalTurns, totalTokens, goal.budget)) {
          state = await transition(deps, goal, 'blocked', 'budget', stamp);
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
        state = await transition(deps, goal, 'blocked', undefined, stamp);
        await deps.goalStore?.recordRound({ round, claim, at: stamp() });
        break;
      }

      // claim === complete → INDEPENDENT verification. Objective is immutable (fail closed if not).
      assertObjectiveUnchanged(goal.objective, goal.objectiveHash);
      const checks = await check(
        {
          shellPath: deps.shellPath,
          cwd: deps.cwd,
          checkCommands: deps.checkCommands ?? DEFAULT_CHECK_COMMANDS, // from config, NEVER the claim
          heldOutCommands: deps.heldOutCommands, // secret hidden assertions; from config, NEVER the claim
          signal: deps.signal,
        },
        goal.testBaseline,
      );

      // Leg 3 — the independent judge. Runs ONLY if (a) a verifier provider is configured AND (b) the
      // deterministic legs are CLEAN. Short-circuit on a failed leg: don't spawn the judge (saves a
      // round-trip and gives a prompt injection no surface). HARD INVARIANT: when leg 3 is enabled and
      // legs are clean, runVerifierFn ALWAYS returns a report (its return type is non-optional;
      // runVerifier synthesizes couldNotVerify on every failure), so decideVerdict gets a report and can
      // never fall through to the report===undefined → verified batch-1 path.
      let report: VerifierReport | undefined;
      // All deterministic legs clean (leg 1 + leg 2 + held-out) before spawning the judge. A held-out
      // failure short-circuits leg 3 too (`heldOut?.passed ?? true` — absent held-out is not a failure).
      const legsClean =
        checks.objectiveChecksPassed && checks.testTamper === 'clean' && (checks.heldOut?.passed ?? true);
      if (legsClean && deps.verifierProvider) {
        deps.bus.emit({ type: 'state', phase: 'leg-3 verifier…' });
        report = await runVerifierFn(goal.objective, goal.pinned, {
          verifierProvider: deps.verifierProvider,
          cwd: deps.cwd,
          maxTurns: deps.verifierMaxTurns ?? DEFAULT_VERIFIER_MAX_TURNS,
          signal: deps.signal,
        });
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
      finalVerdict = verdict;
      // Health monitor: feed ONLY rounds where the judge actually ran (a deterministic reject is not
      // the verifier's verdict). A degraded couldNotVerify rate → a health warning, not silent escalation.
      if (report !== undefined && monitor.record(verdict.outcome) === 'degraded') {
        deps.bus.emit({ type: 'state', phase: 'verifier-health-degraded' });
      }
      // EventBus stays small + secret-free: only goalId/outcome/rationale, rationale redacted. The FULL
      // report (evidence/observed) goes to the local goalStore only, never the (potentially remote) bus.
      deps.bus.emit({ type: 'verdict', goalId: goal.id, outcome: verdict.outcome, rationale: redactSecrets(verdict.rationale) });
      // The goalStore lives UNDER cwd (data/goals/…), which the builder's read/grep/bash can read — so it
      // is NOT a safe sink for the held-out leg's secret command+output. Persist only pass/fail; dropping
      // `heldOut.results` keeps the hidden assertions hidden across rounds (replayGoal never reads them).
      const persistedChecks: DeterministicChecks = checks.heldOut
        ? { ...checks, heldOut: { passed: checks.heldOut.passed, results: [] } }
        : checks;
      await deps.goalStore?.recordRound({ round, claim, checks: persistedChecks, verdict, at: stamp() });

      if (verdict.outcome === 'rejected') {
        const action = breaker.recordReject(); // ← really read the breaker (no dead code)
        if (action === 'halt') {
          deps.bus.emit({ type: 'halt', reason: 'guardrail' });
          state = await transition(deps, goal, advanceGoalState('rejected', true), undefined, stamp); // forceBlocked
          break;
        }
        state = advanceGoalState('rejected'); // active — keep going with a continuation
        deps.bus.emit({ type: 'goal_state', goalId: goal.id, state });
        messages.push({ role: 'user', content: continuationFromVerdict(checks, verdict) });
        continue;
      }

      breaker.recordNonReject();
      state = await transition(deps, goal, advanceGoalState(verdict.outcome), undefined, stamp);
      break;
    }

    // Loop exited still active → ran out of rounds without verifying. Fail closed.
    if (state === 'active') {
      deps.bus.emit({ type: 'halt', reason: 'budget' });
      state = await transition(deps, goal, 'blocked', undefined, stamp);
    }
  } finally {
    unsubscribe();
  }

  goal = { ...goal, state };
  return { goal, state, rounds: round, finalVerdict };
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
