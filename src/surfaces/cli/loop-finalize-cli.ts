import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  assertWorktreeRootOutsideCwd,
  buildLoopFinalizeReport,
  decideVerdict,
  isGoalRecord,
  isHumanReviewAuditRecord,
  isLoopRecord,
  loopWorktreeRoot,
  replayGoal,
  resolveExistingGoalWorktree,
  type FinalizeWorktreeStatus,
  type LoopCreatedRecord,
  type LoopFinalizeGoalEvidence,
  type LoopFinalizeProposal,
  type LoopFinalizeReport,
  type LoopRecord,
  type VerifierReport,
} from '../../capabilities/index.js';
import { defaultShellPath, runCommand } from '../../core/index.js';
import { loadSession } from '../../runtime/index.js';
import { assertOperationalJsonlIntegrity, parseJsonlWithDiagnostics } from '../../runtime/jsonl-integrity.js';
import { safeInline } from './approval.js';
import { parseLoopFinalizeArgs } from './loop-finalize-args.js';

const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_READ_OUTPUT_LIMIT = 20_000;
const GIT_WRITE_TIMEOUT_MS = 30_000;
const GIT_WRITE_OUTPUT_LIMIT = 50_000;
const GIT_PATCH_OUTPUT_LIMIT = 5_000_000;
const FINALIZE_DIFF_STAT_COMMAND = 'git diff --no-ext-diff --no-textconv --stat HEAD';
const FINALIZE_DIFF_HASH_COMMAND = 'git diff --no-ext-diff --no-textconv --binary --no-color HEAD';
const FINALIZE_DIFF_HASH_OUTPUT_LIMIT = 2_000_000;
const FINALIZE_PATCH_COMMAND = 'git diff --no-ext-diff --no-textconv --binary HEAD';
const FINALIZE_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'core.pager',
  GIT_CONFIG_VALUE_0: 'cat',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'core.hooksPath',
  GIT_CONFIG_VALUE_2: '/dev/null',
  GIT_CONFIG_KEY_3: 'interactive.diffFilter',
  GIT_CONFIG_VALUE_3: '',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
} as const;

