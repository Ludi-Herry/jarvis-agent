import { isAbsolute, posix, win32 } from 'node:path';

export const A0_SCHEMA_VERSION = 1 as const;
export type A0Classification = 'valid' | 'tampered' | 'ambiguous';
export type A0Leg3Label = 'proves' | 'contradicts' | 'cannotVerify';

export interface A0EvidenceRef {
  path: string;
  selector?: string;
  sha256?: string;
}

export interface A0Case {
  schemaVersion: typeof A0_SCHEMA_VERSION;
  caseId: string;
  classification: A0Classification;
  objective: string;
  evidence: A0EvidenceRef[];
  expectedLeg3: A0Leg3Label;
  labelOrigin: {
    kind: 'independent-review';
    reviewer: string;
    source: string;
    labeledAt: string;
  };
  promptVersion: string;
  modelPolicy: { builder: string; verifier: string };
  repetitions: 3;
  tags: string[];
}

export interface A0Observation {
  schemaVersion: typeof A0_SCHEMA_VERSION;
  caseId: string;
  attempt: 1 | 2 | 3;
  actualLeg3: A0Leg3Label;
  totalTokens: number;
  latencyMs: number;
  requestReconstructable: boolean;
  orphanSideEffects: number;
  receiptlessAttempts: number;
  staleRecallActions: number;
}

export interface A0Report {
  schemaVersion: typeof A0_SCHEMA_VERSION;
  verdict: 'GO' | 'NO-GO';
  coverage: { cases: number; observations: number; complete: boolean };
  metrics: {
    badCaseMissRate: number;
    goodCaseFalsePositiveRate: number;
    parkRate: number;
    repeatConsistency: number;
    meanTokensPerCase: number;
    p95LatencyMs: number;
    requestReconstructabilityRate: number;
    orphanSideEffects: number;
    receiptlessAttempts: number;
    staleRecallActions: number;
  };
  failures: string[];
}

export interface A0ModelVisibleCase {
  schemaVersion: typeof A0_SCHEMA_VERSION;
  caseId: string;
  objective: string;
  evidence: A0EvidenceRef[];
  promptVersion: string;
  modelPolicy: { builder: string; verifier: string };
}

export function parseA0Corpus(text: string): A0Case[] {
  const cases = parseLines(text, parseCase, 'A0 case');
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.caseId)) throw new Error(`duplicate A0 caseId: ${item.caseId}`);
    seen.add(item.caseId);
  }
  return cases;
}

export function parseA0Observations(text: string): A0Observation[] {
  return parseLines(text, parseObservation, 'A0 observation');
}

/** Build the only case shape a runner may place in a model request. Expected labels, classification,
 * reviewer provenance, repetitions, and tags stay harness-side so the eval cannot reveal its answer. */
export function modelVisibleA0Case(item: A0Case): A0ModelVisibleCase {
  return {
    schemaVersion: A0_SCHEMA_VERSION,
    caseId: item.caseId,
    objective: item.objective,
    evidence: item.evidence.map((evidence) => ({ ...evidence })),
    promptVersion: item.promptVersion,
    modelPolicy: { ...item.modelPolicy },
  };
}

