import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseA0Corpus } from '../../../src/capabilities/eval/a0-contract.js';
import {
  reportA0Evaluation,
  runA0Evaluation,
  type A0VerifierCall,
} from '../../../src/capabilities/eval/a0-runner.js';
import type { Message } from '../../../src/core/types.js';

const repo = process.cwd();
const corpusPath = 'eval/a0/eval-cases.jsonl';
const promptPath = 'eval/a0/prompts/a0-leg3-v2.md';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis a0 runner '));
  tempDirs.push(dir);
  return dir;
}

/** Copies the frozen corpus tree so a test can mutate it without touching the
 *  repository inputs; the returned root is self-contained for `cwd`. */
async function copyA0Fixture(): Promise<string> {
  const work = await tempDir();
  await cp(join(repo, 'eval/a0'), join(work, 'eval', 'a0'), { recursive: true });
  return work;
}

/** A perfect verifier: reads the case id from the model-visible projection and
 *  answers with the corpus-declared expected label — harness-side, so no label
 *  leakage happens anywhere in this fake. */
const perfectVerifier: A0VerifierCall = async (messages: Message[]) => {
  const cases = parseA0Corpus(await readFile(join(repo, corpusPath), 'utf8'));
  const user = messages.find((message) => message.role === 'user');
  const caseId = user === undefined ? '' : /"caseId":"([^"]+)"/u.exec(user.content)?.[1] ?? '';
  const expected = cases.find((item) => item.caseId === caseId)?.expectedLeg3 ?? 'cannotVerify';
  return { text: `{"leg3": "${expected}", "reason": "fake"}`, inputTokens: 10, outputTokens: 5 };
};

