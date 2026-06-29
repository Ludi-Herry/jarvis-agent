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
import { decideVerdict } from './verdict.js';
import { advanceGoalState } from './state.js';
import { DEFAULT_CHECK_COMMANDS, runDeterministicChecks, type CheckDeps } from './checks.js';
import { FileGoalStore, assertObjectiveUnchanged, hashObjective } from './goal-store.js';
import { createUpdateGoalTool, takeClaim, type ClaimSlot } from './update-goal-tool.js';
import type {
  DeterministicChecks,
  Goal,
  GoalBudget,
  GoalState,
  TestBaseline,
  Verdict,
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
  signal?: AbortSignal;
  /** Injected for tests; default {@link runAgent} / {@link runDeterministicChecks}. */
  run?: (ctx: AgentContext) => Promise<RunOutcome>;
  check?: (deps: CheckDeps, baseline?: TestBaseline) => Promise<DeterministicChecks>;
}

export interface GoalRunResult {
  goal: Goal;
  state: GoalState;
  rounds: number;
  finalVerdict?: Verdict;
}

export async function runGoal(spec: GoalSpec, deps: GoalRunDeps): Promise<GoalRunResult> {
  const run = deps.run ?? runAgent;
  const check = deps.check ?? runDeterministicChecks;
  const stamp = (): string => new Date().toISOString();

  const objectiveHash = hashObjective(spec.objective);
  let goal: Goal = {
    id: spec.id,
    objective: spec.objective,
    objectiveHash,
    state: 'active',
    budget: spec.budget,
    testBaseline: spec.baseline,
    sessionId: spec.sessionId,
    createdAt: stamp(),
  };
  await deps.goalStore?.writeCreated({
    id: goal.id,
    objective: goal.objective,
    objectiveHash,
    budget: goal.budget,
    testBaseline: goal.testBaseline,
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
          signal: deps.signal,
        },
        goal.testBaseline,
      );
      const verdict = decideVerdict(checks); // no leg-3 report this batch
      finalVerdict = verdict;
      deps.bus.emit({ type: 'verdict', goalId: goal.id, outcome: verdict.outcome, rationale: verdict.rationale });
      await deps.goalStore?.recordRound({ round, claim, checks, verdict, at: stamp() });

      if (verdict.outcome === 'rejected') {
        const action = breaker.recordReject(); // ← really read the breaker (no dead code)
        if (action === 'halt') {
          deps.bus.emit({ type: 'halt', reason: 'guardrail' });
          state = await transition(deps, goal, advanceGoalState('rejected', true), undefined, stamp); // forceBlocked
          break;
        }
        state = advanceGoalState('rejected'); // active — keep going with a continuation
        deps.bus.emit({ type: 'goal_state', goalId: goal.id, state });
        messages.push({ role: 'user', content: continuationFromChecks(checks) });
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

/** Build the rejection continuation from the REAL check output, so the builder sees what failed. */
function continuationFromChecks(checks: DeterministicChecks): string {
  const failed = checks.results.filter((r) => r.code !== 0);
  const blocks = failed.map((r) => `$ ${r.command}\n[exit ${r.code ?? 'killed'}]\n${tail(r.output, 1500)}`);
  const tamper = checks.testTamper !== 'clean' ? `\n[测试改动] ${checks.tamperReason}` : '';
  return [
    '<verification_feedback>',
    '独立验收未通过。以下检查需要修复（harness 实跑、真实退出码）：',
    blocks.join('\n\n'),
    tamper,
    '修复后再调用 update_goal(complete)。不要删改测试来凑绿——会被检测并拒绝。',
    '</verification_feedback>',
  ].join('\n');
}

function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}
