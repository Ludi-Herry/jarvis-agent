/**
 * Loop — the multi-goal OUTER loop over runGoal (Phase E; the prompt → goal → LOOP progression).
 *
 * runGoal drives ONE goal to a terminal state (complete | blocked) and is the SOLE authority on
 * completion — it verifies independently (deterministic legs + optional LLM judge + decideVerdict),
 * never the builder's self-report. runLoop sits ABOVE it: it drains a durable queue of objectives,
 * runs each through the injected `runOne` (production wires it to runGoal, UNCHANGED), records the
 * orchestration to a loop log, and self-stops at a verifiable, numeric stop condition.
 *
 * ZERO completion authority is the load-bearing safety property: this module NEVER imports
 * decideVerdict / advanceGoalState / runGoal and NEVER writes a 'complete' state. `completed` is a
 * verbatim count of runGoal's own `state === 'complete'`, so the loop cannot manufacture a success
 * the verification legs did not grant. The only new authority the loop has is to STOP (halt to a
 * human) — always the safe direction.
 *
 * The cross-goal {@link VerifierHealthMonitor} lands here, where many goals share one verifier — the
 * landing spot goal-loop.ts left a note for. couldNotVerify is terminal WITHIN one goal (a per-goal
 * monitor could never accumulate samples — it was deleted as a dead guardrail), but ACROSS goals its
 * rate is a real signal that the shared judge is broken.
 */
import type { EventBus } from '../../runtime/event-bus.js';
import type { GoalBudget, GoalState, VerdictOutcome } from './goal.js';

/** The durable loop budget — persisted in the loop log's `loop-created` record so a resume is
 *  faithful. Every field is a HARD ceiling; cumulative ones (maxGoals / maxTotalTokens) seed from
 *  the replayed log so a resume can never reset a ceiling. */
export interface LoopContract {
  /** Cumulative cap on FINISHED goals (seeded from replay). */
  maxGoals: number;
  /** Cumulative cap on BUILDER-STREAM tokens (summed from the bus `usage` events; seeded from replay).
   *  Checked BETWEEN goals, and a single goal is additionally bounded by {@link perGoalBudget}, so the
   *  real ceiling is cumulative + at most one perGoalBudget. NOTE: the leg-3 judge and pinned-derivation
   *  spend is off this bus and is NOT counted here — when leg 3 is on, true API spend exceeds this. */
  maxTotalTokens: number;
  /** Wall-clock cap PER invocation (checked between goals; not cumulative — a crashed/idle process
   *  burns no wall-clock, stated honestly). */
  maxWallClockMs: number;
  /** Consecutive blocked goals (couldNotVerify is NEUTRAL to this — see {@link VerifierHealthMonitor}). */
  maxConsecutiveBlocked: number;
  /** Cross-goal health window size W. */
  cnvWindow: number;
  /** couldNotVerify count within the window W that trips the health halt. */
  cnvThreshold: number;
  /** Handed to EVERY runGoal call (e.g. { maxRounds: 8 }) — total work is bounded both per-goal and per-loop. */
  perGoalBudget: GoalBudget;
}

/** Why the loop stopped. All six are numeric/verifiable and recorded as `loop-halted`. */
export type LoopHaltReason =
  | 'queue-empty'
  | 'max-goals'
  | 'token-budget'
  | 'wall-clock'
  | 'consecutive-blocked'
  | 'verifier-health';

/** The narrow slice of a goal run the loop needs — decouples the loop from the full Goal/GoalRunResult
 *  type and (deliberately) gives it NO handle on anything that could fake completion. */
export interface GoalRunSummary {
  state: GoalState;
  /** The verifier outcome, present only when leg 3 ran and produced one (→ feeds the health monitor). */
  outcome?: VerdictOutcome;
  rounds: number;
  /** Full builder-token total for this goal attempt, including any pre-crash resumed rounds. */
  tokens?: number;
}

export interface LoopGoalAttempt {
  index: number;
  resumed: boolean;
}

export interface LoopSpec {
  id: string;
  /** Queue of objectives. A queue item's identity is its INDEX here (not a goalId), so resume keys
   *  off position and an in-flight crashed goal can resume under its latest started goalId. */
  objectives: string[];
  contract: LoopContract;
}