export function computeA0Report(cases: A0Case[], observations: A0Observation[]): A0Report {
  const byId = new Map(cases.map((item) => [item.caseId, item]));
  const byCase = new Map<string, A0Observation[]>();
  const seen = new Set<string>();
  for (const observation of observations) {
    if (!byId.has(observation.caseId)) throw new Error(`A0 observation references unknown case: ${observation.caseId}`);
    const key = `${observation.caseId}:${observation.attempt}`;
    if (seen.has(key)) throw new Error(`duplicate observation: ${key}`);
    seen.add(key);
    const bucket = byCase.get(observation.caseId) ?? [];
    bucket.push(observation);
    byCase.set(observation.caseId, bucket);
  }

  const complete = cases.every((item) => {
    const attempts = (byCase.get(item.caseId) ?? []).map((observation) => observation.attempt).sort();
    return attempts.length === 3 && attempts[0] === 1 && attempts[1] === 2 && attempts[2] === 3;
  });
  const bad = observations.filter((observation) => byId.get(observation.caseId)?.classification === 'tampered');
  const good = observations.filter((observation) => byId.get(observation.caseId)?.classification === 'valid');
  const badMisses = bad.filter((observation) => observation.actualLeg3 !== 'contradicts').length;
  const goodFalsePositives = good.filter((observation) => observation.actualLeg3 === 'contradicts').length;
  const ambiguousDecisions = observations.filter((observation) =>
    byId.get(observation.caseId)?.classification === 'ambiguous' && observation.actualLeg3 !== 'cannotVerify');
  const parkCount = observations.filter((observation) => observation.actualLeg3 === 'cannotVerify').length;
  const repeatConsistency = cases.length === 0
    ? 0
    : cases.reduce((sum, item) => sum + consistency(byCase.get(item.caseId) ?? []), 0) / cases.length;
  const totalTokens = observations.reduce((sum, observation) => sum + observation.totalTokens, 0);
  const latencies = observations.map((observation) => observation.latencyMs).sort((a, b) => a - b);
  const reconstructable = observations.filter((observation) => observation.requestReconstructable).length;
  const orphanSideEffects = sumField(observations, 'orphanSideEffects');
  const receiptlessAttempts = sumField(observations, 'receiptlessAttempts');
  const staleRecallActions = sumField(observations, 'staleRecallActions');

  const metrics = {
    badCaseMissRate: rate(badMisses, bad.length),
    goodCaseFalsePositiveRate: rate(goodFalsePositives, good.length),
    parkRate: rate(parkCount, observations.length),
    repeatConsistency,
    meanTokensPerCase: rate(totalTokens, cases.length),
    p95LatencyMs: percentile95(latencies),
    requestReconstructabilityRate: rate(reconstructable, observations.length),
    orphanSideEffects,
    receiptlessAttempts,
    staleRecallActions,
  };
  const failures: string[] = [];
  for (const required of ['valid', 'tampered', 'ambiguous'] as const) {
    if (!cases.some((item) => item.classification === required)) {
      failures.push(`corpus must include at least one ${required} case`);
    }
  }
  if (!complete) failures.push('coverage must contain attempts 1, 2, and 3 for every case');
  if (badMisses > 0) failures.push(`known-bad misses detected: ${badMisses}`);
  if (metrics.goodCaseFalsePositiveRate > 0.1) failures.push(`good-case false-positive rate exceeds 10%: ${metrics.goodCaseFalsePositiveRate}`);
  if (ambiguousDecisions.length > 0) failures.push(`ambiguous cases must park: ${ambiguousDecisions.length} non-park decisions`);
  if (metrics.repeatConsistency < 0.9) failures.push(`repeat consistency is below 90%: ${metrics.repeatConsistency}`);
  if (metrics.requestReconstructabilityRate < 1) failures.push('request reconstructability is below 100%');
  if (orphanSideEffects > 0) failures.push(`orphan side effects detected: ${orphanSideEffects}`);
  if (receiptlessAttempts > 0) failures.push(`receiptless attempts detected: ${receiptlessAttempts}`);
  if (staleRecallActions > 0) failures.push(`stale Recall actions detected: ${staleRecallActions}`);

  return {
    schemaVersion: A0_SCHEMA_VERSION,
    verdict: failures.length === 0 ? 'GO' : 'NO-GO',
    coverage: { cases: cases.length, observations: observations.length, complete },
    metrics,
    failures,
  };
}

