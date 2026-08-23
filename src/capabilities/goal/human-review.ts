import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, opendir, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactSecrets } from '../../core/model/errors.js';
import {
  assertOperationalJsonlIntegrity,
  hasFiniteNumberFields,
  hasStringFields,
  isJsonObject,
  parseJsonlWithDiagnostics,
} from '../../runtime/jsonl-integrity.js';
import type {
  DeterministicChecks,
  GoalState,
  PinnedRequirement,
  Verdict,
  VerdictOutcome,
  VerifierReport,
} from './goal.js';
import { decideVerdict } from './verdict.js';
import {
  isGoalRecord,
  replayGoal,
  serializeGoalRecord,
} from './goal-store.js';
import {
  isLoopRecord,
  serializeLoopRecord,
  type LoopRecord,
} from './loop-store.js';

export type HumanReviewDecisionValue = 'approve' | 'reject';

export interface HumanReviewDecisionInput {
  requirementId: string;
  decision: HumanReviewDecisionValue;
  note: string;
}

export interface PendingHumanReviewRequirement {
  requirementId: string;
  text: string;
  reason: string;
}

export interface PendingHumanReview {
  goalId: string;
  objective: string;
  state: GoalState;
  verdict: VerdictOutcome;
  round: number;
  lastAt: string;
  requirements: PendingHumanReviewRequirement[];
  pinned: PinnedRequirement[];
  report: VerifierReport;
  checks: DeterministicChecks;
}

export interface HumanReviewAuditRecord {
  t: 'human-review-decision';
  decisionId?: string;
  phase?: 'planned' | 'committed';
  goalId: string;
  reviewer: string;
  at: string;
  previousRound: number;
  decisions: HumanReviewDecisionInput[];
  verdict: VerdictOutcome;
  state: GoalState;
}

export interface HumanReviewHistory {
  records: HumanReviewAuditRecord[];
  total: number;
  truncated: boolean;
  coverage: 'complete' | 'partial';
  warnings: string[];
}

export interface HumanReviewHistoryTestHooks {
  afterPathValidation?: (path: string) => Promise<void>;
  afterOpen?: (path: string) => Promise<void>;
}

export interface ApplyHumanReviewDecisionInput {
  dataDir: string;
  goalId: string;
  reviewer?: string;
  at?: string;
  decisions: HumanReviewDecisionInput[];
}

export interface ApplyHumanReviewDecisionResult {
  goalId: string;
  state: GoalState;
  verdict: Verdict;
  report: VerifierReport;
  round: number;
  audit: HumanReviewAuditRecord;
  auditStatus: 'committed' | 'uncertain';
  loop?: { loopId: string; index: number };
}

export class HumanReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HumanReviewError';
  }
}

const SAFE_LOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HUMAN_REVIEW_PREFIX = 'human verification required for ';
const MAX_NOTE_LENGTH = 1000;
const MAX_REVIEWER_LENGTH = 100;
const MAX_DISPLAY_TEXT_LENGTH = 4000;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_DIRECTORY_ENTRIES = 1000;
const MAX_HISTORY_FILES = 200;
const MAX_HISTORY_FILE_BYTES = 256 * 1024;
const MAX_HISTORY_RECORDS = 1000;
const MAX_HISTORY_WARNINGS = 20;
const decisionQueues = new Map<string, Promise<void>>();

export async function listPendingHumanReviews(dataDir: string): Promise<PendingHumanReview[]> {
  const entries = await jsonlEntries(join(dataDir, 'goals'));
  const reviews: PendingHumanReview[] = [];
  for (const entry of entries) {
    const goalId = basename(entry, '.jsonl');
    if (!isSafeLogId(goalId)) continue;
    const review = await loadPendingHumanReview(dataDir, goalId);
    if (review !== undefined) reviews.push(displaySafePendingReview(review));
  }
  return reviews.sort((a, b) => a.lastAt.localeCompare(b.lastAt));
}

