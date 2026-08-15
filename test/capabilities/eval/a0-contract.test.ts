import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  computeA0Report,
  modelVisibleA0Case,
  parseA0Corpus,
  parseA0Observations,
} from '../../../src/capabilities/eval/a0-contract.js';

const cases = [
  a0Case('good', 'valid', 'proves'),
  a0Case('bad', 'tampered', 'contradicts'),
  a0Case('unclear', 'ambiguous', 'cannotVerify'),
].join('\n');

describe('A0 contract', () => {
  it('parses the frozen corpus and binds every label-blind evidence selector to immutable bytes', async () => {
    const corpus = parseA0Corpus(await readFile('eval/a0/eval-cases.jsonl', 'utf8'));
    expect(corpus.map((item) => [item.caseId, item.classification, item.expectedLeg3])).toEqual([
      ['case-001', 'valid', 'proves'],
      ['case-002', 'valid', 'proves'],
      ['case-003', 'tampered', 'contradicts'],
      ['case-004', 'tampered', 'contradicts'],
      ['case-005', 'ambiguous', 'cannotVerify'],
      ['case-006', 'ambiguous', 'cannotVerify'],
    ]);

    for (const item of corpus) {
      expect(item.evidence).toHaveLength(1);
      const evidence = item.evidence[0];
      const bytes = await readFile(evidence.path);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(evidence.sha256);
      const text = bytes.toString('utf8');
      expect(text).toContain(evidence.selector);
      const bundle = JSON.parse(text) as {
        caseId: string;
        facts: Array<{ path: string; selector: string }>;
        classification?: unknown;
        expectedLeg3?: unknown;
        labelOrigin?: unknown;
      };
      expect(bundle).toMatchObject({ caseId: item.caseId });
      expect(bundle).not.toHaveProperty('classification');
      expect(bundle).not.toHaveProperty('expectedLeg3');
      expect(bundle).not.toHaveProperty('labelOrigin');
      for (const fact of bundle.facts) {
        await expect(readFile(fact.path, 'utf8')).resolves.toContain(fact.selector);
      }
    }
  });

  it('parses strict independently-labelled cases and rejects label shortcuts', () => {
    expect(parseA0Corpus(cases)).toHaveLength(3);
    expect(() => parseA0Corpus(a0Case('bad-label', 'tampered', 'proves'))).toThrow(/classification.*expectedLeg3/);
    expect(() => parseA0Corpus(a0Case('bad-origin', 'valid', 'proves').replace('independent-review', 'historical-verdict'))).toThrow(/labelOrigin/);
    expect(() => parseA0Corpus(a0Case('bad-reps', 'valid', 'proves').replace('"repetitions":3', '"repetitions":2'))).toThrow(/repetitions/);
  });

  it('removes classifications, expected labels, and reviewer provenance from model-visible input', () => {
    const input = modelVisibleA0Case(parseA0Corpus(a0Case('hidden-label', 'tampered', 'contradicts'))[0]);
    const serialized = JSON.stringify(input);
    expect(input).toMatchObject({ caseId: 'hidden-label', objective: 'evaluate hidden-label' });
    expect(serialized).not.toContain('tampered');
    expect(serialized).not.toContain('contradicts');
    expect(serialized).not.toContain('reviewer-1');
    expect(input).not.toHaveProperty('labelOrigin');
  });

  it('computes the frozen metrics and returns GO for a clean three-run baseline', () => {
    const parsedCases = parseA0Corpus(cases);
    const observations = parseA0Observations([
      ...attempts('good', 'proves'),
      ...attempts('bad', 'contradicts'),
      ...attempts('unclear', 'cannotVerify'),
    ].join('\n'));
    const report = computeA0Report(parsedCases, observations);
    expect(report).toMatchObject({
      schemaVersion: 1,
      verdict: 'GO',
      coverage: { cases: 3, observations: 9, complete: true },
      metrics: {
        badCaseMissRate: 0,
        goodCaseFalsePositiveRate: 0,
        parkRate: 1 / 3,
        repeatConsistency: 1,
        meanTokensPerCase: 300,
        p95LatencyMs: 30,
        requestReconstructabilityRate: 1,
        orphanSideEffects: 0,
        receiptlessAttempts: 0,
        staleRecallActions: 0,
      },
    });
  });

  it('fails closed on missing attempts, known-bad misses, and receipt gaps', () => {
    const parsedCases = parseA0Corpus(cases);
    const observations = parseA0Observations([
      ...attempts('good', 'proves'),
      ...attempts('bad', 'proves', { receiptlessAttempts: 1 }),
      ...attempts('unclear', 'cannotVerify').slice(0, 2),
    ].join('\n'));
    const report = computeA0Report(parsedCases, observations);
    expect(report.verdict).toBe('NO-GO');
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/coverage/i),
      expect.stringMatching(/known-bad/i),
      expect.stringMatching(/receiptless/i),
    ]));
  });

  it('counts every non-contradicts tampered observation as a known-bad miss', () => {
    const parsedCases = parseA0Corpus(cases);
    const observations = parseA0Observations([
      ...attempts('good', 'proves'),
      ...attempts('bad', 'cannotVerify'),
      ...attempts('unclear', 'cannotVerify'),
    ].join('\n'));
    const report = computeA0Report(parsedCases, observations);
    expect(report.metrics.badCaseMissRate).toBe(1);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/known-bad misses detected: 3/),
    ]));
    expect(report.verdict).toBe('NO-GO');
  });

  it('rejects traversal, rooted, Windows drive/device, and alternate-data-stream evidence paths', () => {
    for (const path of [
      '../secret.txt',
      '/etc/passwd',
      'C:',
      'C:fixture.txt',
      'C:..\\secret.txt',
      'C:\\secret.txt',
      '\\\\server\\share\\fixture.txt',
      '\\\\.\\pipe\\jarvis',
      '\\\\?\\C:\\fixture.txt',
      'evidence\\bundle.json:stream',
    ]) {
      expect(() => parseA0Corpus(a0CaseWithEvidencePath(`unsafe-${path.length}`, path))).toThrow(/repository-relative/);
    }
  });

  it('rejects blank selectors and malformed evidence hashes', () => {
    const blankSelector = JSON.parse(a0Case('blank-selector', 'valid', 'proves')) as {
      evidence: Array<{ selector: string; sha256?: string }>;
    };
    blankSelector.evidence[0].selector = '  ';
    expect(() => parseA0Corpus(JSON.stringify(blankSelector))).toThrow(/selector/);

    const malformedHash = JSON.parse(a0Case('bad-hash', 'valid', 'proves')) as {
      evidence: Array<{ selector: string; sha256?: string }>;
    };
    malformedHash.evidence[0].sha256 = 'abc123';
    expect(() => parseA0Corpus(JSON.stringify(malformedHash))).toThrow(/sha256/);
  });

  it('refuses a report that lacks valid, tampered, or ambiguous coverage', () => {
    const validOnly = parseA0Corpus(a0Case('only-good', 'valid', 'proves'));
    const report = computeA0Report(validOnly, parseA0Observations(attempts('only-good', 'proves').join('\n')));
    expect(report.verdict).toBe('NO-GO');
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/tampered/i),
      expect.stringMatching(/ambiguous/i),
    ]));
  });

  it('rejects duplicate attempts and observations for unknown cases', () => {
    expect(() => computeA0Report(parseA0Corpus(cases), parseA0Observations([
      ...attempts('good', 'proves'),
      ...attempts('bad', 'contradicts'),
      ...attempts('unclear', 'cannotVerify'),
      observation('good', 1, 'proves'),
    ].join('\n')))).toThrow(/duplicate observation/);
    expect(() => computeA0Report(parseA0Corpus(cases), parseA0Observations(observation('missing', 1, 'proves')))).toThrow(/unknown case/);
  });
});

