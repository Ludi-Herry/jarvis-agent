import type { EventBus } from '../../runtime/event-bus.js';
import type { VerdictOutcome } from './goal.js';
import {
  VerifierHealthMonitor,
  type GoalRunSummary,
  type LoopDeps,
  type LoopGoalAttempt,
  type LoopHaltReason,
  type LoopRunResult,
  type LoopSpec,
  type LoopStore,
  type VerifierOutcomeSample,
} from './loop.js';

const DEFAULT_VERIFIER_HEALTH_KEY = '__default__';

export interface ParallelLoopDeps {
  bus: EventBus;
  loopStore: LoopStore;
  maxParallel: number;
  runOne: (objective: string, goalId: string, attempt: LoopGoalAttempt) => Promise<ParallelGoalRunSummary>;
  signal?: AbortSignal;
  now?: () => number;
  stamp?: () => string;
  finished?: LoopDeps['finished'];
  outcomes?: LoopDeps['outcomes'];
  inFlight?: LoopDeps['inFlight'];
  consecutiveBlocked?: LoopDeps['consecutiveBlocked'];
  cumulativeTokens?: LoopDeps['cumulativeTokens'];
}

export type ParallelGoalRunSummary = GoalRunSummary & { tokens: number };

function sampleOutcome(sample: VerdictOutcome | VerifierOutcomeSample): VerdictOutcome {
  return typeof sample === 'string' ? sample : sample.outcome;
}

function sampleKey(sample: VerdictOutcome | VerifierOutcomeSample): string {
  return typeof sample === 'string' ? DEFAULT_VERIFIER_HEALTH_KEY : (sample.verifierKey ?? DEFAULT_VERIFIER_HEALTH_KEY);
}

/**
 * Parallel queue drain for worktree-isolated goals. This is still only a scheduler:
 * runOne remains the sole source of terminal goal state, and this module never imports
 * runGoal / decideVerdict / advanceGoalState.
 */
