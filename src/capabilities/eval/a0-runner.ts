/**
 * A0 read-only runner — executes the frozen corpus against a verifier model and
 * produces immutable observation artifacts, or replays recorded observations
 * through the pure report. It is an evaluation tool: it never touches Session,
 * goal, loop, approval, or audit JSONL, never resolves repository paths outside
 * the corpus contract, and carries no completion authority of any kind.
 *
 * Boundary pieces required by docs/headless-a0-contract.md §5:
 *  - corpus/evidence paths were already vetted lexically by the contract parser;
 *    this runner re-anchors them through the file-tool confinement boundary
 *    (safeResolve: canonical containment, symlink/reparse follow, secret and
 *    git-metadata refusal) and hashes the bytes it actually opened;
 *  - a case whose evidence bundle carries the hidden answer keys fails closed
 *    before any model request, so the label-blind projection cannot leak;
 *  - `promptVersion` / `modelPolicy` ids from the corpus stay opaque here; the
 *    immutable run manifest binds them to concrete prompt bytes and model id.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../../core/types.js';
import { safeResolve } from '../../core/tools/safe-path.js';
import {
  A0_SCHEMA_VERSION,
  computeA0Report,
  modelVisibleA0Case,
  parseA0Corpus,
  parseA0Observations,
  type A0Leg3Label,
  type A0Observation,
  type A0Report,
} from './a0-contract.js';

/** Sends one single-turn verifier request and returns its aggregated usage. */
export type A0VerifierCall = (
  messages: Message[],
) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

export interface A0RunManifest {
  schemaVersion: typeof A0_SCHEMA_VERSION;
  kind: 'a0-run-manifest';
  startedAt: string;
  finishedAt: string;
  corpus: { path: string; sha256: string; cases: number };
  policy: {
    id: string;
    model: string;
    promptVersion: string;
    promptPath: string;
    promptSha256: string;
  };
  observations: { path: string; sha256: string; count: number };
}

export interface A0RunResult {
  observationsPath: string;
  manifestPath: string;
  manifest: A0RunManifest;
  report: A0Report;
  parseFailures: string[];
}

export interface A0ReportResult {
  report: A0Report;
  manifest: A0RunManifest | null;
  provenanceIssues: string[];
}

const MAX_INPUT_BYTES = 2_000_000;
const LABEL_KEYS_FORBIDDEN_IN_BUNDLE = ['classification', 'expectedLeg3', 'labelOrigin'] as const;

/** Execute every case × attempt {1,2,3} and write the observation artifact plus
 *  its manifest. Fails closed on corpus drift, path escapes, answer leakage,
 *  oversized inputs, and pre-existing artifacts (artifacts are immutable). */