function a0Case(caseId: string, classification: string, expectedLeg3: string): string {
  return a0CaseWithEvidencePath(caseId, 'test/fixture.test.ts', classification, expectedLeg3);
}

function a0CaseWithEvidencePath(caseId: string, path: string, classification = 'valid', expectedLeg3 = 'proves'): string {
  return JSON.stringify({
    schemaVersion: 1,
    caseId,
    classification,
    objective: `evaluate ${caseId}`,
    evidence: [{ path, selector: caseId }],
    expectedLeg3,
    labelOrigin: {
      kind: 'independent-review', reviewer: 'reviewer-1', source: 'fresh-a0-label-pass', labeledAt: '2026-08-15T00:00:00.000Z',
    },
    promptVersion: 'a0-v1',
    modelPolicy: { builder: 'fixture-builder', verifier: 'fixture-verifier' },
    repetitions: 3,
    tags: ['fixture'],
  });
}

function attempts(caseId: string, label: string, over: Record<string, number | boolean> = {}): string[] {
  return [1, 2, 3].map((attempt) => observation(caseId, attempt, label, over));
}

function observation(
  caseId: string,
  attempt: number,
  actualLeg3: string,
  over: Record<string, number | boolean> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    caseId,
    attempt,
    actualLeg3,
    totalTokens: 100,
    latencyMs: attempt * 10,
    requestReconstructable: true,
    orphanSideEffects: 0,
    receiptlessAttempts: 0,
    staleRecallActions: 0,
    ...over,
  });
}