export async function runParallelLoop(spec: LoopSpec, deps: ParallelLoopDeps): Promise<LoopRunResult> {
  if (!Number.isInteger(deps.maxParallel) || deps.maxParallel < 1) {
    throw new Error('maxParallel must be a positive integer');
  }

  const now = deps.now ?? (() => Date.now());
  const stamp = deps.stamp ?? (() => new Date().toISOString());
  const c = spec.contract;
  const finished = deps.finished ?? new Set<number>();
  let goalsFinished = finished.size;
  let cumulativeTokens = deps.cumulativeTokens ?? 0;
  let consecutiveBlocked = deps.consecutiveBlocked ?? 0;

  const monitors = new Map<string, VerifierHealthMonitor>();
  const monitorFor = (key: string): VerifierHealthMonitor => {
    let monitor = monitors.get(key);
    if (monitor === undefined) {
      monitor = new VerifierHealthMonitor(c.cnvWindow, c.cnvThreshold);
      monitors.set(key, monitor);
    }
    return monitor;
  };
  const anyMonitorTripped = (): boolean => [...monitors.values()].some((monitor) => monitor.isTripped());
  for (const outcome of deps.outcomes ?? []) monitorFor(sampleKey(outcome)).record(sampleOutcome(outcome));

  const deadline = now() + c.maxWallClockMs;
  let started = 0;
  let completed = 0;
  let blocked = 0;
  let nextIndex = 0;
  let queueOrderCursor = 0;
  let reason: LoopHaltReason | undefined;
  let fatal: unknown;
  const active = new Set<Promise<void>>();
  const pendingQueueResults = new Map<number, ParallelGoalRunSummary>();

  while (finished.has(queueOrderCursor)) queueOrderCursor++;

  const preLaunchHalt = (): LoopHaltReason | undefined => {
    if (goalsFinished + active.size >= c.maxGoals) return 'max-goals';
    if (cumulativeTokens >= c.maxTotalTokens) return 'token-budget';
    if (now() >= deadline || deps.signal?.aborted) return 'wall-clock';
    if (consecutiveBlocked >= c.maxConsecutiveBlocked) return 'consecutive-blocked';
    if (anyMonitorTripped()) return 'verifier-health';
    return undefined;
  };

  const nextRunnableIndex = (): number | undefined => {
    while (nextIndex < spec.objectives.length) {
      const i = nextIndex++;
      if (!finished.has(i)) return i;
    }
    return undefined;
  };

  const advanceQueueOrderBreakers = (): void => {
    while (pendingQueueResults.has(queueOrderCursor)) {
      const result = pendingQueueResults.get(queueOrderCursor);
      pendingQueueResults.delete(queueOrderCursor);
      if (result?.state === 'complete') {
        consecutiveBlocked = 0;
      } else if (result?.outcome !== 'couldNotVerify') {
        consecutiveBlocked++;
        if (consecutiveBlocked >= c.maxConsecutiveBlocked) {
          reason ??= 'consecutive-blocked';
        }
      }
      queueOrderCursor++;
      while (finished.has(queueOrderCursor) && !pendingQueueResults.has(queueOrderCursor)) queueOrderCursor++;
    }
  };

  const launch = (index: number): void => {
    const promise = (async () => {
      const resumedGoalId = deps.inFlight?.get(index);
      const goalId = resumedGoalId ?? `${spec.id}-g${index}-${stamp()}`;
      await deps.loopStore.recordStarted({ index, goalId, at: stamp() });
      deps.bus.emit({ type: 'state', phase: `loop goal ${index + 1}/${spec.objectives.length}` });
      started++;

      const result = await deps.runOne(spec.objectives[index], goalId, { index, resumed: resumedGoalId !== undefined });
      const tokens = checkedTokens(result);
      await deps.loopStore.recordFinished({
        index,
        goalId,
        state: result.state,
        outcome: result.outcome,
        verifierKey: result.verifierKey,
        rounds: result.rounds,
        tokens,
        at: stamp(),
      });

      finished.add(index);
      goalsFinished++;
      cumulativeTokens += tokens;

      if (result.state === 'complete') {
        completed++;
      } else {
        blocked++;
      }
      pendingQueueResults.set(index, result);
      advanceQueueOrderBreakers();
      if (
        result.outcome !== undefined &&
        monitorFor(result.verifierKey ?? DEFAULT_VERIFIER_HEALTH_KEY).record(result.outcome) === 'halt'
      ) {
        reason ??= 'verifier-health';
      }
    })()
      .catch((err: unknown) => {
        fatal ??= err;
      })
      .finally(() => {
        active.delete(promise);
      });
    active.add(promise);
  };

  while (reason === undefined && fatal === undefined) {
    while (active.size < deps.maxParallel && reason === undefined && fatal === undefined) {
      if (pendingQueueResults.size > 0) break;
      const halt = preLaunchHalt();
      if (halt !== undefined) {
        reason = halt;
        break;
      }
      const index = nextRunnableIndex();
      if (index === undefined) break;
      launch(index);
    }

    if (active.size === 0) break;
    await Promise.race(active);
  }

  if (fatal !== undefined) {
    await Promise.allSettled(active);
    throw fatal;
  }

  if (active.size > 0) await Promise.allSettled(active);
  if (reason === undefined) reason = 'queue-empty';

  deps.bus.emit({ type: 'loop_halt', loopId: spec.id, reason });
  await deps.loopStore.recordHalted(reason, stamp());
  return { loopId: spec.id, reason, started, completed, blocked, goalsFinished, cumulativeTokens };
}

function checkedTokens(result: GoalRunSummary): number {
  if (typeof result.tokens !== 'number' || !Number.isFinite(result.tokens) || result.tokens < 0) {
    throw new Error('parallel run summary must include a non-negative tokens total');
  }
  return result.tokens;
}
