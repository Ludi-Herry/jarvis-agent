import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runCommand, type ExecResult } from '../../core/tools/run-command.js';

export type WorktreeRunCommand = (
  shellPath: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
) => Promise<ExecResult>;

export interface CreateGoalWorktreeOptions {
  shellPath: string;
  cwd: string;
  root: string;
  loopId: string;
  index: number;
  runCommand?: WorktreeRunCommand;
}

export interface ResolveExistingGoalWorktreeOptions {
  cwd: string;
  root: string;
  loopId: string;
  index: number;
}

const WORKTREE_TIMEOUT_MS = 60_000;
const WORKTREE_OUTPUT_LIMIT = 20_000;

export async function assertWorktreeRootOutsideCwd(root: string, cwd: string): Promise<string> {
  const rootPath = await canonicalPathForNewTarget(root);
  const cwdPath = await canonicalPathForNewTarget(cwd);
  if (isInsideOrSame(rootPath, cwdPath)) {
    throw new Error(`worktree root must be outside the repository cwd: ${rootPath}`);
  }
  return rootPath;
}

export async function createGoalWorktree(options: CreateGoalWorktreeOptions): Promise<string> {
  const root = await assertWorktreeRootOutsideCwd(options.root, options.cwd);
  const worktreePath = join(root, safePathSegment(options.loopId), `g${options.index}`);
  await mkdir(dirname(worktreePath), { recursive: true });

  const run = options.runCommand ?? runCommand;
  const result = await run(
    options.shellPath,
    `git worktree add --detach ${shellQuote(worktreePath)} HEAD`,
    options.cwd,
    WORKTREE_TIMEOUT_MS,
    WORKTREE_OUTPUT_LIMIT,
  );
  if (result.code !== 0) {
    const details = result.output.trim() || result.spawnError || `exit code ${String(result.code)}`;
    throw new Error(`git worktree add failed for ${worktreePath}: ${details}`);
  }
  return worktreePath;
}

export async function resolveExistingGoalWorktree(options: ResolveExistingGoalWorktreeOptions): Promise<string> {
  const root = await assertWorktreeRootOutsideCwd(options.root, options.cwd);
  const worktreePath = join(root, safePathSegment(options.loopId), `g${options.index}`);
  let info;
  try {
    info = await stat(worktreePath);
  } catch {
    throw new Error(`missing resumed worktree for goal ${options.index}: ${worktreePath}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`resumed worktree is not a directory for goal ${options.index}: ${worktreePath}`);
  }
  const worktreeReal = await realpath(worktreePath).catch(() => worktreePath);
  const cwdPath = await canonicalPathForNewTarget(options.cwd);
  if (isInsideOrSame(worktreeReal, cwdPath)) {
    throw new Error(`resumed worktree must stay outside the repository cwd: ${worktreePath}`);
  }
  return worktreePath;
}

export function loopWorktreeRoot(baseRoot: string, loopId: string): string {
  return join(baseRoot, safePathSegment(loopId));
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'loop';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function canonicalPathForNewTarget(path: string): Promise<string> {
  const resolved = resolve(path);
  const suffix: string[] = [];
  let cursor = resolved;

  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }

  const real = await realpath(cursor).catch(() => cursor);
  return resolve(real, ...suffix);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isInsideOrSame(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
