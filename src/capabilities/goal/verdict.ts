/**
 * decideVerdict — the pure completion-verdict decision point (Phase D; Part7 §3.2).
 *
 * Given the two deterministic legs (harness-run objective checks + test-tamper scan) and an OPTIONAL
 * leg-3 verifier report, return verified | rejected | couldNotVerify. Pure: no spawn, no I/O, no
 * events — just the mapping, so every path (including the guardrails) is unit-testable.
 *
 * Two contracts the tests pin:
 *  - **fail-closed default**: the only path to `verified` is an EXPLICIT branch (both legs clean AND
 *    no report this batch). Any unrecognized combination falls to `couldNotVerify` — `verified` is
 *    never a fallback, so a future gap can't silently leak "done".
 *  - **deterministic legs first**: leg 1/leg 2 decide rejection BEFORE anything subjective, so they
 *    can't be bypassed by a prompt-injected report.
 *
 * Leg 3 (the independent LLM judge) is DEFERRED this batch. A present `report` is therefore treated
 * fail-closed (couldNotVerify) rather than scored — when leg 3 lands, this is where the full
 * evidence_strength × claim_scope table (Part7 §4) replaces that branch.
 */
import type { DeterministicChecks, Verdict, VerifierReport } from './goal.js';

export function decideVerdict(checks: DeterministicChecks, report?: VerifierReport): Verdict {
  // Leg 1 — harness re-ran the objective checks; a non-zero exit anywhere → rejected (deterministic,
  // unbypassable by injection). Builder's self-reported status was never consulted.
  if (!checks.objectiveChecksPassed) {
    return { outcome: 'rejected', rationale: 'objective checks failed (harness-run real exit codes)' };
  }
  // Leg 2 — tests deleted/skipped/weakened to go green → rejected (deterministic).
  if (checks.testTamper !== 'clean') {
    return {
      outcome: 'rejected',
      rationale: `tests tampered to go green: ${checks.tamperReason || 'weakened/deleted/skipped'}`,
    };
  }

  // Both deterministic legs clean. With NO leg-3 report (this batch), that is the ONLY path to
  // verified — an explicit branch, never a fallback.
  if (report === undefined) {
    return {
      outcome: 'verified',
      rationale:
        'deterministic checks passed (objective checks green + tests untampered); leg-3 LLM judge not enabled this batch',
    };
  }

  // A report arrived but leg 3 is not wired this batch → fail closed (do NOT score it here). When
  // leg 3 lands, replace this with the full evidence_strength × claim_scope verdict (Part7 §3.2/§4).
  return {
    outcome: 'couldNotVerify',
    rationale: 'leg-3 verifier report present but the LLM judge is not enabled this batch',
    report,
  };
}
