import { describe, expect, it } from 'vitest';
import { decideVerdict } from '../../../src/capabilities/goal/verdict.js';
import type {
  DeterministicChecks,
  PinnedRequirement,
  VerifierReport,
} from '../../../src/capabilities/goal/goal.js';

function checks(over: Partial<DeterministicChecks> = {}): DeterministicChecks {
  return { objectiveChecksPassed: true, results: [], testTamper: 'clean', tamperReason: '', ...over };
}

const PINNED: PinnedRequirement[] = [{ id: 'r1', text: 'the thing works' }];

/** A report that scores every PINNED requirement as proves+matched (the only verified-eligible shape). */
function perfectReport(over: Partial<VerifierReport> = {}): VerifierReport {
  return {
    feature: 'works',
    expected: 'x',
    observed: 'x',
    evidence: 'ran it',
    perRequirement: [{ requirementId: 'r1', strength: 'proves', scope: 'matched' }],
    couldNotVerify: [],
    rationale: 'proven',
    ...over,
  };
}

describe('decideVerdict — deterministic two legs (unbypassable, decided first)', () => {
  it('rejected when objective checks fail (leg 1)', () => {
    expect(decideVerdict(checks({ objectiveChecksPassed: false })).outcome).toBe('rejected');
  });

  it('rejected when tests are tampered (leg 2)', () => {
    const v = decideVerdict(checks({ testTamper: 'weakened-or-deleted', tamperReason: 'it.skip added' }));
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('it.skip added');
  });

  it('leg 1 is decided before leg 2 (both fail → leg-1 rationale)', () => {
    const v = decideVerdict(checks({ objectiveChecksPassed: false, testTamper: 'weakened-or-deleted' }));
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('objective checks failed');
  });

  it('injected report cannot bypass the deterministic legs (perfect report + failing leg 1 → rejected)', () => {
    const v = decideVerdict(checks({ objectiveChecksPassed: false }), perfectReport(), PINNED);
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('objective checks failed');
  });

  it('rejected when worktree changes are forbidden and status changed after the baseline', () => {
    const v = decideVerdict(
      checks({
        worktreeStatus: {
          command: 'git status --porcelain --untracked-files=all',
          policy: 'forbid',
          baseline: '',
          current: '?? docs/new.md',
          changed: true,
          changedEntries: ['?? docs/new.md'],
        },
      }),
    );
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('worktree changed');
    expect(v.rationale).toContain('docs/new.md');
  });

  it('worktree forbid is reported before routine check failures', () => {
    const v = decideVerdict(
      checks({
        objectiveChecksPassed: false,
        results: [{ command: 'npm test', code: 1, output: 'red' }],
        worktreeStatus: {
          command: 'git status --porcelain --untracked-files=all',
          policy: 'forbid',
          baseline: '',
          current: '?? docs/new.md',
          changed: true,
          changedEntries: ['?? docs/new.md'],
        },
      }),
    );
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('worktree changed');
  });
});

describe('decideVerdict — deterministic project checks without objective evidence', () => {
  it('returns checksOnly when routine checks pass without trusted objective evidence', () => {
    expect(decideVerdict(checks()).outcome).toBe('checksOnly');
  });

  it('returns checksOnly when the Git tamper baseline is unavailable', () => {
    const v = decideVerdict(checks({ testTamper: 'unavailable', tamperReason: 'no Git baseline' }));
    expect(v.outcome).toBe('checksOnly');
    expect(v.rationale).toContain('no Git baseline');
  });

  it('does not let a perfect verifier report bypass a missing Git baseline', () => {
    expect(decideVerdict(checks({ testTamper: 'unavailable' }), perfectReport(), PINNED).outcome).toBe('checksOnly');
  });
});