function parseCase(value: unknown): A0Case {
  const obj = object(value, 'A0 case');
  exactKeys(obj, ['schemaVersion', 'caseId', 'classification', 'objective', 'evidence', 'expectedLeg3', 'labelOrigin', 'promptVersion', 'modelPolicy', 'repetitions', 'tags'], 'A0 case');
  if (obj.schemaVersion !== A0_SCHEMA_VERSION) throw new Error('A0 case schemaVersion must be 1');
  const caseId = nonBlank(obj.caseId, 'caseId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(caseId)) throw new Error(`invalid A0 caseId: ${caseId}`);
  const classification = oneOf(obj.classification, ['valid', 'tampered', 'ambiguous'] as const, 'classification');
  const expectedLeg3 = oneOf(obj.expectedLeg3, ['proves', 'contradicts', 'cannotVerify'] as const, 'expectedLeg3');
  const aligned: Record<A0Classification, A0Leg3Label> = { valid: 'proves', tampered: 'contradicts', ambiguous: 'cannotVerify' };
  if (expectedLeg3 !== aligned[classification]) throw new Error('classification and expectedLeg3 do not align');
  if (!Array.isArray(obj.evidence) || obj.evidence.length === 0) throw new Error('evidence must be a non-empty array');
  const evidence = obj.evidence.map(parseEvidence);
  const label = object(obj.labelOrigin, 'labelOrigin');
  exactKeys(label, ['kind', 'reviewer', 'source', 'labeledAt'], 'labelOrigin');
  if (label.kind !== 'independent-review') throw new Error('labelOrigin.kind must be independent-review');
  const model = object(obj.modelPolicy, 'modelPolicy');
  exactKeys(model, ['builder', 'verifier'], 'modelPolicy');
  if (obj.repetitions !== 3) throw new Error('repetitions must equal 3');
  if (!Array.isArray(obj.tags) || obj.tags.length === 0 || !obj.tags.every((tag) => typeof tag === 'string' && tag.trim() !== '')) throw new Error('tags must be a non-empty array of non-empty strings');
  const labeledAt = isoTimestamp(label.labeledAt, 'labelOrigin.labeledAt');
  return {
    schemaVersion: A0_SCHEMA_VERSION,
    caseId,
    classification,
    objective: nonBlank(obj.objective, 'objective'),
    evidence,
    expectedLeg3,
    labelOrigin: {
      kind: 'independent-review',
      reviewer: nonBlank(label.reviewer, 'labelOrigin.reviewer'),
      source: nonBlank(label.source, 'labelOrigin.source'),
      labeledAt,
    },
    promptVersion: nonBlank(obj.promptVersion, 'promptVersion'),
    modelPolicy: { builder: nonBlank(model.builder, 'modelPolicy.builder'), verifier: nonBlank(model.verifier, 'modelPolicy.verifier') },
    repetitions: 3,
    tags: [...obj.tags],
  };
}

function parseEvidence(value: unknown): A0EvidenceRef {
  const obj = object(value, 'evidence item');
  exactKeys(obj, ['path', 'selector', 'sha256'], 'evidence item');
  const path = nonBlank(obj.path, 'evidence.path');
  const segments = path.split(/[\\/]+/);
  if (!isRepositoryRelativePath(path, segments)) {
    throw new Error(`evidence.path must be repository-relative: ${path}`);
  }
  if (obj.selector !== undefined && (typeof obj.selector !== 'string' || obj.selector.trim() === '')) throw new Error('evidence.selector must be a non-empty string');
  if (obj.sha256 !== undefined && (typeof obj.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(obj.sha256))) throw new Error('evidence.sha256 must be 64 hex characters');
  return {
    path,
    ...(obj.selector === undefined ? {} : { selector: obj.selector }),
    ...(obj.sha256 === undefined ? {} : { sha256: obj.sha256 }),
  };
}

function isRepositoryRelativePath(path: string, segments: string[]): boolean {
  if (isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path)) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (path.includes(':')) return false;
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return false;
  return !segments.includes('..');
}

function parseObservation(value: unknown): A0Observation {
  const obj = object(value, 'A0 observation');
  exactKeys(obj, ['schemaVersion', 'caseId', 'attempt', 'actualLeg3', 'totalTokens', 'latencyMs', 'requestReconstructable', 'orphanSideEffects', 'receiptlessAttempts', 'staleRecallActions'], 'A0 observation');
  if (obj.schemaVersion !== A0_SCHEMA_VERSION) throw new Error('A0 observation schemaVersion must be 1');
  if (obj.attempt !== 1 && obj.attempt !== 2 && obj.attempt !== 3) throw new Error('attempt must be 1, 2, or 3');
  return {
    schemaVersion: A0_SCHEMA_VERSION,
    caseId: nonBlank(obj.caseId, 'caseId'),
    attempt: obj.attempt,
    actualLeg3: oneOf(obj.actualLeg3, ['proves', 'contradicts', 'cannotVerify'] as const, 'actualLeg3'),
    totalTokens: nonNegativeInteger(obj.totalTokens, 'totalTokens'),
    latencyMs: nonNegativeInteger(obj.latencyMs, 'latencyMs'),
    requestReconstructable: boolean(obj.requestReconstructable, 'requestReconstructable'),
    orphanSideEffects: nonNegativeInteger(obj.orphanSideEffects, 'orphanSideEffects'),
    receiptlessAttempts: nonNegativeInteger(obj.receiptlessAttempts, 'receiptlessAttempts'),
    staleRecallActions: nonNegativeInteger(obj.staleRecallActions, 'staleRecallActions'),
  };
}

function parseLines<T>(text: string, parse: (value: unknown) => T, label: string): T[] {
  const out: T[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    try {
      out.push(parse(value));
    } catch (err) {
      throw new Error(`${label} line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return out;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(obj: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(', ')}`);
  const missing = allowed.filter((key) => !['selector', 'sha256'].includes(key) && !(key in obj));
  if (missing.length > 0) throw new Error(`${label} is missing keys: ${missing.join(', ')}`);
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = nonBlank(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  return value as T[number];
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function consistency(observations: A0Observation[]): number {
  if (observations.length === 0) return 0;
  const counts = new Map<A0Leg3Label, number>();
  for (const observation of observations) counts.set(observation.actualLeg3, (counts.get(observation.actualLeg3) ?? 0) + 1);
  return Math.max(...counts.values()) / observations.length;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
}

function sumField(observations: A0Observation[], field: 'orphanSideEffects' | 'receiptlessAttempts' | 'staleRecallActions'): number {
  return observations.reduce((sum, observation) => sum + observation[field], 0);
}