export async function listHumanReviewHistory(
  dataDir: string,
  limit = DEFAULT_HISTORY_LIMIT,
  hooks: HumanReviewHistoryTestHooks = {},
): Promise<HumanReviewHistory> {
  const historyDir = join(dataDir, 'human-reviews');
  let canonicalHistoryDir: string;
  const entries: string[] = [];
  const warnings: string[] = [];
  try {
    const directory = await lstat(historyDir);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      return partialHumanReviewHistory('已裁决历史路径不是安全目录');
    }
    canonicalHistoryDir = await realpath(historyDir);
    const stream = await opendir(historyDir);
    let scannedEntries = 0;
    for await (const entry of stream) {
      scannedEntries++;
      if (scannedEntries > MAX_HISTORY_DIRECTORY_ENTRIES) {
        addHistoryWarning(warnings, `已裁决历史目录超过 ${MAX_HISTORY_DIRECTORY_ENTRIES} 个条目，停止继续枚举`);
        break;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      if (entries.length >= MAX_HISTORY_FILES) {
        addHistoryWarning(warnings, `已裁决历史文件超过 ${MAX_HISTORY_FILES} 个，只读取有界子集`);
        break;
      }
      entries.push(entry.name);
    }
    entries.sort();
  } catch (err) {
    if (isNotFoundError(err)) return emptyHumanReviewHistory();
    return partialHumanReviewHistory('已裁决历史目录无法读取');
  }

  const records: HumanReviewAuditRecord[] = [];
  for (const entry of entries) {
    if (records.length >= MAX_HISTORY_RECORDS) {
      addHistoryWarning(warnings, `已裁决历史记录超过 ${MAX_HISTORY_RECORDS} 条，停止继续解析`);
      break;
    }
    const goalId = basename(entry, '.jsonl');
    if (!isSafeLogId(goalId)) {
      addHistoryWarning(warnings, '已忽略名称不安全的裁决历史文件');
      continue;
    }
    const path = join(historyDir, entry);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const pathInfo = await lstat(path);
      if (
        pathInfo.isSymbolicLink()
        || !pathInfo.isFile()
        || pathInfo.nlink !== 1
      ) {
        addHistoryWarning(warnings, '有一份裁决历史不是安全文件');
        continue;
      }
      const canonicalFile = await realpath(path);
      if (!isContainedPath(canonicalHistoryDir, canonicalFile)) {
        addHistoryWarning(warnings, '有一份裁决历史不是安全文件');
        continue;
      }
      await hooks.afterPathValidation?.(path);
      handle = await open(canonicalFile, 'r');
      const fileInfo = await handle.stat();
      if (
        !fileInfo.isFile()
        || fileInfo.nlink !== 1
        || pathInfo.dev !== fileInfo.dev
        || pathInfo.ino !== fileInfo.ino
      ) {
        addHistoryWarning(warnings, '有一份裁决历史不是安全文件');
        continue;
      }
      if (fileInfo.size > MAX_HISTORY_FILE_BYTES) {
        addHistoryWarning(warnings, `有一份裁决历史超过 ${MAX_HISTORY_FILE_BYTES} 字节，已跳过`);
        continue;
      }
      await hooks.afterOpen?.(path);
      const bounded = await readBoundedUtf8(handle, MAX_HISTORY_FILE_BYTES);
      const finalInfo = await handle.stat();
      if (
        bounded.exceeded
        || fileInfo.size !== finalInfo.size
        || fileInfo.mtimeMs !== finalInfo.mtimeMs
        || fileInfo.ctimeMs !== finalInfo.ctimeMs
      ) {
        addHistoryWarning(warnings, `有一份裁决历史超过 ${MAX_HISTORY_FILE_BYTES} 字节或读取期间发生变化，已跳过`);
        continue;
      }
      const parsed = parseHumanReviewAuditBounded(
        bounded.text,
        MAX_HISTORY_RECORDS - records.length,
      );
      if (parsed.malformed) {
        addHistoryWarning(warnings, '有一份裁决历史包含无法解析的记录');
      }
      if (parsed.truncated) {
        addHistoryWarning(warnings, `已裁决历史记录超过 ${MAX_HISTORY_RECORDS} 条，停止继续解析`);
      }
      let identityMismatch = false;
      for (const record of parsed.records) {
        if (records.length >= MAX_HISTORY_RECORDS) {
          addHistoryWarning(warnings, `已裁决历史记录超过 ${MAX_HISTORY_RECORDS} 条，停止继续解析`);
          break;
        }
        if (record.goalId !== goalId) {
          identityMismatch = true;
          continue;
        }
        records.push(displaySafeAuditRecord(record));
      }
      if (identityMismatch) addHistoryWarning(warnings, '有一份裁决历史包含身份不匹配记录');
    } catch {
      addHistoryWarning(warnings, '有一份裁决历史无法安全读取');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  const collapsed = collapseHumanReviewAudit(records, warnings);
  collapsed.sort((a, b) => b.at.localeCompare(a.at)
    || a.goalId.localeCompare(b.goalId)
    || b.previousRound - a.previousRound);
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_HISTORY_LIMIT;
  return {
    records: collapsed.slice(0, boundedLimit),
    total: collapsed.length,
    truncated: collapsed.length > boundedLimit,
    coverage: warnings.length === 0 ? 'complete' : 'partial',
    warnings,
  };
}

export async function applyHumanReviewDecision(
  input: ApplyHumanReviewDecisionInput,
): Promise<ApplyHumanReviewDecisionResult> {
  const key = `${resolve(input.dataDir)}\0${input.goalId}`;
  const previous = decisionQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => applyHumanReviewDecisionUnlocked(input));
  const tail = run.then(() => undefined, () => undefined);
  decisionQueues.set(key, tail);
  return run.finally(() => {
    if (decisionQueues.get(key) === tail) decisionQueues.delete(key);
  });
}

