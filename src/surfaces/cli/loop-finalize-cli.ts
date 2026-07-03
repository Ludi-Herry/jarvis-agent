import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  assertWorktreeRootOutsideCwd,
  buildLoopFinalizeReport,
  loopWorktreeRoot,
  parseLoopLog,
  resolveExistingGoalWorktree,
  type FinalizeWorktreeStatus,
  type LoopCreatedRecord,
  type LoopFinalizeProposal,
  type LoopFinalizeReport,
} from '../../capabilities/index.js';
import { defaultShellPath, runCommand } from '../../core/index.js';
import { safeInline } from './approval.js';
import { parseLoopFinalizeArgs } from './loop-finalize-args.js';

const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_READ_OUTPUT_LIMIT = 20_000;
const GIT_WRITE_TIMEOUT_MS = 30_000;
const GIT_WRITE_OUTPUT_LIMIT = 50_000;
const GIT_PATCH_OUTPUT_LIMIT = 5_000_000;
const FINALIZE_DIFF_STAT_COMMAND = 'git diff --no-ext-diff --no-textconv --stat HEAD';
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
  let records;
  try {
    records = parseLoopLog(await readFile(loopPath, 'utf8'));
  } catch (err) {
    console.error(`[loop finalize] cannot read loop log ${safeInline(loopPath)}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const created = [...records].reverse().find((record) => record.t === 'loop-created');
  if (created === undefined) {
    console.error(`[loop finalize] loop log is missing loop-created: ${safeInline(loopPath)}`);
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
    report = buildLoopFinalizeReport(records, statuses);
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
      const freshStatuses = await collectWorktreeStatuses({ created, cwd, worktreeBaseRoot, shellPath });
      freshReport = buildLoopFinalizeReport(records, freshStatuses);
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
      const freshStatuses = await collectWorktreeStatuses({ created, cwd, worktreeBaseRoot, shellPath });
      const freshReport = buildLoopFinalizeReport(records, freshStatuses);
      const freshAudit = await readMergeAppliedAudit(auditPath, freshReport.loopId);
      const cleanupReport = buildCleanupReport(freshReport, freshAudit);
      await applyCleanupCandidates({ cwd, shellPath, cleanupReport, auditPath });
    } catch (err) {
      console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
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
  const statusText = status.code === 0 ? status.output.trim() : `git status failed: ${status.output.trim() || status.spawnError || String(status.code)}`;
  const diffText = diffStat.code === 0 ? diffStat.output.trim() : `git diff failed: ${diffStat.output.trim() || diffStat.spawnError || String(diffStat.code)}`;
  const classified = status.code === 0 ? classifyStatus(statusText) : { conflicted: false, hasTrackedChanges: false, hasUntracked: false };
  const clean = status.code === 0 && statusText === '' && !classified.conflicted;
  return {
    path,
    exists: true,
    clean,
    conflicted: classified.conflicted,
    hasTrackedChanges: classified.hasTrackedChanges,
    hasUntracked: classified.hasUntracked,
    statusReadable: status.code === 0,
    diffReadable: diffStat.code === 0,
    status: statusText,
    diffStat: diffText,
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

function runGitRead(shellPath: string, command: string, cwd: string) {
  return runCommand(shellPath, command, cwd, GIT_READ_TIMEOUT_MS, GIT_READ_OUTPUT_LIMIT, undefined, {
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
    const removed = await runGitWrite(opts.shellPath, `git worktree remove ${shellQuote(candidate.worktreePath)}`, opts.cwd);
    if (removed.code !== 0) {
      await appendAudit(opts.auditPath, {
        t: 'finalize-stopped',
        loopId: opts.cleanupReport.loopId,
        reason: 'cleanup-remove-failed',
        index: candidate.index,
        goalId: candidate.goalId,
        detail: compactGitOutput(removed),
        at: new Date().toISOString(),
      });
      throw new Error(`cleanup-remove-failed: ${compactGitOutput(removed)}`);
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
