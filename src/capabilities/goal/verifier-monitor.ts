/**
 * VerifierMonitor — couldNotVerify-rate health monitor for leg 3 (Phase D; Part7 §6.3).
 *
 * A lazy judge that always answers `couldNotVerify` would silently escalate every goal to a human and
 * train the operator into blanket-approval (the "cognitive surrender" red line). This monitor watches
 * the recent rate of `couldNotVerify` verdicts and reports `degraded` when it crosses a threshold, so
 * the harness can warn (emit a health event) rather than fail silently.
 *
 * It is fed ONLY on rounds where leg 3 actually ran — a deterministic-leg rejection (objective checks
 * failed / tests tampered) is not the verifier's verdict and must not pollute the rate. `record` is
 * pure-ish (a small sliding window, no I/O): it returns `ok`/`degraded` and the caller emits the event,
 * so the threshold logic is unit-testable without a bus (the "guardrail needs a trigger test" rule).
 */
import type { VerdictOutcome } from './goal.js';

/** Recent verdicts kept in the window. */
const MONITOR_WINDOW = 10;
/** Need at least this many samples before judging health (a tiny early sample isn't a trend). */
const MONITOR_MIN_SAMPLES = 4;
/** couldNotVerify share above this → degraded. */
const CNV_RATE_ALERT = 0.6;

export class VerifierMonitor {
  private readonly window: VerdictOutcome[] = [];

  /** Record one leg-3 verdict and report current health. Call ONLY on rounds where the verifier ran. */
  record(outcome: VerdictOutcome): 'ok' | 'degraded' {
    this.window.push(outcome);
    if (this.window.length > MONITOR_WINDOW) this.window.shift();
    if (this.window.length < MONITOR_MIN_SAMPLES) return 'ok';
    const cnv = this.window.filter((o) => o === 'couldNotVerify').length;
    return cnv / this.window.length > CNV_RATE_ALERT ? 'degraded' : 'ok';
  }
}