async function applyHumanReviewDecisionUnlocked(
  input: ApplyHumanReviewDecisionInput,
): Promise<ApplyHumanReviewDecisionResult> {
  assertSafeLogId(input.goalId);
  const pending = await loadPendingHumanReview(input.dataDir, input.goalId);
  if (pending === undefined) {
    throw new HumanReviewError(404, `no pending human review for goal: ${input.goalId}`);
  }

  const decisions = normalizeDecisions(input.decisions, pending.requirements);
  const reviewer = normalizeReviewer(input.reviewer);
  const at = input.at ?? new Date().toISOString();
  const report = applyDecisionsToReport(pending.report, decisions, reviewer, at);
  const verdict = decideVerdict(pending.checks, report, pending.pinned);
  const state: GoalState = verdict.outcome === 'verified' ? 'complete' : 'blocked';
  const round = pending.round + 1;

  const decisionId = `human-review-${randomUUID()}`;
  const auditBase = {
    t: 'human-review-decision',
    decisionId,
    goalId: input.goalId,
    reviewer,
    at,
    previousRound: pending.round,
    decisions,
    verdict: verdict.outcome,
    state,
  } satisfies Omit<HumanReviewAuditRecord, 'phase'>;

  await mkdir(join(input.dataDir, 'human-reviews'), { recursive: true });
  const auditPath = join(input.dataDir, 'human-reviews', `${input.goalId}.jsonl`);
  const plannedAudit: HumanReviewAuditRecord = { ...auditBase, phase: 'planned' };
  await appendFile(auditPath, `${JSON.stringify(plannedAudit)}\n`, 'utf8');

  const goalPath = join(input.dataDir, 'goals', `${input.goalId}.jsonl`);
  await appendFile(
    goalPath,
    serializeGoalRecord({
      t: 'goal-round',
      round,
      turns: 0,
      tokens: 0,
      checks: pending.checks,
      verdict,
      at,
    }) + serializeGoalRecord({ t: 'goal-state', state, at }),
    'utf8',
  );

  const committedAudit: HumanReviewAuditRecord = { ...auditBase, phase: 'committed' };
  let audit: HumanReviewAuditRecord = committedAudit;
  let auditStatus: ApplyHumanReviewDecisionResult['auditStatus'] = 'committed';
  try {
    await appendFile(auditPath, `${JSON.stringify(committedAudit)}\n`, 'utf8');
  } catch {
    audit = plannedAudit;
    auditStatus = 'uncertain';
  }

  const loop = await appendLoopFinishIfPresent(input.dataDir, input.goalId, {
    state,
    outcome: verdict.outcome,
    rounds: round,
    tokens: totalTokensFromLatestGoal(input.dataDir, input.goalId),
    at,
  });

  return {
    goalId: input.goalId,
    state,
    verdict,
    report,
    round,
    audit,
    auditStatus,
    ...(loop === undefined ? {} : { loop }),
  };
}