export async function runA0Evaluation(input: {
  cwd: string;
  corpusPath: string;
  promptPath: string;
  model: string;
  call: A0VerifierCall;
  outputDir: string;
  startedAt?: string;
}): Promise<A0RunResult> {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const corpusBytes = await readBounded(input.cwd, input.corpusPath);
  const cases = parseA0Corpus(corpusBytes.toString('utf8'));
  const promptBytes = await readBounded(input.cwd, input.promptPath);

  const promptVersion = new Set(cases.map((item) => item.promptVersion));
  const policyId = new Set(cases.map((item) => item.modelPolicy.verifier));
  if (promptVersion.size !== 1 || policyId.size !== 1) {
    throw new Error('the v1 runner requires one promptVersion and one verifier policy across the corpus');
  }

  const bundles = new Map<string, { text: string; sha256: string }>();
  for (const item of cases) {
    for (const evidence of item.evidence) {
      let bundle = bundles.get(evidence.path);
      if (bundle === undefined) {
        bundle = await loadEvidenceBundle(input.cwd, evidence);
        bundles.set(evidence.path, bundle);
      }
      // Every declaration is verified, including cases that share one path:
      // a diverging declared hash must fail closed even when the bundle itself
      // was already loaded and verified under a different case.
      if (evidence.sha256 !== undefined && evidence.sha256.toLowerCase() !== bundle.sha256) {
        throw new Error(`evidence bundle hash drift: ${evidence.path} (corpus declares ${evidence.sha256.slice(0, 12)}…, opened bytes hash ${bundle.sha256.slice(0, 12)}…)`);
      }
    }
  }

  const promptText = promptBytes.toString('utf8');
  const observations: A0Observation[] = [];
  const parseFailures: string[] = [];
  for (const item of cases) {
    for (const attempt of [1, 2, 3] as const) {
      const userPrompt = JSON.stringify({
        ...modelVisibleA0Case(item),
        evidence: item.evidence.map((evidence) => ({
          path: evidence.path,
          ...(evidence.selector === undefined ? {} : { selector: evidence.selector }),
          sha256: bundles.get(evidence.path)?.sha256,
          content: bundles.get(evidence.path)?.text,
        })),
      });
      const started = Date.now();
      const result = await input.call([
        { role: 'system', content: promptText },
        { role: 'user', content: userPrompt },
      ]);
      const verdict = parseVerdict(result.text, item.caseId, attempt, parseFailures);
      observations.push({
        schemaVersion: A0_SCHEMA_VERSION,
        caseId: item.caseId,
        attempt,
        actualLeg3: verdict,
        totalTokens: result.inputTokens + result.outputTokens,
        latencyMs: Date.now() - started,
        // The runner builds every request deterministically from corpus bytes,
        // prompt bytes, and the manifest-recorded policy, so each request is
        // reconstructable by definition; the counters below measure channels
        // (tool side effects, receipts, Recall actions) this single-turn static
        // adjudication structurally does not have.
        requestReconstructable: true,
        orphanSideEffects: 0,
        receiptlessAttempts: 0,
        staleRecallActions: 0,
      });
    }
  }

  const report = computeA0Report(cases, observations);
  const observationsPath = join(input.outputDir, 'observations.jsonl');
  const manifestPath = join(input.outputDir, 'observations.manifest.json');
  await assertAbsent(observationsPath);
  await assertAbsent(manifestPath);
  await mkdir(input.outputDir, { recursive: true });
  const observationsBytes = Buffer.from(
    observations.map((observation) => `${JSON.stringify(observation)}\n`).join(''),
    'utf8',
  );
  await writeFile(observationsPath, observationsBytes, 'utf8');
  const manifest: A0RunManifest = {
    schemaVersion: A0_SCHEMA_VERSION,
    kind: 'a0-run-manifest',
    startedAt,
    finishedAt: new Date().toISOString(),
    corpus: {
      path: input.corpusPath,
      sha256: sha256Hex(corpusBytes),
      cases: cases.length,
    },
    policy: {
      id: [...policyId][0] ?? '',
      model: input.model,
      promptVersion: [...promptVersion][0] ?? '',
      promptPath: input.promptPath,
      promptSha256: sha256Hex(promptBytes),
    },
    observations: {
      path: observationsPath,
      sha256: sha256Hex(observationsBytes),
      count: observations.length,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { observationsPath, manifestPath, manifest, report, parseFailures };
}

/** Replay recorded observations through the pure report. When a run manifest
 *  sits next to the observations file its hashes are verified; a mismatching or
 *  absent manifest is surfaced as a provenance issue without hiding the report.
 *  The observations path is operator-chosen (artifacts may live outside the
 *  corpus workspace), so unlike corpus inputs it is read directly under a size
 *  bound instead of the file-tool confinement boundary. */
export async function reportA0Evaluation(input: {
  cwd: string;
  corpusPath: string;
  observationsPath: string;
}): Promise<A0ReportResult> {
  const corpusBytes = await readBounded(input.cwd, input.corpusPath);
  const cases = parseA0Corpus(corpusBytes.toString('utf8'));
  const observationsBytes = await readOperatorArtifact(input.observationsPath);
  let observations: A0Observation[];
  try {
    observations = parseA0Observations(observationsBytes.toString('utf8'));
  } catch (err) {
    throw new Error(`invalid observations file: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const report = computeA0Report(cases, observations);

  // The manifest sibling is derived by exact-lowercase `.jsonl` suffix; any
  // other file name simply has no discoverable manifest and reports unverified
  // provenance instead of mis-attributing the observations file itself.
  const manifestPath = input.observationsPath.toLowerCase().endsWith('.jsonl')
    ? `${input.observationsPath.slice(0, -'.jsonl'.length)}.manifest.json`
    : '';
  const provenanceIssues: string[] = [];
  let manifest: A0RunManifest | null = null;
  if (manifestPath !== '' && await fileExists(manifestPath)) {
    try {
      manifest = parseManifest((await readOperatorArtifact(manifestPath)).toString('utf8'));
    } catch (err) {
      throw new Error(`invalid run manifest: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (manifest.observations.sha256 !== sha256Hex(observationsBytes)) {
      provenanceIssues.push('observations bytes do not match the run manifest');
    }
    if (manifest.corpus.sha256 !== sha256Hex(corpusBytes)) {
      provenanceIssues.push('corpus bytes do not match the run manifest (corpus drifted after the run)');
    }
  } else {
    provenanceIssues.push('no run manifest found next to the observations; provenance is unverified');
  }
  return { report, manifest, provenanceIssues };
}

/** Load one evidence bundle through the file-open confinement boundary and
 *  return its text plus the hash of the bytes actually opened. Bundle bytes
 *  become model-visible only after passing the confinement check and the
 *  answer-leak guard, which scans objects and arrays to a bounded depth so a
 *  hidden answer key can never ride along at any nesting level. */
async function loadEvidenceBundle(cwd: string, evidence: { path: string }): Promise<{ text: string; sha256: string }> {
  const safe = await safeResolve(cwd, evidence.path);
  if (!safe.ok) throw new Error(`evidence path rejected at the file-open boundary: ${evidence.path}: ${safe.reason}`);
  const bytes = await readFile(safe.abs);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`evidence bundle exceeds its size bound: ${evidence.path}`);
  }
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`evidence bundle is not valid JSON: ${evidence.path}`);
  }
  if (containsAnswerKey(parsed)) {
    throw new Error(`evidence bundle carries answer keys and must never become model-visible: ${evidence.path}`);
  }
  return { text, sha256: sha256Hex(bytes) };
}

