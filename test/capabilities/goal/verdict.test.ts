import { describe, expect, it } from 'vitest';
import { decideVerdict } from '../../../src/capabilities/goal/verdict.js';
import type { DeterministicChecks, VerifierReport } from '../../../src/capabilities/goal/goal.js';

function checks(over: Partial<DeterministicChecks> = {}): DeterministicChecks {
  return { objectiveChecksPassed: true, results: [], testTamper: 'clean', tamperReason: '', ...over };
}

const dummyReport: VerifierReport = {
  feature: 'works',
  expected: '',
  observed: '',
  evidence: '',
  perRequirement: [],
  couldNotVerify: [],
  rationale: '',
};

describe('decideVerdict — deterministic two legs', () => {
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

  it('verified ONLY when both legs clean AND no leg-3 report (explicit branch, not a fallback)', () => {
    expect(decideVerdict(checks()).outcome).toBe('verified');
  });

  it('a present report is fail-closed this batch (leg 3 not enabled → couldNotVerify, never verified)', () => {
    const v = decideVerdict(checks(), dummyReport);
    expect(v.outcome).toBe('couldNotVerify');
    expect(v.report).toBe(dummyReport);
  });
});

describe('decideVerdict — fail-closed property', () => {
  it('with no report, verified ⇒ objective checks passed AND tests clean', () => {
    const tampers: DeterministicChecks['testTamper'][] = ['clean', 'weakened-or-deleted'];
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
});