export function parseHumanReviewAuditLog(text: string): HumanReviewAuditRecord[] {
  return parseJsonlWithDiagnostics(text, isHumanReviewAuditRecord).records;
}

export function isHumanReviewAuditRecord(value: unknown): value is HumanReviewAuditRecord {
  return isJsonObject(value)
    && value.t === 'human-review-decision'
    && ((value.decisionId === undefined && value.phase === undefined)
      || (typeof value.decisionId === 'string'
        && value.decisionId.length > 0
        && (value.phase === 'planned' || value.phase === 'committed')))
    && hasStringFields(value, 'goalId', 'reviewer', 'at')
    && hasFiniteNumberFields(value, 'previousRound')
    && Array.isArray(value.decisions)
    && value.decisions.every((decision) => isJsonObject(decision)
      && hasStringFields(decision, 'requirementId', 'note')
      && (decision.decision === 'approve' || decision.decision === 'reject'))
    && (value.verdict === 'verified'
      || value.verdict === 'checksOnly'
      || value.verdict === 'rejected'
      || value.verdict === 'couldNotVerify')
    && (value.state === 'active' || value.state === 'complete' || value.state === 'blocked');
}

async function loadPendingHumanReview(dataDir: string, goalId: string): Promise<PendingHumanReview | undefined> {
  assertSafeLogId(goalId);
  let text: string;
  try {
    text = await readFile(join(dataDir, 'goals', `${goalId}.jsonl`), 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseJsonlWithDiagnostics(text, isGoalRecord);
  const { goal, rounds } = replayGoal(parsed.records);
  assertOperationalJsonlIntegrity('goal', parsed.malformed, goal !== undefined);
  const latestRound = rounds.at(-1);
  const report = latestRound?.verdict?.report;
  if (
    goal === undefined ||
    latestRound === undefined ||
    latestRound.checks === undefined ||
    latestRound.verdict?.outcome !== 'couldNotVerify' ||
    report === undefined ||
    goal.state !== 'blocked'
  ) {
    return undefined;
  }

  const requirements = humanRequirementsFrom(goal.pinned, report);
  if (requirements.length === 0) return undefined;

  return {
    goalId,
    objective: goal.objective,
    state: goal.state,
    verdict: latestRound.verdict.outcome,
    round: latestRound.round,
    lastAt: latestRound.at,
    requirements,
    pinned: goal.pinned,
    report,
    checks: latestRound.checks,
  };
}

function humanRequirementsFrom(
  pinned: readonly PinnedRequirement[],
  report: VerifierReport,
): PendingHumanReviewRequirement[] {
  const humanPinnedById = new Map(
    pinned
      .filter((requirement) => requirement.route === 'human')
      .map((requirement) => [requirement.id, requirement.text]),
  );
  const cannotVerify = new Set(
    report.perRequirement
      .filter((score) => score.strength === 'cannotVerify')
      .map((score) => score.requirementId),
  );
  const requirements: PendingHumanReviewRequirement[] = [];
  const seen = new Set<string>();
  for (const reason of report.couldNotVerify) {
    const parsed = parseHumanReviewReason(reason);
    if (parsed === undefined || !cannotVerify.has(parsed.requirementId) || seen.has(parsed.requirementId)) continue;
    const pinnedText = humanPinnedById.get(parsed.requirementId);
    if (pinnedText === undefined) continue;
    seen.add(parsed.requirementId);
    requirements.push({
      requirementId: parsed.requirementId,
      text: pinnedText,
      reason,
    });
  }
  return requirements;
}

function parseHumanReviewReason(reason: string): { requirementId: string; text: string } | undefined {
  if (!reason.startsWith(HUMAN_REVIEW_PREFIX)) return undefined;
  const rest = reason.slice(HUMAN_REVIEW_PREFIX.length);
  const index = rest.indexOf(':');
  if (index <= 0) return undefined;
  const requirementId = rest.slice(0, index).trim();
  if (requirementId === '') return undefined;
  return { requirementId, text: rest.slice(index + 1).trim() };
}

function normalizeDecisions(
  decisions: readonly HumanReviewDecisionInput[],
  requirements: readonly PendingHumanReviewRequirement[],
): HumanReviewDecisionInput[] {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new HumanReviewError(400, 'decisions must include at least one human review decision');
  }
  const pendingIds = new Set(requirements.map((requirement) => requirement.requirementId));
  const seen = new Set<string>();
  return decisions.map((decision) => {
    if (!pendingIds.has(decision.requirementId)) {
      throw new HumanReviewError(400, `unknown human-review requirement: ${decision.requirementId}`);
    }
    if (seen.has(decision.requirementId)) {
      throw new HumanReviewError(400, `duplicate human-review requirement: ${decision.requirementId}`);
    }
    seen.add(decision.requirementId);
    if (decision.decision !== 'approve' && decision.decision !== 'reject') {
      throw new HumanReviewError(400, `invalid human-review decision: ${String(decision.decision)}`);
    }
    const note = safeReviewText(decision.note).slice(0, MAX_NOTE_LENGTH);
    if (note === '') throw new HumanReviewError(400, 'human-review decision note is required');
    return { requirementId: decision.requirementId, decision: decision.decision, note };
  });
}

function normalizeReviewer(reviewer: string | undefined): string {
  const value = safeReviewText(reviewer ?? '').slice(0, MAX_REVIEWER_LENGTH);
  return value === '' ? 'human' : value;
}

function displaySafePendingReview(review: PendingHumanReview): PendingHumanReview {
  return {
    ...review,
    objective: safeReviewText(review.objective),
    requirements: review.requirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      text: safeReviewText(requirement.text),
      reason: safeReviewText(requirement.reason),
    })),
    pinned: review.pinned.map((requirement) => ({
      id: requirement.id,
      text: safeReviewText(requirement.text),
      ...(requirement.route === undefined ? {} : { route: requirement.route }),
    })),
    report: {
      ...review.report,
      expected: safeReviewText(review.report.expected),
      observed: safeReviewText(review.report.observed),
      evidence: safeReviewText(review.report.evidence),
      couldNotVerify: review.report.couldNotVerify.map((reason) => safeReviewText(reason)),
      rationale: safeReviewText(review.report.rationale),
    },
  };
}

