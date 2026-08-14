import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolCapability } from '../../core/tools/types.js';
import { isSensitivePath } from './sensitive.js';

export interface GoalWorktreeWriteRequest {
  toolName: string;
  capability: ToolCapability;
  args: Record<string, unknown>;
  root: string;
}

export interface GoalWorktreeWriteDecision {
  allowed: boolean;
  reason: string;
}

export async function evaluateGoalWorktreeWrite(
  req: GoalWorktreeWriteRequest,
): Promise<GoalWorktreeWriteDecision | undefined> {
  if (req.capability !== 'writes-files') return undefined;
  if (req.toolName !== 'write') {
    return {
      allowed: false,
      reason: `goal worktree auto-allow only covers the built-in write tool; ${req.toolName} still requires approval`,
    };
  }

  const target = req.args.path;
  if (typeof target !== 'string' || target.trim() === '') {
    return { allowed: false, reason: 'goal worktree write requires a non-empty path string' };
  }
  const hasExpectedVersion = typeof req.args.expectedVersion === 'string' && req.args.expectedVersion.length > 0;
  const hasCreateOnly = req.args.createOnly === true;
  if (hasExpectedVersion === hasCreateOnly) {
    return {
      allowed: false,
      reason: 'goal worktree write requires exactly one precondition: expectedVersion or createOnly:true',
    };
  }

  const root = await realpath(resolve(req.root)).catch(() => resolve(req.root));
  const literal = resolve(root, target);
  const literalRefusal = refuseUnsafeTarget(root, literal, target, 'path');
  if (literalRefusal !== undefined) return { allowed: false, reason: literalRefusal };

  let effective: string;
  try {
    effective = await effectiveRealPath(literal);
  } catch {
    return { allowed: false, reason: `path could not be safely resolved (symlink loop?): ${target}` };
  }

  const effectiveRefusal = refuseUnsafeTarget(root, effective, target, 'path resolves');
  if (effectiveRefusal !== undefined) return { allowed: false, reason: effectiveRefusal };

  return { allowed: true, reason: `preconditioned write target stays inside goal worktree: ${target}` };
}

export function isGitMetadataPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return rel.split(/[\\/]+/).some((part) => part.toLowerCase() === '.git');
}

function refuseUnsafeTarget(root: string, candidate: string, original: string, prefix: string): string | undefined {
  if (!isWithin(root, candidate)) return `${prefix} escapes the goal worktree: ${original}`;
  if (isSensitivePath(candidate)) return `${prefix} touches a sensitive path: ${original}`;
  if (isGitMetadataPath(root, candidate)) return `${prefix} touches git metadata: ${original}`;
  return undefined;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const MAX_RESOLVE_HOPS = 40;

async function effectiveRealPath(abs: string, hops = 0): Promise<string> {
  if (hops > MAX_RESOLVE_HOPS) throw new Error(`too many symlink hops resolving ${abs}`);
  try {
    return await realpath(abs);
  } catch {
    // Continue below: the leaf may be a not-yet-created write target.
  }

  const parent = dirname(abs);
  if (parent === abs) return abs;

  const link = await readlink(abs).catch(() => null);
  if (link !== null) {
    const target = resolve(await effectiveRealPath(parent, hops + 1), link);
    return effectiveRealPath(target, hops + 1);
  }

  return resolve(await effectiveRealPath(parent, hops + 1), basename(abs));
}