async function main(): Promise<void> {
  let args;
  try {
    args = parseLoopFinalizeArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const loopPath = join(cwd, 'data', 'loops', `${args.loopId}.jsonl`);
  const dataDir = join(cwd, 'data');
  let records: LoopRecord[];
  try {
    records = await readLoopRecords(loopPath);
  } catch (err) {
    console.error(`[loop finalize] cannot read loop log ${safeInline(loopPath)}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let created: LoopCreatedRecord;
  try {
    created = latestLoopCreated(records, loopPath, args.loopId);
  } catch (err) {
    console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let worktreeBaseRoot: string;
  try {
    worktreeBaseRoot = await assertWorktreeRootOutsideCwd(args.worktreeRootPath ?? join(homedir(), '.jarvis', 'worktrees', basename(cwd)), cwd);
  } catch (err) {
    console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const shellPath = defaultShellPath();
  let report: LoopFinalizeReport;
  try {
    const statuses = await collectWorktreeStatuses({ created, cwd, worktreeBaseRoot, shellPath });
    const goalEvidence = await collectGoalEvidence(dataDir, records);
    report = buildLoopFinalizeReport(records, statuses, goalEvidence);
  } catch (err) {
    console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  printReport(report);
  if (args.merge) {
    const confirmed = await confirmMerge(report.loopId);
    if (!confirmed) {
      console.error('[loop finalize] merge cancelled: exact confirmation phrase was not provided');
      process.exitCode = 1;
      return;
    }

    let freshReport: LoopFinalizeReport;
    try {
      const freshRecords = await readLoopRecords(loopPath);
      const freshCreated = latestLoopCreated(freshRecords, loopPath, args.loopId);
      const freshStatuses = await collectWorktreeStatuses({ created: freshCreated, cwd, worktreeBaseRoot, shellPath });
      const freshGoalEvidence = await collectGoalEvidence(dataDir, freshRecords);
      freshReport = buildLoopFinalizeReport(freshRecords, freshStatuses, freshGoalEvidence);
    } catch (err) {
      console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    const auditPath = join(cwd, 'data', 'loops', `${freshReport.loopId}.finalize.jsonl`);
    try {
      await applyMergeProposals({ cwd, shellPath, report: freshReport, auditPath });
    } catch (err) {
      console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.cleanup) {
    const auditPath = join(cwd, 'data', 'loops', `${report.loopId}.finalize.jsonl`);
    try {
      printCleanupReport(buildCleanupReport(report, await readMergeAppliedAudit(auditPath, report.loopId)));
    } catch (err) {
      console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    const confirmed = await confirmCleanup(report.loopId);
    if (!confirmed) {
      console.error('[loop finalize] cleanup cancelled: exact confirmation phrase was not provided');
      process.exitCode = 1;
      return;
    }

    try {
      const freshRecords = await readLoopRecords(loopPath);
      const freshCreated = latestLoopCreated(freshRecords, loopPath, args.loopId);
      const freshStatuses = await collectWorktreeStatuses({ created: freshCreated, cwd, worktreeBaseRoot, shellPath });
      const freshGoalEvidence = await collectGoalEvidence(dataDir, freshRecords);
      const freshReport = buildLoopFinalizeReport(freshRecords, freshStatuses, freshGoalEvidence);
      const freshAudit = await readMergeAppliedAudit(auditPath, freshReport.loopId);
      const cleanupReport = buildCleanupReport(freshReport, freshAudit);
      await applyCleanupCandidates({ cwd, shellPath, cleanupReport, auditPath });
    } catch (err) {
      console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}

async function readLoopRecords(path: string): Promise<LoopRecord[]> {
  const parsed = parseJsonlWithDiagnostics(await readFile(path, 'utf8'), isLoopRecord);
  assertOperationalJsonlIntegrity(
    'loop',
    parsed.malformed,
    parsed.records.some((record) => record.t === 'loop-created'),
  );
  return parsed.records;
}

function latestLoopCreated(records: LoopRecord[], path: string, expectedId: string): LoopCreatedRecord {
  const created = [...records].reverse().find((record): record is LoopCreatedRecord => record.t === 'loop-created');
  if (created === undefined) throw new Error(`loop log is missing loop-created: ${path}`);
  if (created.id !== expectedId) throw new Error(`loop log id mismatch: expected ${expectedId}, found ${created.id}`);
  return created;
}

async function collectGoalEvidence(
  dataDir: string,
  records: readonly LoopRecord[],
): Promise<Map<string, LoopFinalizeGoalEvidence>> {
  const goalIds = new Set<string>();
  for (const record of records) {
    if (record.t === 'goal-started' || record.t === 'goal-finished') goalIds.add(record.goalId);
  }

  const evidence = new Map<string, LoopFinalizeGoalEvidence>();
  for (const goalId of goalIds) {
    const item = await readGoalEvidence(dataDir, goalId);
    if (item !== undefined) evidence.set(goalId, item);
  }
  return evidence;
}

async function readGoalEvidence(dataDir: string, goalId: string): Promise<LoopFinalizeGoalEvidence | undefined> {
  if (!isSafeLogId(goalId)) return undefined;
  let text: string;
  try {
    text = await readFile(join(dataDir, 'goals', `${goalId}.jsonl`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = parseJsonlWithDiagnostics(text, isGoalRecord);
  const replayed = replayGoal(parsed.records);
  assertOperationalJsonlIntegrity('goal', parsed.malformed, replayed.goal !== undefined);
  const latestRound = replayed.rounds.at(-1);
  const pinned = replayed.goal?.pinned ?? [];
  const hasVerifierReport = latestRound?.verdict?.report !== undefined;
  const storedOutcome = latestRound?.verdict?.outcome;
  const recomputed =
    latestRound?.checks !== undefined && latestRound.verdict !== undefined && (pinned.length === 0 || hasVerifierReport)
      ? decideVerdict(latestRound.checks, latestRound.verdict.report, replayed.goal?.pinned ?? [])
      : undefined;
  const outcome = recomputed?.outcome === storedOutcome ? storedOutcome : undefined;
  const humanRequirementIds = pinned
    .filter((requirement) => requirement.route === 'human')
    .map((requirement) => requirement.id);
  const requiresHumanReviewAudit =
    reportNeedsHumanReviewAudit(latestRound?.verdict?.report) || (outcome === 'verified' && humanRequirementIds.length > 0);
  const hasHumanReviewAudit =
    requiresHumanReviewAudit && latestRound !== undefined
      ? await hasMatchingHumanReviewAudit(dataDir, goalId, latestRound.round - 1, replayed.goal?.state, outcome, humanRequirementIds)
      : false;
  const session = replayed.goal?.sessionId === undefined ? undefined : await readSessionEvidence(dataDir, replayed.goal.sessionId);
  return {
    goalId: replayed.goal?.id ?? goalId,
    ...(replayed.goal?.objective === undefined ? {} : { objective: replayed.goal.objective }),
    ...(replayed.goal?.sessionId === undefined ? {} : { sessionId: replayed.goal.sessionId }),
    ...(session?.cwd === undefined ? {} : { sessionCwd: session.cwd }),
    ...(session?.format === undefined ? {} : { sessionFormat: session.format }),
    ...(session?.pendingTools === undefined ? {} : { sessionPendingTools: session.pendingTools }),
    pinnedCount: pinned.length,
    hasVerifierReport,
    ...(latestRound?.checks?.worktreeStatus?.trackedDiffHash === undefined
      ? {}
      : { worktreeDiffHash: latestRound.checks.worktreeStatus.trackedDiffHash }),
    ...(replayed.goal?.state === undefined ? {} : { state: replayed.goal.state }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(requiresHumanReviewAudit ? { requiresHumanReviewAudit, hasHumanReviewAudit } : {}),
  };
}

async function readSessionEvidence(
  dataDir: string,
  sessionId: string,
): Promise<{ cwd: string; format: 'v1' | 'v2'; pendingTools: number } | undefined> {
  if (!isSafeLogId(sessionId)) return undefined;
  let loaded;
  try {
    loaded = await loadSession(join(dataDir, 'sessions', `${sessionId}.jsonl`), { validateIntegrity: true });
  } catch {
    return undefined;
  }
  const header = loaded.header;
  if (header?.id !== sessionId) return undefined;
  return { cwd: header.cwd, format: loaded.format, pendingTools: loaded.pendingTools.length };
}

function reportNeedsHumanReviewAudit(report: VerifierReport | undefined): boolean {
  if (report === undefined) return false;
  return report.observed.includes('human review observed:') || report.evidence.includes('human review evidence:');
}

async function hasMatchingHumanReviewAudit(
  dataDir: string,
  goalId: string,
  previousRound: number,
  state: unknown,
  outcome: unknown,
  requirementIds: readonly string[],
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(dataDir, 'human-reviews', `${goalId}.jsonl`), 'utf8');
  } catch {
    return false;
  }
  const parsed = parseJsonlWithDiagnostics(text, isHumanReviewAuditRecord);
  assertOperationalJsonlIntegrity('human review', parsed.malformed, true);
  return parsed.records.some(
    (record) =>
      record.goalId === goalId &&
      (record.phase === undefined || record.phase === 'committed') &&
      record.previousRound === previousRound &&
      record.state === state &&
      record.verdict === outcome &&
      record.decisions.length > 0 &&
      decisionsCoverRequirements(record.decisions, requirementIds, outcome),
  );
}

function decisionsCoverRequirements(
  decisions: readonly { requirementId: string; decision: 'approve' | 'reject' }[],
  requirementIds: readonly string[],
  outcome: unknown,
): boolean {
  if (requirementIds.length === 0) return true;
  const byRequirement = new Map(decisions.map((decision) => [decision.requirementId, decision.decision]));
  if (byRequirement.size !== decisions.length || byRequirement.size !== requirementIds.length) return false;
  if (decisions.some((decision) => !requirementIds.includes(decision.requirementId))) return false;
  return requirementIds.every((id) => {
    const decision = byRequirement.get(id);
    return outcome === 'verified' ? decision === 'approve' : decision !== undefined;
  });
}

function isSafeLogId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes('/') && !value.includes('\\');
}

async function collectWorktreeStatuses(opts: {
  created: LoopCreatedRecord;
  cwd: string;
  worktreeBaseRoot: string;
  shellPath: string;
}): Promise<Map<number, FinalizeWorktreeStatus>> {
  const statuses = new Map<number, FinalizeWorktreeStatus>();
  for (let index = 0; index < opts.created.objectives.length; index++) {
    const fallbackPath = join(loopWorktreeRoot(opts.worktreeBaseRoot, opts.created.id), `g${index}`);
    try {
      const worktreePath = await resolveExistingGoalWorktree({ cwd: opts.cwd, root: opts.worktreeBaseRoot, loopId: opts.created.id, index });
      statuses.set(index, await readWorktreeStatus(worktreePath, opts.shellPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/missing resumed worktree|not a directory/.test(message)) throw err;
      statuses.set(index, missingWorktreeStatus(fallbackPath));
      continue;
    }
  }
  return statuses;
}

async function readWorktreeStatus(path: string, shellPath: string): Promise<FinalizeWorktreeStatus> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isDirectory()) {
    return missingWorktreeStatus(path);
  }
  const status = await runGitRead(shellPath, 'git status --porcelain=v1 --untracked-files=all', path);
  const diffStat = await runGitRead(shellPath, FINALIZE_DIFF_STAT_COMMAND, path);
  const diffHash = await runGitRead(shellPath, FINALIZE_DIFF_HASH_COMMAND, path, FINALIZE_DIFF_HASH_OUTPUT_LIMIT);
  const statusText = status.code === 0 ? status.output.trim() : `git status failed: ${status.output.trim() || status.spawnError || String(status.code)}`;
  const diffText = diffStat.code === 0 ? diffStat.output.trim() : `git diff failed: ${diffStat.output.trim() || diffStat.spawnError || String(diffStat.code)}`;
  const classified = status.code === 0 ? classifyStatus(statusText) : { conflicted: false, hasTrackedChanges: false, hasUntracked: false };
  const clean = status.code === 0 && statusText === '' && !classified.conflicted;
  const trackedDiffHash =
    diffHash.code === 0 && !diffHash.truncated
      ? createHash('sha256').update(diffHash.output, 'utf8').digest('hex')
      : undefined;
  return {
    path,
    exists: true,
    clean,
    conflicted: classified.conflicted,
    hasTrackedChanges: classified.hasTrackedChanges,
    hasUntracked: classified.hasUntracked,
    statusReadable: status.code === 0,
    diffReadable: diffStat.code === 0 && diffHash.code === 0 && !diffHash.truncated,
    status: statusText,
    diffStat: diffText,
    ...(trackedDiffHash === undefined ? {} : { trackedDiffHash }),
  };
}

function missingWorktreeStatus(path: string): FinalizeWorktreeStatus {
  return {
    path,
    exists: false,
    clean: false,
    conflicted: false,
    hasTrackedChanges: false,
    hasUntracked: false,
    statusReadable: false,
    diffReadable: false,
    status: '',
    diffStat: '',
  };
}

function runGitRead(shellPath: string, command: string, cwd: string, maxOutputChars = GIT_READ_OUTPUT_LIMIT) {
  return runCommand(shellPath, command, cwd, GIT_READ_TIMEOUT_MS, maxOutputChars, undefined, {
    scrubGitEnv: true,
    extraEnv: FINALIZE_GIT_ENV,
  });
}

function classifyStatus(status: string): { conflicted: boolean; hasTrackedChanges: boolean; hasUntracked: boolean } {
  let conflicted = false;
  let hasTrackedChanges = false;
  let hasUntracked = false;
  for (const line of status.split(/\r?\n/).filter((entry) => entry.trim() !== '')) {
    if (line.startsWith('??')) {
      hasUntracked = true;
      continue;
    }
    if (/^(DD|AU|UD|UA|DU|AA|UU)/.test(line)) {
      conflicted = true;
      continue;
    }
    hasTrackedChanges = true;
  }
  return { conflicted, hasTrackedChanges, hasUntracked };
}

function printReport(report: LoopFinalizeReport): void {
  console.log(`Loop finalize report: ${safeInline(report.loopId)}`);
  console.log(`Merge proposals: ${report.proposals.length}`);
  for (const item of report.items) {
    const goal = item.goalId ? ` ${safeInline(item.goalId)}` : '';
    console.log(`[${item.index}] ${item.decision} ${item.reason}${goal}`);
    if (item.worktree) console.log(`    worktree: ${safeInline(item.worktree.path)}`);
    if (item.worktree?.status) console.log(`    status: ${safeInline(item.worktree.status)}`);
    if (item.worktree?.diffStat) console.log(`    diff: ${safeInline(item.worktree.diffStat)}`);
  }
}

async function confirmMerge(loopId: string): Promise<boolean> {
  const expected = `merge ${loopId}`;
  process.stdout.write(`[loop finalize] Type "${expected}" to apply merge proposals: `);
  const answer = await readOneLine(process.stdin);
  return answer === expected;
}

async function confirmCleanup(loopId: string): Promise<boolean> {
  const expected = `cleanup ${loopId}`;
  process.stdout.write(`[loop finalize] Type "${expected}" to remove cleanup candidates: `);
  const answer = await readOneLine(process.stdin);
  return answer === expected;
}

async function readOneLine(input: NodeJS.ReadableStream): Promise<string | null> {
  const rl = createInterface({ input });
  try {
    for await (const line of rl) return line;
    return null;
  } finally {
    rl.close();
  }
}

async function applyMergeProposals(opts: { cwd: string; shellPath: string; report: LoopFinalizeReport; auditPath: string }): Promise<void> {
  if (opts.report.proposals.length === 0) {
    await appendAudit(opts.auditPath, { t: 'merge-confirmed', loopId: opts.report.loopId, proposals: 0, at: new Date().toISOString() });
    await appendAudit(opts.auditPath, { t: 'finalize-stopped', loopId: opts.report.loopId, reason: 'no-proposals', at: new Date().toISOString() });
    console.log('[loop finalize] no merge proposals after re-scan');
    return;
  }

  await assertMainCwdClean(opts.cwd, opts.shellPath);
  await appendAudit(opts.auditPath, {
    t: 'merge-confirmed',
    loopId: opts.report.loopId,
    proposals: opts.report.proposals.length,
    at: new Date().toISOString(),
  });

  for (const proposal of opts.report.proposals) {
    await applyOneProposal(opts, proposal);
  }
  await appendAudit(opts.auditPath, { t: 'finalize-stopped', loopId: opts.report.loopId, reason: 'merged', at: new Date().toISOString() });
}

interface CleanupCandidate {
  index: number;
  goalId: string;
  worktreePath: string;
}

interface CleanupParkedItem {
  index: number;
  goalId?: string;
  reason: string;
  worktreePath?: string;
}

interface CleanupReport {
  loopId: string;
  candidates: CleanupCandidate[];
  parked: CleanupParkedItem[];
}

function buildCleanupReport(report: LoopFinalizeReport, mergeApplied: Set<string>): CleanupReport {
  const candidates: CleanupCandidate[] = [];
  const parked: CleanupParkedItem[] = [];

  for (const item of report.items) {
    const base = {
      index: item.index,
      ...(item.goalId === undefined ? {} : { goalId: item.goalId }),
      ...(item.worktree?.path === undefined ? {} : { worktreePath: item.worktree.path }),
    };
    if (item.goalId === undefined || !mergeApplied.has(cleanupAuditKey(item.index, item.goalId))) {
      parked.push({ ...base, reason: 'missing-merge-audit' });
      continue;
    }
    if (item.worktree === undefined || !item.worktree.exists) {
      parked.push({ ...base, reason: 'missing-worktree' });
      continue;
    }
    if (item.worktree.conflicted) {
      parked.push({ ...base, reason: 'conflict' });
      continue;
    }
    if (!item.worktree.statusReadable || !item.worktree.diffReadable || item.worktree.hasUntracked || item.worktree.hasTrackedChanges || !item.worktree.clean) {
      parked.push({ ...base, reason: 'dirty' });
      continue;
    }
    candidates.push({ index: item.index, goalId: item.goalId, worktreePath: item.worktree.path });
  }

  return { loopId: report.loopId, candidates, parked };
}

function printCleanupReport(report: CleanupReport): void {
  console.log(`Cleanup candidates: ${report.candidates.length}`);
  for (const candidate of report.candidates) {
    console.log(`[cleanup ${candidate.index}] candidate ${safeInline(candidate.goalId)}`);
    console.log(`    worktree: ${safeInline(candidate.worktreePath)}`);
  }
  for (const item of report.parked) {
    const goal = item.goalId ? ` ${safeInline(item.goalId)}` : '';
    console.log(`[cleanup ${item.index}] park ${safeInline(item.reason)}${goal}`);
    if (item.worktreePath) console.log(`    worktree: ${safeInline(item.worktreePath)}`);
  }
}

async function readMergeAppliedAudit(path: string, loopId: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }

  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const record = JSON.parse(trimmed) as { t?: unknown; loopId?: unknown; index?: unknown; goalId?: unknown };
      if (record.t === 'merge-applied' && record.loopId === loopId && typeof record.index === 'number' && typeof record.goalId === 'string') {
        out.add(cleanupAuditKey(record.index, record.goalId));
      }
    } catch {
      // Ignore truncated/corrupt audit tail lines, mirroring loop JSONL replay.
    }
  }
  return out;
}

function cleanupAuditKey(index: number, goalId: string): string {
  return `${index}\0${goalId}`;
}

async function applyCleanupCandidates(opts: { cwd: string; shellPath: string; cleanupReport: CleanupReport; auditPath: string }): Promise<void> {
  await appendAudit(opts.auditPath, {
    t: 'cleanup-confirmed',
    loopId: opts.cleanupReport.loopId,
    candidates: opts.cleanupReport.candidates.length,
    at: new Date().toISOString(),
  });

  if (opts.cleanupReport.candidates.length === 0) {
    await appendAudit(opts.auditPath, { t: 'finalize-stopped', loopId: opts.cleanupReport.loopId, reason: 'no-cleanup-candidates', at: new Date().toISOString() });
    console.log('[loop finalize] no cleanup candidates after re-scan');
    return;
  }

  for (const candidate of opts.cleanupReport.candidates) {
    try {
      await detachDependencyBridge(opts.cwd, candidate.worktreePath);
    } catch (err) {
      const detail = `dependency bridge check failed: ${message(err)}`;
      await appendAudit(opts.auditPath, {
        t: 'finalize-stopped',
        loopId: opts.cleanupReport.loopId,
        reason: 'cleanup-remove-failed',
        index: candidate.index,
        goalId: candidate.goalId,
        detail,
        at: new Date().toISOString(),
      });
      throw new Error(`cleanup-remove-failed: ${detail}`, { cause: err });
    }
    const removed = await runGitWrite(opts.shellPath, `git worktree remove ${shellQuote(candidate.worktreePath)}`, opts.cwd);
    if (removed.code !== 0) {
      const detail = compactGitOutput(removed);
      await appendAudit(opts.auditPath, {
        t: 'finalize-stopped',
        loopId: opts.cleanupReport.loopId,
        reason: 'cleanup-remove-failed',
        index: candidate.index,
        goalId: candidate.goalId,
        detail,
        at: new Date().toISOString(),
      });
      throw new Error(`cleanup-remove-failed: ${detail}`);
    }
    await appendAudit(opts.auditPath, {
      t: 'cleanup-removed',
      loopId: opts.cleanupReport.loopId,
      index: candidate.index,
      goalId: candidate.goalId,
      worktreePath: candidate.worktreePath,
      at: new Date().toISOString(),
    });
    console.log(`[loop finalize] cleanup-removed [${candidate.index}] ${safeInline(candidate.goalId)}`);
  }
  await appendAudit(opts.auditPath, { t: 'finalize-stopped', loopId: opts.cleanupReport.loopId, reason: 'cleanup', at: new Date().toISOString() });
}

async function detachDependencyBridge(cwd: string, worktreePath: string): Promise<void> {
  const linkPath = join(worktreePath, 'node_modules');
  const linkInfo = await lstatIfExists(linkPath);
  if (linkInfo === undefined || !linkInfo.isSymbolicLink()) return;

  const hostPath = join(cwd, 'node_modules');
  const [linkTarget, hostTarget] = await Promise.all([realpath(linkPath), realpath(hostPath)]);
  if (!samePath(linkTarget, hostTarget)) {
    throw new Error(`node_modules link points outside the host dependency directory: ${linkTarget}`);
  }

  await unlink(linkPath);
  const remaining = await lstatIfExists(linkPath);
  if (remaining !== undefined) throw new Error('node_modules dependency bridge still exists after unlink');
  await stat(hostPath);
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as NodeJS.ErrnoException).code)
    : undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function assertMainCwdClean(cwd: string, shellPath: string): Promise<void> {
  const status = await runGitRead(shellPath, 'git status --porcelain=v1 --untracked-files=all', cwd);
  if (status.code !== 0) throw new Error(`main cwd status failed: ${compactGitOutput(status)}`);
  if (status.output.trim() !== '') throw new Error(`main cwd is dirty; merge stopped:\n${status.output.trim()}`);
}

async function applyOneProposal(
  opts: { cwd: string; shellPath: string; report: LoopFinalizeReport; auditPath: string },
  proposal: LoopFinalizeProposal,
): Promise<void> {
  const item = opts.report.items.find((candidate) => candidate.index === proposal.index);
  const worktreePath = item?.worktree?.path ?? proposal.worktreePath;
  const patch = await runGitPatch(opts.shellPath, FINALIZE_PATCH_COMMAND, worktreePath);
  if (patch.code !== 0 || patch.truncated) {
    await parkAndThrow(opts.auditPath, opts.report.loopId, proposal, 'patch-generation-failed', compactGitOutput(patch));
  }
  if (patch.output.trim() === '') {
    await parkAndThrow(opts.auditPath, opts.report.loopId, proposal, 'empty-patch', `${FINALIZE_PATCH_COMMAND} produced no patch`);
  }
  const patchHash = createHash('sha256').update(patch.output, 'utf8').digest('hex');
  if (patchHash !== proposal.worktreeDiffHash) {
    await parkAndThrow(
      opts.auditPath,
      opts.report.loopId,
      proposal,
      'patch-hash-mismatch',
      `verified ${proposal.worktreeDiffHash} but generated ${patchHash}`,
    );
  }

  const headBefore = await readGitHead(opts.cwd, opts.shellPath);
  const tempDir = await mkdtemp(join(tmpdir(), 'jarvis-finalize-patch-'));
  try {
    const patchPath = join(tempDir, `${opts.report.loopId}-g${proposal.index}.patch`);
    await writeFile(patchPath, patch.output, 'utf8');
    const quotedPatchPath = shellQuote(patchPath);
    const check = await runGitWrite(opts.shellPath, `git apply --check --index ${quotedPatchPath}`, opts.cwd);
    if (check.code !== 0) await parkAndThrow(opts.auditPath, opts.report.loopId, proposal, 'patch-check-failed', compactGitOutput(check));
    const applied = await runGitWrite(opts.shellPath, `git apply --index ${quotedPatchPath}`, opts.cwd);
    if (applied.code !== 0) await parkAndThrow(opts.auditPath, opts.report.loopId, proposal, 'patch-apply-failed', compactGitOutput(applied));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const headAfter = await readGitHead(opts.cwd, opts.shellPath);
  await appendAudit(opts.auditPath, {
    t: 'merge-applied',
    loopId: opts.report.loopId,
    index: proposal.index,
    goalId: proposal.goalId,
    worktreePath,
    patchBytes: Buffer.byteLength(patch.output, 'utf8'),
    patchHash,
    headBefore,
    headAfter,
    at: new Date().toISOString(),
  });
  console.log(`[loop finalize] merge-applied [${proposal.index}] ${safeInline(proposal.goalId)}`);
}

async function readGitHead(cwd: string, shellPath: string): Promise<string> {
  const head = await runGitRead(shellPath, 'git rev-parse HEAD', cwd);
  if (head.code !== 0) throw new Error(`git rev-parse HEAD failed: ${compactGitOutput(head)}`);
  return head.output.trim();
}

async function parkAndThrow(
  auditPath: string,
  loopId: string,
  proposal: LoopFinalizeProposal,
  reason: string,
  detail: string,
): Promise<never> {
  await appendAudit(auditPath, {
    t: 'merge-parked',
    loopId,
    index: proposal.index,
    goalId: proposal.goalId,
    reason,
    detail,
    at: new Date().toISOString(),
  });
  await appendAudit(auditPath, { t: 'finalize-stopped', loopId, reason, at: new Date().toISOString() });
  throw new Error(`${reason}: ${detail}`);
}

function runGitPatch(shellPath: string, command: string, cwd: string) {
  return runCommand(shellPath, command, cwd, GIT_WRITE_TIMEOUT_MS, GIT_PATCH_OUTPUT_LIMIT, undefined, {
    scrubGitEnv: true,
    extraEnv: FINALIZE_GIT_ENV,
  });
}

function runGitWrite(shellPath: string, command: string, cwd: string) {
  return runCommand(shellPath, command, cwd, GIT_WRITE_TIMEOUT_MS, GIT_WRITE_OUTPUT_LIMIT, undefined, {
    scrubGitEnv: true,
    extraEnv: FINALIZE_GIT_ENV,
  });
}

function compactGitOutput(result: Awaited<ReturnType<typeof runCommand>>): string {
  return result.output.trim() || result.spawnError || String(result.code);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function appendAudit(path: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

main().catch((err: unknown) => {
  console.error('\n[loop finalize] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