function displaySafeAuditRecord(record: HumanReviewAuditRecord): HumanReviewAuditRecord {
  return {
    ...record,
    goalId: safeReviewText(record.goalId),
    reviewer: safeReviewText(record.reviewer),
    at: safeReviewText(record.at),
    decisions: record.decisions.map((decision) => ({
      ...decision,
      requirementId: safeReviewText(decision.requirementId),
      note: safeReviewText(decision.note),
    })),
  };
}

async function readBoundedUtf8(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<{ text: string; exceeded: boolean }> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return {
    text: buffer.subarray(0, Math.min(offset, maxBytes)).toString('utf8'),
    exceeded: offset > maxBytes,
  };
}

function parseHumanReviewAuditBounded(
  text: string,
  maxRecords: number,
): { records: HumanReviewAuditRecord[]; malformed: boolean; truncated: boolean } {
  const records: HumanReviewAuditRecord[] = [];
  let malformed = false;
  let cursor = 0;
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, end).trim();
    if (line !== '') {
      if (records.length >= maxRecords) return { records, malformed, truncated: true };
      try {
        const value: unknown = JSON.parse(line);
        if (isHumanReviewAuditRecord(value)) records.push(value);
        else malformed = true;
      } catch {
        malformed = true;
      }
    }
    if (newline === -1) break;
    cursor = newline + 1;
  }
  return { records, malformed, truncated: false };
}