/** The append-only sink the loop records orchestration to (FileLoopStore implements it). Kept as a
 *  minimal interface here so loop.ts has no dependency on loop-store.ts (one-way: store → loop). */
export interface LoopStore {
  recordStarted(record: { index: number; goalId: string; at: string }): Promise<void>;
  recordFinished(record: {
    index: number;
    goalId: string;
    state: GoalState;
    outcome?: VerdictOutcome;
    rounds: number;
    tokens: number;
    at: string;
  }): Promise<void>;
  recordHalted(reason: LoopHaltReason, at: string): Promise<void>;
}

export interface LoopDeps {
  bus: EventBus;
  loopStore: LoopStore;
  /** The ONLY seam: production wires it to a closure that calls the real runGoal; tests inject a fake
   *  to drive outcomes. The objective + a per-attempt goalId go in; a {@link GoalRunSummary} comes out. */
  runOne: (objective: string, goalId: string, attempt: LoopGoalAttempt) => Promise<GoalRunSummary>;
  signal?: AbortSignal;
  now?: () => number;
  stamp?: () => string;
  // ── Resume seeds (all empty/zero for a fresh loop; reconstructed by replayLoop on --resume) ──
  /** Indices already FINISHED — never re-run. */
  finished?: Set<number>;
  /** Past verifier outcomes (in finish order) — re-warms the health monitor window. */
  outcomes?: VerdictOutcome[];
  /** Started attempts without a goal-finished record; resume should reuse these goal ids. */
  inFlight?: Map<number, string>;
  /** Consecutive blocked count carried across the restart. */
  consecutiveBlocked?: number;
  /** Tokens already spent across finished goals (seeds the cumulative budget). */
  cumulativeTokens?: number;
}

export interface LoopRunResult {
  loopId: string;
  reason: LoopHaltReason;
  /** Goals STARTED this invocation. */
  started: number;
  /** Goals that finished `complete` this invocation. */
  completed: number;
  /** Goals that finished `blocked` this invocation. */
  blocked: number;
  /** Cumulative FINISHED goals (seed + this run) — the value the maxGoals ceiling is measured against. */
  goalsFinished: number;
  /** Cumulative tokens (seed + this run). */
  cumulativeTokens: number;
}

/**
 * Cross-goal verifier-health monitor. Records only DEFINED verifier outcomes (a goal that blocked on
 * budget/breaker carries `undefined` and is NOT a sample), keeps a sliding window of the last W, and
 * halts when ≥ T of them are couldNotVerify — a shared judge that keeps failing to decide is broken,
 * and feeding the rest of the queue to it would waste budget, so the loop stops to a human.
 *
 * couldNotVerify is deliberately NEUTRAL to the consecutive-blocked counter (it neither increments nor
 * resets it; only a `complete` resets). Otherwise a run of couldNotVerify goals would trip
 * consecutive-blocked FIRST and starve this monitor (the W-window never fills) — and misreport the
 * cause as "needs a human to unstick" instead of "the judge is down".
 */
export class VerifierHealthMonitor {
  private readonly window: boolean[] = [];

  constructor(
    private readonly W: number,
    private readonly T: number,
  ) {}

  record(outcome?: VerdictOutcome): 'continue' | 'halt' {
    if (outcome === undefined) return 'continue'; // no verifier verdict → not a health sample
    this.window.push(outcome === 'couldNotVerify');
    if (this.window.length > this.W) this.window.shift();
    return this.isTripped() ? 'halt' : 'continue';
  }

  /** True when the current window already holds >= T couldNotVerify. Lets a resumed loop re-assert the
   *  halt against its re-warmed window BEFORE running another goal (so a crash that lost the loop-halted
   *  record can't let the loop slip past the human checkpoint). */
  isTripped(): boolean {
    return this.window.filter(Boolean).length >= this.T;
  }
}

/**
 * Drain the queue to a stop condition. Structurally mirrors runGoal: injected deps, a try/finally
 * around one loop, emit + persist on every transition. The CLI writes the `loop-created` header
 * BEFORE calling runLoop (like goal-cli writes the session header outside runGoal), so runLoop only
 * ever APPENDS started/finished/halted and needs no resume flag.
 */
