/**
 * decideVerdict — the pure completion-verdict decision point (Phase D; Part7 §3.2 / §4).
 *
 * Given the two deterministic legs (harness-run objective checks + test-tamper scan), an OPTIONAL
 * leg-3 verifier report, and the harness-pinned requirement list, return
 * verified | rejected | couldNotVerify. Pure: no spawn, no I/O, no events — just the mapping, so
 * every path (including the guardrails) is unit-testable.
 *
 * Three contracts the tests pin:
 *  - **deterministic legs first**: leg 1/leg 2 decide rejection BEFORE anything subjective, so a
 *    prompt-injected report can never bypass them ("judge ≠ player" — the unbypassable layer).
 *  - **fail-closed default**: `verified` is only ever an EXPLICIT branch (deterministic legs clean
 *    AND — with a report — every requirement proves+matched, feature works, list non-empty, nothing
 *    could-not-verify). Any unrecognized combination falls to `couldNotVerify`; `verified` is never a
 *    fallback, so a future gap can't silently leak "done".
 *  - **single source of verdict**: the verdict is computed HERE from the report's evidence fields, not
 *    self-reported by the LLM (the schema deliberately has no `verdict` field) — eliminating the
 *    double source of truth that lets an injected "verdict: verified" override the evidence.
 *
 * Two leg-3 states:
 *  - `report === undefined` → the batch-1 deterministic-only fallback (no verifier configured). This
 *    whole branch is UNCHANGED from before leg 3 landed: legs clean ⇒ verified, explicitly.
 *  - `report` present → score it over the evidence_strength × claim_scope table (Part7 §4), with the
 *    pinned requirement list as the coverage contract.
 */
import type { DeterministicChecks, PinnedRequirement, Verdict, VerifierReport } from './goal.js';

export function decideVerdict(
  checks: DeterministicChecks,
  report?: VerifierReport,
  pinned: PinnedRequirement[] = [],
): Verdict {
  // Leg 1 — harness re-ran the objective checks; a non-zero exit anywhere → rejected (deterministic,
  // unbypassable by injection). Builder's self-reported status was never consulted. (Part7 §4 step 1.)
  if (!checks.objectiveChecksPassed) {
    return { outcome: 'rejected', rationale: 'objective checks failed (harness-run real exit codes)' };
  }
  // Leg 2 — tests/oracle deleted/skipped/weakened to go green → rejected (deterministic). (step 2.)
  if (checks.testTamper !== 'clean') {
    return {
      outcome: 'rejected',
      rationale: `tests tampered to go green: ${checks.tamperReason || 'weakened/deleted/skipped'}`,
    };
  }

  // Both deterministic legs clean. With NO leg-3 report (no verifier configured), that is the ONLY
  // path to verified — an explicit branch, never a fallback. UNCHANGED from batch 1.
  if (report === undefined) {
    return {
      outcome: 'verified',
      rationale:
        'deterministic checks passed (objective checks green + tests untampered); no leg-3 verifier configured',
    };
  }

  // ── Leg 3 present: score the report (Part7 §3.2 steps 3-8 / §4 table). The verdict is computed from
  // the evidence fields here — the report carries NO self-reported verdict to honor. ──

  // Step 3 — coverage completeness: every pinned requirement must be scored. A missing one (or an
  // empty pinned list, where verified is unreachable) → couldNotVerify (fail-closed, never silently
  // verified). This is also where a verifier that tried to narrow the requirement set is caught.
  const covered = new Set(report.perRequirement.map((r) => r.requirementId));
  const missing = pinned.filter((p) => !covered.has(p.id));
  if (missing.length > 0) {
    return {
      outcome: 'couldNotVerify',
      rationale: `verifier did not score every pinned requirement: ${missing.map((m) => m.text).join('; ')}`,
      report,
    };
  }

  // Step 4 — hard fail before couldNotVerify (Part7 §4 priority fix P2): a feature observed broken, or
  // any requirement contradicted/incomplete/missing, means "materially not done" → reject back to the
  // builder (NOT park to a human). Outranks couldNotVerify so "clearly broken + one unverified item"
  // goes back to the builder to fix, not to a human to babysit.
  const hardFail = report.perRequirement.find(
    (r) => r.strength === 'contradicts' || r.strength === 'incomplete' || r.strength === 'missing',
  );
  if (report.feature === 'broken' || hardFail) {
    return {
      outcome: 'rejected',
      rationale: hardFail
        ? `requirement not met (${hardFail.strength}): ${reqText(pinned, hardFail.requirementId)}`
        : `verifier observed the feature broken: ${report.rationale || report.observed}`,
      report,
    };
  }

  // Step 5 — couldNotVerify[] non-empty (and no hard fail) → park to a human. Things the verifier
  // genuinely could not check locally (real external accounts, human visual judgment) must never
  // collapse into "done".
  if (report.couldNotVerify.length > 0) {
    return {
      outcome: 'couldNotVerify',
      rationale: `verifier could not verify: ${report.couldNotVerify.join('; ')}`,
      report,
    };
  }

  // Step 6 — evidence too weak, or a narrow check stretched to support a broad claim → couldNotVerify
  // (fail-closed). The claim_scope axis is what blocks "a green unit test proves the whole feature".
  const weak = report.perRequirement.find(
    (r) => r.strength === 'tooWeak' || r.scope === 'narrowerThanClaim',
  );
  if (weak) {
    return {
      outcome: 'couldNotVerify',
      rationale: `evidence too weak or narrower than the claim for: ${reqText(pinned, weak.requirementId)}`,
      report,
    };
  }

  // Step 7 — the one narrow path to verified: every requirement proves+matched, feature works, the
  // pinned list is non-empty, and (by steps 3-6) nothing is unscored / contradicted / could-not-verify
  // / too-weak / narrow. `pinned.length > 0` is the guard that keeps verified unreachable for an empty
  // list (so an empty-pinned goal is provably never a false positive).
  const allProvenMatched =
    pinned.length > 0 &&
    report.perRequirement.every((r) => r.strength === 'proves' && r.scope === 'matched');
  if (report.feature === 'works' && allProvenMatched) {
    return {
      outcome: 'verified',
      rationale: report.rationale || 'every pinned requirement proven, scope matched, checks clean',
      report,
    };
  }

  // Step 8 — any unrecognized combination → couldNotVerify. verified is NEVER a fallback.
  return {
    outcome: 'couldNotVerify',
    rationale: 'unrecognized evidence combination; failing closed',
    report,
  };
}

/** A pinned requirement's text by id (for a readable rationale), or the bare id if not found. */
function reqText(pinned: PinnedRequirement[], id: string): string {
  return pinned.find((p) => p.id === id)?.text ?? id;
}
