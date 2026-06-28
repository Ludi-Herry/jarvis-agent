/**
 * Path confinement for the file tools (read / write / grep).
 *
 * The PermissionGate only ever sees a tool call's literal `path` argument, so it can't tell
 * that `safe.txt` is a symlink to `.env`, nor that an absolute path or a `../` chain points
 * outside the project. This module is the execution-layer guard that closes that gap — the
 * file-tool analogue of bash's confined cwd: the gate decides IF a path may be touched; this
 * decides that the path we ACTUALLY touch is the one that was approved.
 *
 * Two checks, both anchored to `cwd` (the project root the loop injects):
 *  1. Literal containment + secrecy — a pure, disk-free reject of absolute/`..` escapes and
 *     obvious secret shapes, before any I/O.
 *  2. Symlink-aware re-check — follow the path to where a read/write would REALLY land
 *     (tolerant of a not-yet-created leaf) and reject if that target escapes `cwd` or is
 *     secret-bearing. This is what catches `safe.txt -> .env` and `dir -> /etc`.
 */
import { realpath, readlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { isSensitivePath } from '../../runtime/permission/index.js';

/** Pure: is `child` inside `parent` (or equal to it)? Compares the normalized relative path —
 *  it must not climb out with `..` and must not be absolute (a different Windows drive). Touches
 *  no disk, so it's the directly unit-testable core of the confinement decision. A sibling whose
 *  name merely starts with `..` (e.g. `..foo`) is correctly NOT treated as an escape. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export type SafePath = { ok: true; abs: string } | { ok: false; reason: string };

/**
 * Resolve `path` against `cwd` and confirm it is safe to read or write: contained within `cwd`
 * even after following symlinks, and never resolving to a secret. Returns the absolute path to
 * use, or a human-readable reason to refuse (surfaced to the model as a tool error).
 */
export async function safeResolve(cwd: string, path: string): Promise<SafePath> {
  const abs = resolve(cwd, path);

  // (1) Literal containment + secrecy — no disk touched yet. Blocks `/etc/passwd`, `../../x`,
  //     and a direct `.env` before we follow anything.
  if (!isWithin(cwd, abs)) return { ok: false, reason: `path escapes the project root: ${path}` };
  if (isSensitivePath(abs)) return { ok: false, reason: `refusing to access a sensitive path: ${path}` };

  // (2) Follow symlinks to the real target (even if the leaf doesn't exist yet) and re-check.
  const realRoot = await realpath(cwd).catch(() => cwd);
  let real: string;
  try {
    real = await effectiveRealPath(abs);
  } catch {
    // a symlink cycle or pathologically deep chain — fail closed rather than loop or guess.
    return { ok: false, reason: `path could not be safely resolved (symlink loop?): ${path}` };
  }
  if (!isWithin(realRoot, real)) return { ok: false, reason: `path resolves outside the project root: ${path}` };
  if (isSensitivePath(real)) return { ok: false, reason: `path resolves to a sensitive file: ${path}` };

  return { ok: true, abs };
}

/** Hard ceiling on resolution hops. A symlink cycle (a -> b -> a) or a pathologically deep chain
 *  trips it; {@link safeResolve} turns the throw into a fail-closed refusal. Mirrors the kernel's
 *  ELOOP bound. */
const MAX_RESOLVE_HOPS = 40;

/**
 * Where reading/writing `abs` would REALLY land, following symlinks, tolerant of a leaf (or
 * deeper tail) that doesn't exist yet. `realpath` alone throws on a not-yet-created write target
 * and on a dangling symlink-to-a-missing-secret, so we resolve the leaf manually in those cases:
 * an existing (even dangling) symlink is followed via `readlink`; a plain missing leaf keeps its
 * literal name on top of its parent's real path. Recursion terminates because the parent chain
 * reaches `cwd` (which exists) before the filesystem root.
 */
async function effectiveRealPath(abs: string, hops = 0): Promise<string> {
  if (hops > MAX_RESOLVE_HOPS) throw new Error(`too many symlink hops resolving ${abs} (cycle?)`);
  try {
    return await realpath(abs); // fully resolvable: file/dir exists, symlinks followed
  } catch {
    // not fully resolvable — a new write target, or a symlink whose target is missing
  }
  const parent = dirname(abs);
  if (parent === abs) return abs; // filesystem root — stop (defensive; unreachable for cwd-contained paths)

  const link = await readlink(abs).catch(() => null);
  if (link !== null) {
    // an existing (possibly dangling) symlink: resolve its target against the parent's real path,
    // then KEEP resolving — the target may itself be another (multi-hop) or dangling symlink, which
    // a single readlink would miss, letting a write punch through link1 -> link2 -> .env.
    const target = resolve(await effectiveRealPath(parent, hops + 1), link);
    return effectiveRealPath(target, hops + 1);
  }
  // a plain non-existent leaf: keep its literal name on top of the parent's resolved real path
  return resolve(await effectiveRealPath(parent, hops + 1), basename(abs));
}