export async function runLoop(spec: LoopSpec, deps: LoopDeps): Promise<LoopRunResult> {
  const now = deps.now ?? (() => Date.now());
  const stamp = deps.stamp ?? (() => new Date().toISOString());
  const c = spec.contract;

  const finished = deps.finished ?? new Set<number>();
  let goalsFinished = finished.size; // cumulative (seed from replay)
  let cumulativeTokens = deps.cumulativeTokens ?? 0; // cumulative (seed from replay)
  let consecutiveBlocked = deps.consecutiveBlocked ?? 0;

  const monitor = new VerifierHealthMonitor(c.cnvWindow, c.cnvThreshold);
  for (const o of deps.outcomes ?? []) monitor.record(o); // re-warm the window from replayed outcomes

  // Same cross-goal token accounting runGoal does per-goal (sum the bus `usage` events).
  let runTokens = 0;
  const unsubscribe = deps.bus.subscribe((e) => {
    if (e.type === 'usage') runTokens += e.inputTokens + e.outputTokens;
  });

  const deadline = now() + c.maxWallClockMs;
  let started = 0;
  let completed = 0;
  let blocked = 0;
  let reason: LoopHaltReason | undefined;

  try {
    for (let i = 0; i < spec.objectives.length; i++) {
      if (finished.has(i)) continue; // resume: never re-run a finished goal

      // Hard ceilings — each a numeric break, none advisory.
      if (goalsFinished >= c.maxGoals) {
        reason = 'max-goals';
        break;
      }
      if (cumulativeTokens >= c.maxTotalTokens) {
        reason = 'token-budget';
        break;
      }
      if (now() >= deadline || deps.signal?.aborted) {
        reason = 'wall-clock';
        break;
      }
      // Re-assert the human-checkpoint guards against SEEDED state (not just post-goal): on a --resume
      // whose loop-halted record never flushed (a crash at the halt boundary), the breaker / monitor are
      // re-warmed from replay and must halt BEFORE running another goal — otherwise a completing goal
      // would reset the breaker and the loop would sail past the human checkpoint. On a fresh run both
      // are no-ops (the post-goal checks below already broke on the triggering goal).
      if (consecutiveBlocked >= c.maxConsecutiveBlocked) {
        reason = 'consecutive-blocked';
        break;
      }
      if (monitor.isTripped()) {
        reason = 'verifier-health';
        break;
      }

      const resumedGoalId = deps.inFlight?.get(i);
      const goalId = resumedGoalId ?? `${spec.id}-g${i}-${stamp()}`;
      await deps.loopStore.recordStarted({ index: i, goalId, at: stamp() });
      deps.bus.emit({ type: 'state', phase: `loop · goal ${i + 1}/${spec.objectives.length}` });
      started++;

      const before = runTokens;
      const result = await deps.runOne(spec.objectives[i], goalId, { index: i, resumed: resumedGoalId !== undefined }); // ← runGoal, the SOLE completer
      const tokens = result.tokens ?? runTokens - before;
      const outcome = result.outcome;

      await deps.loopStore.recordFinished({
        index: i,
        goalId,
        state: result.state,
        outcome,
        rounds: result.rounds,
        tokens,
        at: stamp(),
      });
      finished.add(i);
      goalsFinished++;
      cumulativeTokens += tokens;

      if (result.state === 'complete') {
        completed++;
        consecutiveBlocked = 0;
      } else {
        blocked++;
        if (outcome !== 'couldNotVerify') consecutiveBlocked++; // cnv is neutral to consecutive-blocked
      }

      if (consecutiveBlocked >= c.maxConsecutiveBlocked) {
        reason = 'consecutive-blocked';
        break;
      }
      if (monitor.record(outcome) === 'halt') {
        reason = 'verifier-health';
        break;
      }
    }
    if (reason === undefined) reason = 'queue-empty'; // drained the whole tail
  } finally {
    unsubscribe();
  }

  deps.bus.emit({ type: 'loop_halt', loopId: spec.id, reason });
  await deps.loopStore.recordHalted(reason, stamp());
  return { loopId: spec.id, reason, started, completed, blocked, goalsFinished, cumulativeTokens };
}
