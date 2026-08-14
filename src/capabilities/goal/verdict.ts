/**
 * decideVerdict — the pure completion-verdict decision point (Phase D; Part7 §3.2 / §4).
 *
 * Given the two deterministic legs (harness-run objective checks + test-tamper scan), an OPTIONAL
 * leg-3 verifier report, and the harness-pinned requirement list, return
 * verified | checksOnly | rejected | couldNotVerify. Pure: no spawn, no I/O, no events — just the mapping, so
 * every path (including the guardrails) is unit-testable.
 *
 * Three contracts the tests pin:
 *  - **deterministic legs first**: leg 1 / leg 2 / the held-out leg decide rejection BEFORE anything
 *    subjective, so a prompt-injected report can never bypass them ("judge ≠ player" — the unbypassable
 *    layer). The held-out leg is the secret hidden-assertion check: a builder that wrote weak tests to
 *    pass leg 1 is caught here, by assertions it never saw.
 *  - **fail-closed default**: `verified` is only ever an EXPLICIT branch (deterministic legs clean
 *    AND — with a report — every requirement proves+matched, feature works, list non-empty, nothing
 *    could-not-verify). Any unrecognized combination falls to `couldNotVerify`; `verified` is never a
 *    fallback, so a future gap can't silently leak "done".
 *  - **single source of verdict**: the verdict is computed HERE from the report's evidence fields, not
 *    self-reported by the LLM (the schema deliberately has no `verdict` field) — eliminating the
 *    double source of truth that lets an injected "verdict: verified" override the evidence.
 *
 * Two leg-3 states:
 *  - `report === undefined` → routine project checks alone produce `checksOnly`; a passed held-out
 *    objective check is required for deterministic-only `verified`.
 *  - `report` present → score it over the evidence_strength × claim_scope table (Part7 §4), with the
 *    pinned requirement list as the coverage contract.
 */
import type { DeterministicChecks, PinnedRequirement, Verdict, VerifierReport } from './goal.js';

export function decideVerdict(
  checks: DeterministicChecks,
  report?: VerifierReport,
  pinned: PinnedRequirement[] = [],
): Verdict {
  if (checks.worktreeStatus?.policy === 'forbid' && checks.worktreeStatus.changed) {
    return {
      outcome: 'rejected',
      rationale: `worktree changed after baseline: ${worktreeStatusReason(checks.worktreeStatus)}`,
    };
  }
  // Leg 1 — harness re-ran the objective checks; a non-zero exit anywhere → rejected (deterministic,
  // unbypassable by injection). Builder's self-reported status was never consulted. (Part7 §4 step 1.)
  if (!checks.objectiveChecksPassed) {
    return { outcome: 'rejected', rationale: 'objective checks failed (harness-run real exit codes)' };
  }
  // Leg 2 — tests/oracle deleted/skipped/weakened to go green → rejected (deterministic). (step 2.)
  if (checks.testTamper === 'weakened-or-deleted') {
    return {
      outcome: 'rejected',
      rationale: `tests tampered to go green: ${checks.tamperReason || 'weakened/deleted/skipped'}`,
    };
  }
  // Held-out leg — the goal-setter's SECRET hidden assertions (the builder never sees them) failed.
  // This is the "feature faked + self-written weak tests pass leg 1" catch. The rationale is DELIBERATELY
  // generic: it must not name the held-out command/assertion, or the builder could special-case it.
  if (checks.heldOut && !checks.heldOut.passed) {
    return {
      outcome: 'rejected',
      rationale: 'held-out hidden checks failed — the implementation does not actually satisfy the requirement',
    };
  }

  // A missing Git baseline means the harness cannot prove that tests and check-oracle files stayed
  // intact. An explicit CLI override may allow the work to run, but it cannot upgrade the result to
  // verified, even when another evidence leg looks healthy.
  if (checks.testTamper === 'unavailable') {
    return {
      outcome: 'checksOnly',
      rationale: 'project checks passed, but no Git baseline was available for tamper detection',
      ...(report === undefined ? {} : { report }),
    };
  }

  // Routine project checks prove that the repository is internally green; they do not prove the
  // user's objective. A passed held-out leg is trusted objective evidence, so it can still authorize
  // completion without leg 3. With neither held-out evidence nor a report, park as checks-only.
  if (report === undefined) {
    if (checks.heldOut?.passed) {
      return {
        outcome: 'verified',
        rationale: 'deterministic checks and trusted held-out objective checks passed',
      };
    }
    return {
      outcome: 'checksOnly',
      rationale: 'project checks passed and tests were untampered; no trusted objective evidence was configured',
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

  // Step 6 — could-not-verify / too-weak / narrow → couldNotVerify (park, fail-closed). `cannotVerify`
  // is the judge saying "I couldn't verify THIS requirement locally" (needs execution / a running app /
  // external state / human judgment) — it must PARK to a human, NOT hard-reject like incomplete/missing
  // (which mean "I inspected it and it's partial/absent"). `tooWeak`/narrow = evidence insufficient. A
  // genuinely-broken requirement was already caught in step 4 (`contradicts`), which takes precedence, so
  // here we only reach unverifiable/weak items.
  const weak = report.perRequirement.find(
    (r) => r.strength === 'cannotVerify' || r.strength === 'tooWeak' || r.scope === 'narrowerThanClaim',
  );
  if (weak) {
    return {
      outcome: 'couldNotVerify',
      rationale:
        weak.strength === 'cannotVerify'
          ? `verifier could not verify a requirement locally (needs execution / a running app / external state / human judgment): ${reqText(pinned, weak.requirementId)}`
          : `evidence too weak or narrower than the claim for: ${reqText(pinned, weak.requirementId)}`,
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

function worktreeStatusReason(status: NonNullable<DeterministicChecks['worktreeStatus']>): string {
  if (status.error) return status.error;
  if (status.changedEntries.length === 0) return 'status changed but no entry details were available';
  const shown = status.changedEntries.slice(0, 10).join('; ');
  const suffix = status.changedEntries.length > 10 ? `; ... ${status.changedEntries.length - 10} more` : '';
  return `${shown}${suffix}`;
}