describe('A0 runner — full run against the frozen corpus', () => {
  it('runs every case three times, writes a GO report, and verifies its own manifest', async () => {
    const out = await tempDir();
    const result = await runA0Evaluation({
      cwd: repo,
      corpusPath,
      promptPath,
      model: 'fake-verifier-model',
      call: perfectVerifier,
      outputDir: out,
      startedAt: '2026-08-16T10:00:00.000Z',
    });

    expect(result.report.verdict).toBe('GO');
    expect(result.report.coverage).toEqual({ cases: 6, observations: 18, complete: true });
    expect(result.parseFailures).toEqual([]);
    const bytes = await readFile(result.observationsPath);
    expect(result.manifest.observations.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.manifest.policy).toMatchObject({ id: 'a0-independent-leg3-policy-v1', model: 'fake-verifier-model', promptVersion: 'a0-leg3-v2' });

    const replayed = await reportA0Evaluation({ cwd: repo, corpusPath, observationsPath: result.observationsPath });
    expect(replayed.provenanceIssues).toEqual([]);
    expect(replayed.report.verdict).toBe('GO');
    expect(replayed.manifest?.policy.model).toBe('fake-verifier-model');
  }, 20_000);

  it('parks unparseable verifier replies as cannotVerify and fails the gate instead of guessing', async () => {
    const out = await tempDir();
    const broken: A0VerifierCall = async () => ({ text: 'I believe the claim holds.', inputTokens: 1, outputTokens: 1 });
    const result = await runA0Evaluation({
      cwd: repo, corpusPath, promptPath, model: 'm', call: broken, outputDir: out,
    });

    expect(result.parseFailures).toHaveLength(18);
    expect(result.report.verdict).toBe('NO-GO');
    expect(result.report.failures.some((failure) => failure.includes('known-bad misses'))).toBe(true);
  }, 20_000);

  it('accepts fenced JSON replies', async () => {
    const out = await tempDir();
    const fenced: A0VerifierCall = async () => ({
      text: '```json\n{"leg3": "proves", "reason": "fenced"}\n```',
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runA0Evaluation({
      cwd: repo, corpusPath, promptPath, model: 'm', call: fenced, outputDir: out,
    });
    expect(result.parseFailures).toEqual([]);
    expect(result.report.metrics.parkRate).toBe(0);
  }, 20_000);

  it('refuses to overwrite existing artifacts', async () => {
    const out = await tempDir();
    const input = { cwd: repo, corpusPath, promptPath, model: 'm', call: perfectVerifier, outputDir: out } as const;
    await runA0Evaluation(input);
    await expect(runA0Evaluation(input)).rejects.toThrow(/already exists and is immutable/u);
  }, 20_000);
});

describe('A0 runner — fail-closed input boundaries', () => {
  it('fails closed when the corpus declares a drifted evidence hash', async () => {
    const out = await tempDir();
    const work = await copyA0Fixture();
    const corpusFile = join(work, 'eval', 'a0', 'eval-cases.jsonl');
    const original = await readFile(corpusFile, 'utf8');
    const drifted = original.replace(
      /("sha256":")([0-9a-f])/u,
      (_match, prefix: string, first: string) => `${prefix}${first === '0' ? '1' : '0'}`,
    );
    expect(drifted).not.toBe(original);
    await writeFile(corpusFile, drifted, 'utf8');

    await expect(runA0Evaluation({
      cwd: work,
      corpusPath: 'eval/a0/eval-cases.jsonl',
      promptPath,
      model: 'm',
      call: perfectVerifier,
      outputDir: out,
    })).rejects.toThrow(/hash drift/u);
  }, 20_000);

  it('rejects an evidence bundle that carries the hidden answer keys', async () => {
    const out = await tempDir();
    const work = await copyA0Fixture();
    await writeFile(
      join(work, 'leaky.json'),
      `${JSON.stringify({ schemaVersion: 1, caseId: 'case-x', objective: 'x', classification: 'valid' })}\n`,
      'utf8',
    );
    await writeFile(
      join(work, 'corpus.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        caseId: 'case-x',
        classification: 'valid',
        objective: 'one small case',
        evidence: [{ path: 'leaky.json', selector: 'case-x' }],
        expectedLeg3: 'proves',
        labelOrigin: { kind: 'independent-review', reviewer: 'r', source: 's', labeledAt: '2026-08-16T00:00:00.000Z' },
        promptVersion: 'a0-leg3-v2',
        modelPolicy: { builder: 'a0-candidate-policy-v1', verifier: 'a0-independent-leg3-policy-v1' },
        repetitions: 3,
        tags: ['test'],
      })}\n`,
      'utf8',
    );

    await expect(runA0Evaluation({
      cwd: work,
      corpusPath: 'corpus.jsonl',
      promptPath,
      model: 'm',
      call: perfectVerifier,
      outputDir: out,
    })).rejects.toThrow(/answer keys/u);
  }, 20_000);

  it('rejects answer keys nested inside objects or arrays, not only at the top level', async () => {
    for (const leaky of [
      { schemaVersion: 1, caseId: 'case-n', objective: 'x', meta: { expectedLeg3: 'proves' } },
      { schemaVersion: 1, caseId: 'case-n', objective: 'x', facts: [{ labelOrigin: 'leak' }] },
    ]) {
      const out = await tempDir();
      const work = await copyA0Fixture();
      await writeFile(join(work, 'leaky.json'), `${JSON.stringify(leaky)}\n`, 'utf8');
      await writeFile(
        join(work, 'corpus.jsonl'),
        `${JSON.stringify({
          schemaVersion: 1,
          caseId: 'case-n',
          classification: 'valid',
          objective: 'one small case',
          evidence: [{ path: 'leaky.json', selector: 'case-n' }],
          expectedLeg3: 'proves',
          labelOrigin: { kind: 'independent-review', reviewer: 'r', source: 's', labeledAt: '2026-08-16T00:00:00.000Z' },
          promptVersion: 'a0-leg3-v2',
          modelPolicy: { builder: 'a0-candidate-policy-v1', verifier: 'a0-independent-leg3-policy-v1' },
          repetitions: 3,
          tags: ['test'],
        })}\n`,
        'utf8',
      );

      await expect(runA0Evaluation({
        cwd: work,
        corpusPath: 'corpus.jsonl',
        promptPath,
        model: 'm',
        call: perfectVerifier,
        outputDir: out,
      })).rejects.toThrow(/answer keys/u);
    }
  }, 20_000);

  it('verifies every case\'s declared hash even when cases share one evidence path', async () => {
    const out = await tempDir();
    const work = await copyA0Fixture();
    const evidencePath = 'eval/a0/evidence/case-001.json';
    const bundleBytes = await readFile(join(work, ...evidencePath.split('/')));
    const realHash = createHash('sha256').update(bundleBytes).digest('hex');
    const template = (caseId: string, sha256: string | undefined): string => JSON.stringify({
      schemaVersion: 1,
      caseId,
      classification: 'valid',
      objective: 'shared evidence case',
      evidence: [{ path: evidencePath, selector: caseId, ...(sha256 === undefined ? {} : { sha256 }) }],
      expectedLeg3: 'proves',
      labelOrigin: { kind: 'independent-review', reviewer: 'r', source: 's', labeledAt: '2026-08-16T00:00:00.000Z' },
      promptVersion: 'a0-leg3-v2',
      modelPolicy: { builder: 'a0-candidate-policy-v1', verifier: 'a0-independent-leg3-policy-v1' },
      repetitions: 3,
      tags: ['test'],
    });
    await writeFile(
      join(work, 'corpus.jsonl'),
      `${template('case-shared-a', realHash)}\n${template('case-shared-b', '0'.repeat(64))}\n`,
      'utf8',
    );

    await expect(runA0Evaluation({
      cwd: work,
      corpusPath: 'corpus.jsonl',
      promptPath,
      model: 'm',
      call: perfectVerifier,
      outputDir: out,
    })).rejects.toThrow(/hash drift/u);
  }, 20_000);

  it('rejects mixed prompt or policy versions in one corpus', async () => {
    const out = await tempDir();
    const work = await copyA0Fixture();
    const corpusFile = join(work, 'eval', 'a0', 'eval-cases.jsonl');
    const original = await readFile(corpusFile, 'utf8');
    const mixed = `${original.trim()}\n${original.split('\n')[0]?.replace('case-001', 'case-001b').replace('a0-leg3-v2', 'a0-leg3-v1')}\n`;
    await writeFile(corpusFile, mixed, 'utf8');

    await expect(runA0Evaluation({
      cwd: work,
      corpusPath: 'eval/a0/eval-cases.jsonl',
      promptPath,
      model: 'm',
      call: perfectVerifier,
      outputDir: out,
    })).rejects.toThrow(/one promptVersion and one verifier policy/u);
  }, 20_000);
});

describe('A0 runner — provenance verification on replay', () => {
  it('detects observations tampering through the manifest', async () => {
    const out = await tempDir();
    const result = await runA0Evaluation({
      cwd: repo, corpusPath, promptPath, model: 'm', call: perfectVerifier, outputDir: out,
    });
    const original = await readFile(result.observationsPath, 'utf8');
    const tampered = original.replace('"totalTokens":15', '"totalTokens":16');
    expect(tampered).not.toBe(original);
    await writeFile(result.observationsPath, tampered, 'utf8');

    const replayed = await reportA0Evaluation({ cwd: repo, corpusPath, observationsPath: result.observationsPath });
    expect(replayed.provenanceIssues).toContain('observations bytes do not match the run manifest');
  }, 20_000);

  it('detects corpus drift after the run', async () => {
    const out = await tempDir();
    const work = await copyA0Fixture();
    const result = await runA0Evaluation({
      cwd: work, corpusPath, promptPath, model: 'm', call: perfectVerifier, outputDir: out,
    });
    const driftedPath = join(work, 'eval', 'a0', 'eval-cases.jsonl');
    await writeFile(driftedPath, `${await readFile(driftedPath, 'utf8')}\n`, 'utf8');

    const replayed = await reportA0Evaluation({ cwd: work, corpusPath: 'eval/a0/eval-cases.jsonl', observationsPath: result.observationsPath });
    expect(replayed.provenanceIssues).toContain('corpus bytes do not match the run manifest (corpus drifted after the run)');
  }, 20_000);

  it('treats a non-.jsonl observations file as unverified provenance instead of a corrupt manifest', async () => {
    const out = await tempDir();
    const result = await runA0Evaluation({
      cwd: repo, corpusPath, promptPath, model: 'm', call: perfectVerifier, outputDir: out,
    });
    const renamed = join(out, 'observations.txt');
    await writeFile(renamed, await readFile(result.observationsPath, 'utf8'), 'utf8');

    const replayed = await reportA0Evaluation({ cwd: repo, corpusPath, observationsPath: renamed });
    expect(replayed.manifest).toBeNull();
    expect(replayed.provenanceIssues).toContain('no run manifest found next to the observations; provenance is unverified');
    expect(replayed.report.verdict).toBe('GO');
  }, 20_000);

  it('flags a missing manifest as unverified provenance but still reports', async () => {
    const out = await tempDir();
    const result = await runA0Evaluation({
      cwd: repo, corpusPath, promptPath, model: 'm', call: perfectVerifier, outputDir: out,
    });
    const bare = join(out, 'bare.jsonl');
    await writeFile(bare, await readFile(result.observationsPath, 'utf8'), 'utf8');

    const replayed = await reportA0Evaluation({ cwd: repo, corpusPath, observationsPath: bare });
    expect(replayed.manifest).toBeNull();
    expect(replayed.provenanceIssues).toContain('no run manifest found next to the observations; provenance is unverified');
    expect(replayed.report.verdict).toBe('GO');
  }, 20_000);
});