const MAX_ANSWER_KEY_DEPTH = 16;

/** Whether an answer key appears anywhere in the parsed bundle — nested objects
 *  and arrays included. Structures too deep to scan fail closed. */
function containsAnswerKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_ANSWER_KEY_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => containsAnswerKey(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((LABEL_KEYS_FORBIDDEN_IN_BUNDLE as readonly string[]).includes(key)) return true;
      if (containsAnswerKey(child, depth + 1)) return true;
    }
  }
  return false;
}

/** Parse the verifier reply. A reply that is not one strict JSON object with a
 *  valid leg3 becomes `cannotVerify` (recorded as a parse failure) — a broken
 *  answer raises the park rate and lowers consistency, so it can never turn a
 *  NO-GO gate green. */
function parseVerdict(text: string, caseId: string, attempt: number, failures: string[]): A0Leg3Label {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = (fenced === null ? text : fenced[1] ?? '').trim();
  try {
    const parsed = JSON.parse(candidate) as { leg3?: unknown };
    if (typeof parsed.leg3 === 'string'
      && (parsed.leg3 === 'proves' || parsed.leg3 === 'contradicts' || parsed.leg3 === 'cannotVerify')) {
      return parsed.leg3;
    }
  } catch {
    // fall through to the park path
  }
  failures.push(`${caseId} attempt ${attempt}: verifier reply was not a valid leg3 JSON object`);
  return 'cannotVerify';
}

async function readBounded(cwd: string, path: string): Promise<Buffer> {
  const safe = await safeResolve(cwd, path);
  if (!safe.ok) throw new Error(`input path rejected: ${path}: ${safe.reason}`);
  const info = await stat(safe.abs);
  if (!info.isFile()) throw new Error(`input path is not a regular file: ${path}`);
  if (info.size > MAX_INPUT_BYTES) throw new Error(`input file exceeds its size bound: ${path}`);
  return readFile(safe.abs);
}

/** Operator-chosen artifact paths (run outputs) may live outside the corpus
 *  workspace; they are read directly under the same size bound. */
async function readOperatorArtifact(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`artifact path is not a regular file: ${path}`);
  if (info.size > MAX_INPUT_BYTES) throw new Error(`artifact file exceeds its size bound: ${path}`);
  return readFile(path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  throw new Error(`artifact already exists and is immutable; choose a new output directory: ${path}`);
}

function parseManifest(text: string): A0RunManifest {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.schemaVersion !== A0_SCHEMA_VERSION || value.kind !== 'a0-run-manifest') {
    throw new Error('manifest must be schemaVersion 1 a0-run-manifest');
  }
  for (const key of ['startedAt', 'finishedAt', 'corpus', 'policy', 'observations']) {
    if (!(key in value)) throw new Error(`manifest is missing ${key}`);
  }
  return value as unknown as A0RunManifest;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