describe('decideVerdict — leg 3 scoring (Part7 §3.2 / §4)', () => {
  it('verified when every pinned requirement proves+matched, feature works, list non-empty (step 7)', () => {
    const v = decideVerdict(checks(), perfectReport(), PINNED);
    expect(v.outcome).toBe('verified');
    expect(v.report).toBeDefined();
  });

  it('couldNotVerify when a pinned requirement is unscored (step 3 coverage, fail-closed)', () => {
    const twoPinned: PinnedRequirement[] = [...PINNED, { id: 'r2', text: 'also this' }];
    const v = decideVerdict(checks(), perfectReport(), twoPinned); // report only scores r1
    expect(v.outcome).toBe('couldNotVerify');
    expect(v.rationale).toContain('also this');
  });

  it('rejected when any requirement contradicts (hard fail outranks couldNotVerify — P2 regression, step 4)', () => {
    const report = perfectReport({
      perRequirement: [{ requirementId: 'r1', strength: 'contradicts', scope: 'matched' }],
      couldNotVerify: ['something else unverifiable'], // present, but the hard fail must win
    });
    const v = decideVerdict(checks(), report, PINNED);
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('the thing works');
  });

  it('rejected when the verifier observed the feature broken (step 4)', () => {
    const v = decideVerdict(checks(), perfectReport({ feature: 'broken' }), PINNED);
    expect(v.outcome).toBe('rejected');
  });

  it('couldNotVerify when couldNotVerify[] is non-empty and there is no hard fail (step 5)', () => {
    const v = decideVerdict(checks(), perfectReport({ couldNotVerify: ['needs prod creds'] }), PINNED);
    expect(v.outcome).toBe('couldNotVerify');
    expect(v.rationale).toContain('needs prod creds');
  });

  it('couldNotVerify when a narrow check supports a broad claim (claim_scope axis, step 6)', () => {
    const report = perfectReport({
      perRequirement: [{ requirementId: 'r1', strength: 'proves', scope: 'narrowerThanClaim' }],
    });
    const v = decideVerdict(checks(), report, PINNED);
    expect(v.outcome).toBe('couldNotVerify');
    expect(v.rationale).toContain('narrower');
  });

  it('couldNotVerify when evidence is too weak (step 6)', () => {
    const report = perfectReport({
      perRequirement: [{ requirementId: 'r1', strength: 'tooWeak', scope: 'matched' }],
    });
    expect(decideVerdict(checks(), report, PINNED).outcome).toBe('couldNotVerify');
  });

  it('cannotVerify PARKS (couldNotVerify), it is NOT a hard reject — the execution-requirement bug fix', () => {
    // A requirement the judge cannot check by reading files (needs running code / external state) must
    // route to a human, NOT loop the builder on work it actually did (the old incomplete/missing path).
    const report = perfectReport({
      perRequirement: [{ requirementId: 'r1', strength: 'cannotVerify', scope: 'matched' }],
    });
    const v = decideVerdict(checks(), report, PINNED);
    expect(v.outcome).toBe('couldNotVerify');
    expect(v.rationale).toContain('could not verify');
  });

  it('a proven-broken (contradicts) requirement still rejects even alongside a cannotVerify (contradicts precedence)', () => {
    const twoPinned: PinnedRequirement[] = [...PINNED, { id: 'r2', text: 'second' }];
    const report = perfectReport({
      perRequirement: [
        { requirementId: 'r1', strength: 'contradicts', scope: 'matched' },
        { requirementId: 'r2', strength: 'cannotVerify', scope: 'matched' },
      ],
    });
    expect(decideVerdict(checks(), report, twoPinned).outcome).toBe('rejected');
  });

  it('incomplete/missing still hard-reject (verified partial/absent ≠ could-not-verify)', () => {
    for (const strength of ['incomplete', 'missing'] as const) {
      const report = perfectReport({ perRequirement: [{ requirementId: 'r1', strength, scope: 'matched' }] });
      expect(decideVerdict(checks(), report, PINNED).outcome, strength).toBe('rejected');
    }
  });

  it('empty pinned list with an otherwise-perfect report is couldNotVerify (verified unreachable, step 7 guard)', () => {
    const report = perfectReport({ perRequirement: [] }); // nothing to prove, no pinned to cover
    const v = decideVerdict(checks(), report, []);
    expect(v.outcome).toBe('couldNotVerify'); // NEVER verified for an empty list
  });

  it('decideVerdict is the sole source of verdict (perfect-looking report + uncovered pinned → couldNotVerify)', () => {
    // The report "looks" complete (feature works, its one entry proves+matched), but it does not cover
    // r2 — the harness, not the report, decides, so it fails closed. The schema has no `verdict` field
    // for the LLM to self-report; this is the only place a verdict is produced.
    const twoPinned: PinnedRequirement[] = [...PINNED, { id: 'r2', text: 'second requirement' }];
    expect(decideVerdict(checks(), perfectReport(), twoPinned).outcome).toBe('couldNotVerify');
  });
});