function collapseHumanReviewAudit(
  records: readonly HumanReviewAuditRecord[],
  warnings: string[],
): HumanReviewAuditRecord[] {
  const legacy: HumanReviewAuditRecord[] = [];
  const transactions = new Map<string, { planned?: HumanReviewAuditRecord; committed?: HumanReviewAuditRecord }>();
  for (const record of records) {
    if (record.decisionId === undefined || record.phase === undefined) {
      legacy.push(record);
      continue;
    }
    const transaction = transactions.get(record.decisionId) ?? {};
    if (transaction[record.phase] !== undefined) {
      addHistoryWarning(warnings, '已裁决历史包含重复事务阶段');
    }
    transaction[record.phase] = record;
    transactions.set(record.decisionId, transaction);
  }
  const collapsed = [...legacy];
  for (const transaction of transactions.values()) {
    if (transaction.committed !== undefined) collapsed.push(transaction.committed);
    else if (transaction.planned !== undefined) {
      collapsed.push(transaction.planned);
      addHistoryWarning(warnings, '有一条裁决写入状态待核对');
    }
  }
  return collapsed;
}

function emptyHumanReviewHistory(): HumanReviewHistory {
  return {
    records: [],
    total: 0,
    truncated: false,
    coverage: 'complete',
    warnings: [],
  };
}

function partialHumanReviewHistory(warning: string): HumanReviewHistory {
  return { ...emptyHumanReviewHistory(), coverage: 'partial', warnings: [warning] };
}

function addHistoryWarning(warnings: string[], warning: string): void {
  if (warnings.includes(warning)) return;
  if (warnings.length < MAX_HISTORY_WARNINGS) {
    warnings.push(warning);
    return;
  }
  warnings[MAX_HISTORY_WARNINGS - 1] = '更多裁决历史问题已省略';
}

