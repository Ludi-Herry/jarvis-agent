/**
 * advanceGoalState — the pure verdict → next-state mapping (Phase D; Part7 §3.3).
 *
 * One small total function, unit-testable in isolation (AGENTS.md: decision points are pure
 * functions + tests). The `assertNever` makes a future verdict outcome a COMPILE error here rather
 * than a silent fall-through, so the state machine can never quietly mishandle a new case.
 */
import type { GoalState, VerdictOutcome } from './goal.js';

/**
 * Map a verifier verdict to the goal's next state. `forceBlocked` is the circuit-breaker's escape
 * hatch (a halt routes straight to `blocked`, bypassing the normal mapping). Default mapping:
 *  - verified       → complete   (a real, independently-checked finish)
 *  - checksOnly     → blocked    (project checks passed; objective completion still needs evidence)
 *  - rejected       → active     (keep going, with a continuation carrying what was observed)
 *  - couldNotVerify → blocked    (fail-closed: hand to a human, NEVER treat as passed)
 */
export function advanceGoalState(outcome: VerdictOutcome, forceBlocked = false): GoalState {
  if (forceBlocked) return 'blocked';
  switch (outcome) {
    case 'verified':
      return 'complete';
    case 'checksOnly':
      return 'blocked';
    case 'rejected':
      return 'active';
    case 'couldNotVerify':
      return 'blocked';
    default:
      return assertNever(outcome);
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable verdict outcome: ${String(x)}`);
}