describe('decideVerdict — held-out leg (secret hidden assertions)', () => {
  it('rejected when held-out fails even though leg 1+2 are clean (faked feature + weak self-written tests)', () => {
    const v = decideVerdict(checks({ heldOut: { passed: false, results: [] } }));
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('held-out');
  });

  it('the held-out rejection rationale NEVER names the secret command or its output', () => {
    const v = decideVerdict(
      checks({ heldOut: { passed: false, results: [{ command: 'node secret-assert.js', code: 1, output: 'SECRET-DETAIL' }] } }),
    );
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).not.toContain('secret-assert');
    expect(v.rationale).not.toContain('SECRET-DETAIL');
  });

  it('held-out passing proceeds to verified (the leg is satisfied, no report)', () => {
    expect(decideVerdict(checks({ heldOut: { passed: true, results: [] } })).outcome).toBe('verified');
  });

  it('held-out absent leaves the result at checksOnly', () => {
    expect(decideVerdict(checks()).outcome).toBe('checksOnly');
  });

  it('held-out is decided before leg 3 (failing held-out + perfect report → rejected, judge not honored)', () => {
    const v = decideVerdict(checks({ heldOut: { passed: false, results: [] } }), perfectReport(), PINNED);
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toContain('held-out');
  });
});

describe('decideVerdict — fail-closed property (verified ⇒ a provable, clean state)', () => {
  it('with no report, verified ⇒ objective checks passed AND tests clean', () => {
    const tampers: DeterministicChecks['testTamper'][] = ['clean', 'weakened-or-deleted', 'unavailable'];
    for (const objectiveChecksPassed of [true, false]) {
      for (const testTamper of tampers) {
        const v = decideVerdict(checks({ objectiveChecksPassed, testTamper }));
        if (v.outcome === 'verified') {
          expect(objectiveChecksPassed).toBe(true);
          expect(testTamper).toBe('clean');
        }
      }
    }
  });

  it('with no report, verified ⇒ forbidden worktree status did not change', () => {
    const v = decideVerdict(
      checks({
        worktreeStatus: {
          command: 'git status --porcelain --untracked-files=all',
          policy: 'forbid',
          baseline: '',
          current: '?? leaked.txt',
          changed: true,
          changedEntries: ['?? leaked.txt'],
        },
      }),
    );
    expect(v.outcome).not.toBe('verified');
  });

  it('with a report, verified ⇒ legs clean AND feature works AND every requirement proves+matched AND list non-empty AND cnv empty', () => {
    const strengths: VerifierReport['perRequirement'][number]['strength'][] = [
      'proves',
      'contradicts',
      'incomplete',
      'tooWeak',
      'missing',
      'cannotVerify',
    ];
    const scopes: VerifierReport['perRequirement'][number]['scope'][] = ['matched', 'narrowerThanClaim'];
    for (const objectiveChecksPassed of [true, false]) {
      for (const strength of strengths) {
        for (const scope of scopes) {
          for (const feature of ['works', 'broken'] as const) {
            for (const cnv of [[], ['x']]) {
              const report = perfectReport({
                feature,
                couldNotVerify: cnv,
                perRequirement: [{ requirementId: 'r1', strength, scope }],
              });
              const v = decideVerdict(checks({ objectiveChecksPassed }), report, PINNED);
              if (v.outcome === 'verified') {
                expect(objectiveChecksPassed).toBe(true);
                expect(feature).toBe('works');
                expect(strength).toBe('proves');
                expect(scope).toBe('matched');
                expect(cnv).toHaveLength(0);
              }
            }
          }
        }
      }
    }
  });
});