function isContainedPath(parent: string, child: string): boolean {
  const local = relative(resolve(parent), resolve(child));
  return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function applyDecisionsToReport(
  report: VerifierReport,
  decisions: readonly HumanReviewDecisionInput[],
  reviewer: string,
  at: string,
): VerifierReport {
  const byRequirement = new Map(decisions.map((decision) => [decision.requirementId, decision]));
  const rejected = decisions.some((decision) => decision.decision === 'reject');
  const perRequirement = report.perRequirement.map((score) => {
    const decision = byRequirement.get(score.requirementId);
    if (decision === undefined) return score;
    return {
      requirementId: score.requirementId,
      strength: decision.decision === 'approve' ? 'proves' : 'contradicts',
      scope: 'matched',
    } satisfies VerifierReport['perRequirement'][number];
  });
  const couldNotVerify = report.couldNotVerify.filter((reason) => {
    const parsed = parseHumanReviewReason(reason);
    return parsed === undefined || !byRequirement.has(parsed.requirementId);
  });
  const reviewLines = decisions.map(
    (decision) => `${decision.requirementId}: human ${decision.decision} by ${reviewer} at ${at}; note: ${decision.note}`,
  );
  return {
    ...report,
    feature: report.feature === 'broken' || rejected ? 'broken' : 'works',
    observed: appendSection(report.observed, 'human review observed', reviewLines.join('\n')),
    evidence: appendSection(report.evidence, 'human review evidence', reviewLines.join('\n')),
    perRequirement,
    couldNotVerify,
    rationale:
      rejected
        ? 'Human review rejected one or more requirements.'
        : couldNotVerify.length > 0
          ? 'Human review resolved submitted requirements; other requirements still need verification.'
          : 'Human review verified all submitted human-routed requirements.',
  };
}

async function appendLoopFinishIfPresent(
  dataDir: string,
  goalId: string,
  finish: { state: GoalState; outcome: VerdictOutcome; rounds: number; tokens: Promise<number>; at: string },
): Promise<{ loopId: string; index: number } | undefined> {
  const loop = await findLoopForGoal(dataDir, goalId);
  if (loop === undefined) return undefined;
  await appendFile(
    loop.path,
    serializeLoopRecord({
      t: 'goal-finished',
      index: loop.index,
      goalId,
      state: finish.state,
      outcome: finish.outcome,
      ...(loop.verifierKey === undefined ? {} : { verifierKey: loop.verifierKey }),
      rounds: finish.rounds,
      tokens: await finish.tokens,
      at: finish.at,
    }),
    'utf8',
  );
  return { loopId: loop.loopId, index: loop.index };
}

async function findLoopForGoal(
  dataDir: string,
  goalId: string,
): Promise<{ path: string; loopId: string; index: number; verifierKey?: string } | undefined> {
  const entries = await jsonlEntries(join(dataDir, 'loops'));
  let found: { path: string; loopId: string; index: number; verifierKey?: string } | undefined;
  for (const entry of entries) {
    const path = join(dataDir, 'loops', entry);
    const parsed = parseJsonlWithDiagnostics(await readFile(path, 'utf8'), isLoopRecord);
    const records = parsed.records;
    assertOperationalJsonlIntegrity(
      'loop',
      parsed.malformed,
      records.some((record) => record.t === 'loop-created'),
    );
    const loopId = records.find((record): record is Extract<LoopRecord, { t: 'loop-created' }> => record.t === 'loop-created')
      ?.id ?? basename(entry, '.jsonl');
    for (const record of records) {
      if ((record.t === 'goal-started' || record.t === 'goal-finished') && record.goalId === goalId) {
        found = {
          path,
          loopId,
          index: record.index,
          ...(record.t === 'goal-finished' && record.verifierKey !== undefined
            ? { verifierKey: record.verifierKey }
            : {}),
        };
      }
    }
  }
  return found;
}

async function totalTokensFromLatestGoal(dataDir: string, goalId: string): Promise<number> {
  const text = await readFile(join(dataDir, 'goals', `${goalId}.jsonl`), 'utf8');
  const parsed = parseJsonlWithDiagnostics(text, isGoalRecord);
  const replayed = replayGoal(parsed.records);
  assertOperationalJsonlIntegrity('goal', parsed.malformed, replayed.goal !== undefined);
  return replayed.rounds.reduce((sum, round) => sum + (round.tokens ?? 0), 0);
}

async function jsonlEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((entry) => entry.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

function assertSafeLogId(value: string): void {
  if (!isSafeLogId(value)) throw new HumanReviewError(400, 'goal id must be a safe log filename');
}

function isSafeLogId(value: string): boolean {
  return SAFE_LOG_ID.test(value) && !value.includes('/') && !value.includes('\\');
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function appendSection(current: string, label: string, body: string): string {
  const trimmedCurrent = current.trim();
  const section = `${label}:\n${body.trim()}`;
  return trimmedCurrent === '' ? section : `${trimmedCurrent}\n\n${section}`;
}

function safeReviewText(text: string): string {
  return redactSecrets(stripUnsafeInline(text)).slice(0, MAX_DISPLAY_TEXT_LENGTH);
}

function stripUnsafeInline(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 32;
    const unsafe =
      code < 32 ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x061c ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    return unsafe ? ' ' : char;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}
