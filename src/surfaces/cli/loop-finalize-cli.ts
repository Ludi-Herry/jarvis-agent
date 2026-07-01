import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assertWorktreeRootOutsideCwd,
  buildLoopFinalizeReport,
  loopWorktreeRoot,
  parseLoopLog,
  resolveExistingGoalWorktree,
  type FinalizeWorktreeStatus,
} from '../../capabilities/index.js';
import { defaultShellPath, runCommand } from '../../core/index.js';
import { safeInline } from './approval.js';
import { parseLoopFinalizeArgs } from './loop-finalize-args.js';

const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_READ_OUTPUT_LIMIT = 20_000;

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
  const statuses = new Map<number, FinalizeWorktreeStatus>();
  try {
    for (let index = 0; index < created.objectives.length; index++) {
      const fallbackPath = join(loopWorktreeRoot(worktreeBaseRoot, created.id), `g${index}`);
      let worktreePath = fallbackPath;
      try {
        worktreePath = await resolveExistingGoalWorktree({ cwd, root: worktreeBaseRoot, loopId: created.id, index });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/missing resumed worktree|not a directory/.test(message)) throw err;
        statuses.set(index, { path: fallbackPath, exists: false, clean: false, conflicted: false, status: '', diffStat: '' });
        continue;
      }
      statuses.set(index, await readWorktreeStatus(worktreePath, shellPath));
    }
  } catch (err) {
    console.error(`[loop finalize] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const report = buildLoopFinalizeReport(records, statuses);
  printReport(report);
}

async function readWorktreeStatus(path: string, shellPath: string): Promise<FinalizeWorktreeStatus> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isDirectory()) {
    return { path, exists: false, clean: false, conflicted: false, status: '', diffStat: '' };
  }
  const status = await runGitRead(shellPath, 'git status --porcelain=v1 --untracked-files=all', path);
  const diffStat = await runGitRead(shellPath, 'git diff --stat HEAD', path);
  const statusText = status.code === 0 ? status.output.trim() : `git status failed: ${status.output.trim() || status.spawnError || String(status.code)}`;
  const diffText = diffStat.code === 0 ? diffStat.output.trim() : `git diff failed: ${diffStat.output.trim() || diffStat.spawnError || String(diffStat.code)}`;
  const conflicted = hasConflict(statusText);
  const clean = status.code === 0 && diffStat.code === 0 && statusText === '' && !conflicted;
  return { path, exists: true, clean, conflicted, status: statusText, diffStat: diffText };
}

function runGitRead(shellPath: string, command: string, cwd: string) {
  return runCommand(shellPath, command, cwd, GIT_READ_TIMEOUT_MS, GIT_READ_OUTPUT_LIMIT, undefined, {
    extraEnv: { GIT_OPTIONAL_LOCKS: '0' },
  });
}

function hasConflict(status: string): boolean {
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .some((line) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line));
}

function printReport(report: ReturnType<typeof buildLoopFinalizeReport>): void {
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

main().catch((err: unknown) => {
  console.error('\n[loop finalize] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
