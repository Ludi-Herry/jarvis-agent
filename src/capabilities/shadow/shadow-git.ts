/**
 * ShadowGit — a side git history of the agent's file changes (Phase E "shadow-git", first slice).
 *
 * The point: when the agent writes files during an autonomous run, snapshot the working tree to a
 * SEPARATE git repo so the operator can audit exactly what changed and ROLL BACK a bad change —
 * without touching the user's own `.git`. It reuses git itself (no reinventing diffs) via an explicit
 * `--git-dir=<data/shadow> --work-tree=<cwd>`, the dotfiles technique: the shadow gitdir lives under
 * `data/` (excluded from its own snapshots), the work-tree is the project root.
 *
 * Every operation is BEST-EFFORT: a missing/old git, or any command failure, returns a `skipped`
 * result rather than throwing — a snapshot is observability, and must never break the run it observes.
 * Commits carry an inline identity (`-c user.*`) so a fresh shadow repo needs no global git config.
 */
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCommand, type ExecResult } from '../../core/tools/run-command.js';

/** A snapshot's result: the new commit sha, or a best-effort skip with a reason. */
export type SnapshotResult = { ok: true; sha: string } | { ok: false; reason: string };
export type SnapshotCaptureResult = { ok: true } | { ok: false; reason: string };
export interface SnapshotHandle {
  /** Resolves after `git add -A` has captured the current work-tree into the shadow index. */
  captured: Promise<SnapshotCaptureResult>;
  /** Resolves after the snapshot commit exists (or a best-effort skip reason is known). */
  done: Promise<SnapshotResult>;
}
export type RestoreResult = { ok: true } | { ok: false; reason: string };
export interface CheckedRestorePreview {
  targetRef: string;
  preflightRef: string;
  changedPaths: string[];
}
export type CheckedRestorePrepareResult =
  | { ok: true; preview: CheckedRestorePreview }
  | { ok: false; kind: 'invalid-target' | 'unavailable' | 'unsafe-path' | 'drift'; reason: string };
export type CheckedRestoreResult =
  | { ok: true; preflightRef: string }
  | { ok: false; kind: 'invalid-target' | 'drift' | 'apply-failed' | 'recovery-required'; reason: string; preflightRef: string };

export interface ShadowGitDeps {
  shellPath: string;
  /** Project root — the work-tree the shadow tracks. */
  cwd: string;
  /** The shadow gitdir (e.g. `<cwd>/data/shadow`). Lives under `data/`, which is self-excluded. */
  gitDir: string;
  /** Injected for tests; defaults to the real {@link runCommand}. */
  run?: typeof runCommand;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 200_000;
const MAX_RESTORE_PATHS = 2_000;
const MAX_SNAPSHOT_PATHS = 20_000;
/** `git add -f` batches stay small so an explicit forced-capture list never hits the Windows
 *  command-line length limit; the shadow's own exclusions are never force-added. */
const MAX_FORCED_ADD_BATCH = 150;
const GIT_REF_PATTERN = /^[a-f0-9]{40}$/u;
const TRUSTED_GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = false',
  '\tbare = false',
  '\tlogallrefupdates = true',
  `\tsymlinks = ${process.platform === 'win32' ? 'false' : 'true'}`,
  `\tignorecase = ${process.platform === 'win32' || process.platform === 'darwin' ? 'true' : 'false'}`,
  ...(process.platform === 'darwin' ? ['\tprecomposeunicode = true'] : []),
  '',
].join('\n');
/**
 * Paths the shadow NEVER tracks, written to the shadow gitdir's own `info/exclude`. Two groups:
 *  - structural (root-anchored): build/install junk + the harness's own `data/` dir, which holds the
 *    shadow gitdir itself — tracking it would recurse — and the user's real `.git`.
 *  - secrets (un-anchored, any depth): mirrors the harness's secret policy (runtime/permission/
 *    sensitive.ts), NOT the project's `.gitignore`. The shadow's `git add -A` runs HARNESS-side and
 *    bypasses the PermissionGate, so THIS list is the secret boundary — a credential must never be
 *    copied into the shadow history regardless of whether the project happens to .gitignore it.
 */
const EXCLUDES = [
  '/.git/',
  '/node_modules/',
  '/data/',
  '/dist/',
  '/coverage/',
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.token',
  '*.crt',
  '*.cer',
  'auth.json',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.ssh/',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'credential',
  'credential.*',
  'credentials',
  'credentials.*',
];

/** Trailer appended to every snapshot commit made while forced capture of
 *  project-ignored paths is in effect. A target WITH this marker proves that
 *  any work-tree file it lacks was absent from disk at capture time; a target
 *  WITHOUT it predates forced capture and its absences prove nothing. */
const CAPTURE_MARKER = 'shadow-capture: project-ignored-v1';

/** Identity flags so a commit works without any global git config. */
const IDENTITY = "-c user.email=shadow@jarvis.local -c 'user.name=Jarvis Shadow'";

export class ShadowGit {
  private readonly run: typeof runCommand;
  private readonly shellPath: string;
  private readonly cwd: string;
  private readonly gitDir: string;
  private readonly gitDirQ: string;
  private readonly cwdQ: string;
  private initialized = false;

  constructor(deps: ShadowGitDeps) {
    this.run = deps.run ?? runCommand;
    this.shellPath = deps.shellPath;
    this.cwd = deps.cwd;
    this.gitDir = deps.gitDir;
    this.gitDirQ = quote(deps.gitDir);
    this.cwdQ = quote(deps.cwd);
  }

  /** A `git --git-dir=… [--work-tree=…] …` invocation. */
  private cmd(args: string, withWorkTree = true): string {
    const wt = withWorkTree ? ` --work-tree=${this.cwdQ}` : '';
    return `git -c core.hooksPath=/dev/null -c core.fsmonitor=false --git-dir=${this.gitDirQ}${wt} ${args}`;
  }

  private exec(command: string): Promise<ExecResult> {
    return this.run(this.shellPath, command, this.cwd, TIMEOUT_MS, MAX_OUTPUT, undefined, {
      scrubGitEnv: true,
      extraEnv: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_PAGER: 'cat',
      },
    });
  }

  /** Create the shadow repo + its exclude list if absent. Idempotent; best-effort. */
  async init(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await ensureSafeDirectoryTree(this.gitDir);
      await assertSafeGitLayout(this.gitDir);
      await writeTrustedGitMetadata(this.gitDir);
      if (!this.initialized) {
        const res = await this.exec(this.cmd('init -q', false));
        if (res.code !== 0) return { ok: false, reason: gitFail('init', res) };
        await assertSafeGitLayout(this.gitDir);
        await writeTrustedGitMetadata(this.gitDir);
        this.initialized = true;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: message(err) };
    }
  }

  /** Stage everything and commit a snapshot of the working tree. `--allow-empty` so a round with no
   *  file change still gets a marker. Returns the new sha, or a skip reason (best-effort). */
  async snapshot(label: string): Promise<SnapshotResult> {
    return this.snapshotAsync(label).done;
  }

  /** Two-phase snapshot for async goal loops: `captured` resolves after the shadow index owns the
   *  round's work-tree state; `done` resolves after the commit/rev-parse finishes. */
  snapshotAsync(label: string): SnapshotHandle {
    let capturedSettled = false;
    let resolveCaptured!: (result: SnapshotCaptureResult) => void;
    const captured = new Promise<SnapshotCaptureResult>((resolve) => {
      resolveCaptured = resolve;
    });
    const settleCaptured = (result: SnapshotCaptureResult): void => {
      if (capturedSettled) return;
      capturedSettled = true;
      resolveCaptured(result);
    };
    const done = (async (): Promise<SnapshotResult> => {
      try {
        const ready = await this.init();
        if (!ready.ok) {
          const result = { ok: false as const, reason: ready.reason ?? 'init failed' };
          settleCaptured(result);
          return result;
        }
        const plan = await this.planSnapshotCapture();
        if (!plan.ok) {
          settleCaptured(plan);
          return plan;
        }
        const add = await this.exec(this.cmd('add -A'));
        if (add.code !== 0) {
          const result = { ok: false as const, reason: gitFail('add', add) };
          settleCaptured(result);
          return result;
        }
        for (const batch of chunkPaths(plan.forcedPaths)) {
          const forced = await this.exec(this.cmd(`add -f -- ${batch.map(quote).join(' ')}`));
          if (forced.code !== 0) {
            const result = { ok: false as const, reason: gitFail('forced add', forced) };
            settleCaptured(result);
            return result;
          }
        }
        settleCaptured({ ok: true });
        const commit = await this.exec(this.cmd(
          `${IDENTITY} commit -q --allow-empty -m ${quote(sanitizeLabel(label))} -m ${quote(CAPTURE_MARKER)}`,
        ));
        if (commit.code !== 0) return { ok: false, reason: gitFail('commit', commit) };
        const head = await this.exec(this.cmd('rev-parse HEAD', false));
        if (head.code !== 0) return { ok: false, reason: gitFail('rev-parse', head) };
        return { ok: true, sha: head.output.trim() };
      } catch (err) {
        const result = { ok: false as const, reason: message(err) };
        settleCaptured(result);
        return result;
      }
    })();
    return { captured, done };
  }

  /** Inspect every path Git would capture before it can read through a link-like
   *  directory or copy bytes from a regular file that has another hard-link
   *  name. The inventory is bounded and any concurrent disappearance fails
   *  closed for this best-effort snapshot.
   *
   *  `git add -A` obeys `--exclude-standard`, so ordinary files the PROJECT's
   *  `.gitignore` ignores would silently drop out of every snapshot, drift
   *  check, and restore — a rewind could then report success while an ignored
   *  file kept its modified state. The plan therefore also computes the set of
   *  paths ignored ONLY by the project (the shadow's own structural/secret
   *  exclusions stay authoritative) and returns them as `forcedPaths` for an
   *  explicit, per-path `add -f`. Forced paths are filtered one by one against
   *  the harness policy, so no blanket `add -f` can pull secrets or structural
   *  directories into the shadow history. */
  private async planSnapshotCapture(): Promise<{ ok: true; forcedPaths: string[] } | { ok: false; reason: string }> {
    const inventory = await this.exec(this.cmd('ls-files --cached --others --exclude-standard -z'));
    if (inventory.code !== 0) return { ok: false, reason: gitFail('snapshot inventory', inventory) };
    if (inventory.truncated) return { ok: false, reason: 'shadow snapshot inventory exceeded its output bound' };
    const paths = splitNul(inventory.output);
    if (paths.length > MAX_SNAPSHOT_PATHS) {
      return { ok: false, reason: `shadow snapshot inventory exceeds ${MAX_SNAPSHOT_PATHS} paths` };
    }

    const worktreeRoot = resolve(this.cwd);
    for (const path of paths) {
      const check = validateShadowRestorePath(path);
      if (!check.ok) return { ok: false, reason: check.reason };
      const normalized = path.replace(/\\/gu, '/');
      const absolute = resolve(worktreeRoot, ...normalized.split('/'));
      const contained = relative(worktreeRoot, absolute);
      if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
        return { ok: false, reason: 'shadow snapshot inventory escapes the worktree' };
      }

      let cursor = worktreeRoot;
      const parts = normalized.split('/');
      for (const part of parts.slice(0, -1)) {
        cursor = join(cursor, part);
        try {
          const info = await lstat(cursor);
          if (info.isSymbolicLink() || !info.isDirectory()) {
            return { ok: false, reason: 'shadow snapshot path contains a symbolic link, reparse point, or non-directory' };
          }
        } catch (err) {
          if (isNotFoundError(err)) {
            return { ok: false, reason: 'worktree changed during shadow snapshot inventory' };
          }
          throw err;
        }
      }

      try {
        const leaf = await lstat(absolute);
        if (leaf.isFile() && leaf.nlink !== 1) {
          return { ok: false, reason: 'shadow snapshot refuses a regular file with a hard link' };
        }
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }

    const forced = await this.collectProjectIgnoredPaths({ remaining: MAX_SNAPSHOT_PATHS - paths.length });
    if (!forced.ok) return forced;
    return { ok: true, forcedPaths: forced.paths };
  }

  /** Paths the project's ignore rules exclude while the shadow's own
   *  `info/exclude` (structural + secrets) does not — i.e. ordinary
   *  project-ignored work-tree content the snapshot must still capture.
   *  Computed by git itself as the difference of two `--ignored` listings so
   *  the shadow never re-implements gitignore matching. Entries the harness
   *  policy refuses, plus symbolic links, hard links, and non-regular files
   *  found while expanding ignored directories, are skipped (never captured,
   *  never read); a concurrent disappearance fails closed. */
  private async collectProjectIgnoredPaths(
    budget: { remaining: number },
  ): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
    const [standardIgnored, shadowIgnored] = await Promise.all([
      this.exec(this.cmd('ls-files --others --ignored --exclude-standard -z --directory')),
      this.exec(this.cmd(`ls-files --others --ignored --exclude-from=${quote(join(this.gitDir, 'info', 'exclude'))} -z --directory`)),
    ]);
    for (const listing of [standardIgnored, shadowIgnored]) {
      if (listing.code !== 0) return { ok: false, reason: gitFail('project-ignored inventory', listing) };
      if (listing.truncated) {
        return { ok: false, reason: 'project-ignored snapshot inventory exceeded its output bound' };
      }
    }
    const shadowIgnoredSet = new Set(splitNul(shadowIgnored.output));
    const projectOnly = splitNul(standardIgnored.output).filter((path) => !shadowIgnoredSet.has(path));
    if (projectOnly.length > MAX_SNAPSHOT_PATHS) {
      return { ok: false, reason: `shadow snapshot inventory exceeds ${MAX_SNAPSHOT_PATHS} paths` };
    }

    const worktreeRoot = resolve(this.cwd);
    const collected: string[] = [];
    for (const entry of projectOnly) {
      const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
      if (normalized === '' || !validateShadowRestorePath(normalized).ok) continue;
      const absolute = resolve(worktreeRoot, ...normalized.split('/'));
      const contained = relative(worktreeRoot, absolute);
      if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
        return { ok: false, reason: 'shadow snapshot inventory escapes the worktree' };
      }
      let info;
      try {
        info = await lstat(absolute);
      } catch (err) {
        if (isNotFoundError(err)) {
          return { ok: false, reason: 'worktree changed during shadow snapshot inventory' };
        }
        throw err;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        const walked = await walkIgnoredDirectory(absolute, worktreeRoot, collected, budget);
        if (!walked.ok) return walked;
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) continue;
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        return { ok: false, reason: `shadow snapshot inventory exceeds ${MAX_SNAPSHOT_PATHS} paths` };
      }
      collected.push(toPosixPath(contained));
    }
    return { ok: true, paths: collected };
  }

  /** The snapshot log (most recent first) as `<short-sha> <label>` lines, or [] on any failure. */
  async log(limit = 50): Promise<string[]> {
    const ready = await this.init();
    if (!ready.ok) return [];
    const res = await this.exec(this.cmd(`log --oneline -n ${Math.max(1, Math.trunc(limit))}`, false));
    if (res.code !== 0) return [];
    return res.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  }

  /** Restore the working tree to a snapshot (`git checkout <ref> -- .`). Best-effort; this OVERWRITES
   *  the work-tree's tracked files with the snapshot's versions, so it's an explicit operator action. */
  async restore(ref: string): Promise<RestoreResult> {
    const ready = await this.init();
    if (!ready.ok) return { ok: false, reason: ready.reason ?? 'init failed' };
    const res = await this.exec(this.cmd(`checkout ${quote(ref)} -- .`));
    if (res.code !== 0) return { ok: false, reason: gitFail('checkout', res) };
    return { ok: true };
  }

  /**
   * Capture the current worktree into an immutable preflight commit, then
   * calculate the exact path set that a target snapshot would change. No user
   * file is changed by this step. Protected paths and non-regular tree entries
   * fail closed before a confirmation can be requested.
   */
  async prepareCheckedRestore(targetRef: string, label: string): Promise<CheckedRestorePrepareResult> {
    if (!GIT_REF_PATTERN.test(targetRef)) {
      return { ok: false, kind: 'invalid-target', reason: 'restore target must be a full 40-character commit id' };
    }
    const ready = await this.init();
    if (!ready.ok) return { ok: false, kind: 'unavailable', reason: ready.reason ?? 'shadow git init failed' };
    const target = await this.exec(this.cmd(`cat-file -e ${targetRef}^{commit}`, false));
    if (target.code !== 0) {
      return { ok: false, kind: 'invalid-target', reason: gitFail('target lookup', target) };
    }
    const preflight = await this.snapshot(label);
    if (!preflight.ok) return { ok: false, kind: 'unavailable', reason: preflight.reason };
    const clean = await this.assertCleanPreflight(preflight.sha);
    if (!clean.ok) return { ok: false, kind: 'drift', reason: clean.reason };
    const paths = await this.changedPaths(preflight.sha, targetRef);
    if (!paths.ok) return paths;
    const deletions = await this.assertRestorableDeletions(preflight.sha, targetRef);
    if (!deletions.ok) return { ok: false, kind: 'unsafe-path', reason: deletions.reason };
    const tree = await this.validateTargetTree(targetRef, new Set(paths.paths));
    if (!tree.ok) return tree;
    return {
      ok: true,
      preview: {
        targetRef,
        preflightRef: preflight.sha,
        changedPaths: paths.paths,
      },
    };
  }

  /** Apply one previously previewed restore only while HEAD, index, worktree,
   * and changed-path identity still match the preflight commit. */
  async applyCheckedRestore(preview: CheckedRestorePreview): Promise<CheckedRestoreResult> {
    const fallback = preview.preflightRef;
    if (!GIT_REF_PATTERN.test(preview.targetRef) || !GIT_REF_PATTERN.test(preview.preflightRef)) {
      return { ok: false, kind: 'invalid-target', reason: 'checked restore refs are invalid', preflightRef: fallback };
    }
    const ready = await this.init();
    if (!ready.ok) {
      return { ok: false, kind: 'drift', reason: ready.reason ?? 'shadow git init failed', preflightRef: fallback };
    }
    const clean = await this.assertCleanPreflight(preview.preflightRef);
    if (!clean.ok) return { ok: false, kind: 'drift', reason: clean.reason, preflightRef: fallback };
    const paths = await this.changedPaths(preview.preflightRef, preview.targetRef);
    if (!paths.ok) return { ok: false, kind: 'drift', reason: paths.reason, preflightRef: fallback };
    if (!samePaths(paths.paths, preview.changedPaths)) {
      return { ok: false, kind: 'drift', reason: 'restore path set changed after preview', preflightRef: fallback };
    }
    const deletions = await this.assertRestorableDeletions(preview.preflightRef, preview.targetRef);
    if (!deletions.ok) {
      return { ok: false, kind: 'drift', reason: deletions.reason, preflightRef: fallback };
    }

    const diff = this.cmd(
      `diff --no-ext-diff --no-textconv --binary --full-index --no-renames ${preview.preflightRef} ${preview.targetRef} --`,
    );
    const apply = this.cmd('apply --index --whitespace=nowarn -');
    const result = await this.exec(`set -o pipefail; ${diff} | ${apply}`);
    if (result.code !== 0) {
      const afterFailure = await this.assertCleanPreflight(preview.preflightRef);
      return afterFailure.ok
        ? {
            ok: false,
            kind: 'apply-failed',
            reason: gitFail('checked apply', result),
            preflightRef: fallback,
          }
        : {
            ok: false,
            kind: 'recovery-required',
            reason: `${gitFail('checked apply', result)}; ${afterFailure.reason}`,
            preflightRef: fallback,
          };
    }

    const [indexTree, targetTree, worktree] = await Promise.all([
      this.exec(this.cmd('write-tree', false)),
      this.exec(this.cmd(`rev-parse ${preview.targetRef}^{tree}`, false)),
      this.exec(this.cmd('diff --quiet --')),
    ]);
    if (indexTree.code !== 0 || targetTree.code !== 0 || worktree.code !== 0
      || indexTree.output.trim() !== targetTree.output.trim()) {
      return {
        ok: false,
        kind: 'recovery-required',
        reason: 'checked restore post-state does not match the target tree',
        preflightRef: fallback,
      };
    }
    return { ok: true, preflightRef: fallback };
  }

  private async assertCleanPreflight(preflightRef: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const head = await this.exec(this.cmd('rev-parse HEAD', false));
    if (head.code !== 0 || head.output.trim() !== preflightRef) {
      return { ok: false, reason: 'shadow HEAD changed after restore preview' };
    }
    const status = await this.exec(this.cmd('status --porcelain=v1 -z --untracked-files=all'));
    if (status.code !== 0) return { ok: false, reason: gitFail('status', status) };
    if (status.truncated || status.output !== '') {
      return { ok: false, reason: 'worktree or shadow index changed after restore preview' };
    }
    return { ok: true };
  }

  /** A checked restore must never delete a project-ignored file that is still
   *  on disk unless the target commit proves the file's absence. Targets with
   *  the capture marker recorded every project-ignored file present on disk,
   *  so a missing path really was created after that checkpoint and deleting
   *  it is the exact rewind semantics. Targets without the marker predate
   *  forced capture: their absences are ambiguous (the file may predate them
   *  unseen), and deleting such bytes is irreversible, so the ambiguous case
   *  fails closed; removing the file manually makes the rewind proceed. */
  private async assertRestorableDeletions(
    fromRef: string,
    toRef: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const deleted = await this.exec(this.cmd(
      `diff --no-ext-diff --no-textconv --name-only -z --no-renames --diff-filter=D ${fromRef} ${toRef} --`,
    ));
    if (deleted.code !== 0) return { ok: false, reason: gitFail('restore deletion preview', deleted) };
    if (deleted.truncated) return { ok: false, reason: 'restore deletion preview exceeded its output bound' };
    const onDisk: string[] = [];
    for (const path of splitNul(deleted.output)) {
      try {
        await lstat(resolve(this.cwd, ...path.split('/')));
        onDisk.push(path);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
    if (onDisk.length === 0) return { ok: true };
    const ignored = await this.checkIgnoredAgainstProjectRules(onDisk);
    if (!ignored.ok) return ignored;
    const deletions: string[] = [];
    for (const path of onDisk) {
      if (ignored.paths.has(path)) deletions.push(path);
    }
    if (deletions.length === 0) return { ok: true };
    const trusted = await this.hasCaptureMarker(toRef);
    if (!trusted.ok) return trusted;
    if (trusted.value) return { ok: true };
    return {
      ok: false,
      reason: `restore would delete project-ignored paths that are still on disk and whose absence from the target predates forced capture: ${deletions[0]}${deletions.length > 1 ? ` (+${deletions.length - 1} more)` : ''}; remove them manually before rewinding`,
    };
  }

  /** Whether a snapshot commit was created with forced capture of
   *  project-ignored paths in effect. */
  private async hasCaptureMarker(ref: string): Promise<{ ok: true; value: boolean } | { ok: false; reason: string }> {
    const commit = await this.exec(this.cmd(`cat-file commit ${ref}`, false));
    if (commit.code !== 0) return { ok: false, reason: gitFail('capture-marker inspection', commit) };
    if (commit.truncated) return { ok: false, reason: 'capture-marker inspection exceeded its output bound' };
    return { ok: true, value: commit.output.includes(CAPTURE_MARKER) };
  }

  /** Classify which of the given work-tree paths the project's ignore rules
   *  still exclude, using git itself (`--no-index` so tracked status cannot
   *  mask the rule). Secrets and structural paths excluded by the shadow's own
   *  policy can never appear in a restore diff, so "ignored" here means
   *  project-ignored. Input round-trips through a NUL-delimited file in the
   *  shadow gitdir so paths with spaces or non-ASCII names stay exact. */
  private async checkIgnoredAgainstProjectRules(
    paths: string[],
  ): Promise<{ ok: true; paths: Set<string> } | { ok: false; reason: string }> {
    const probe = join(this.gitDir, 'ignore-probe.tmp');
    try {
      await writeFile(probe, paths.map((path) => `${path}\0`).join(''), 'utf8');
      const res = await this.exec(this.cmd(`check-ignore --no-index --stdin -z -- < ${quote(probe)}`));
      if (res.code === 1) return { ok: true, paths: new Set() };
      if (res.code !== 0) return { ok: false, reason: gitFail('ignore classification', res) };
      return { ok: true, paths: new Set(splitNul(res.output)) };
    } finally {
      await rm(probe, { force: true });
    }
  }

  private async changedPaths(
    fromRef: string,
    toRef: string,
  ): Promise<
    | { ok: true; paths: string[] }
    | { ok: false; kind: 'unsafe-path' | 'drift'; reason: string }
  > {
    const diff = await this.exec(this.cmd(
      `diff --no-ext-diff --no-textconv --name-only -z --no-renames ${fromRef} ${toRef} --`,
    ));
    if (diff.code !== 0) return { ok: false, kind: 'drift', reason: gitFail('diff preview', diff) };
    if (diff.truncated) return { ok: false, kind: 'unsafe-path', reason: 'restore path preview exceeded its output bound' };
    const paths = diff.output.split('\0').filter((path) => path !== '');
    if (paths.length > MAX_RESTORE_PATHS) {
      return { ok: false, kind: 'unsafe-path', reason: `restore changes more than ${MAX_RESTORE_PATHS} paths` };
    }
    for (const path of paths) {
      const check = validateShadowRestorePath(path);
      if (!check.ok) return { ok: false, kind: 'unsafe-path', reason: check.reason };
    }
    return { ok: true, paths };
  }

  private async validateTargetTree(
    targetRef: string,
    changedPaths: ReadonlySet<string>,
  ): Promise<{ ok: true } | { ok: false; kind: 'unsafe-path'; reason: string }> {
    const tree = await this.exec(this.cmd(`ls-tree -rz ${targetRef} --`, false));
    if (tree.code !== 0) return { ok: false, kind: 'unsafe-path', reason: gitFail('tree inspection', tree) };
    if (tree.truncated) return { ok: false, kind: 'unsafe-path', reason: 'restore target tree exceeded its inspection bound' };
    for (const entry of tree.output.split('\0')) {
      if (entry === '') continue;
      const tab = entry.indexOf('\t');
      if (tab < 0) return { ok: false, kind: 'unsafe-path', reason: 'restore target tree entry is malformed' };
      const metadata = entry.slice(0, tab);
      const path = entry.slice(tab + 1);
      if (!changedPaths.has(path)) continue;
      const mode = metadata.split(' ', 1)[0];
      if (mode === '120000' || mode === '160000') {
        return { ok: false, kind: 'unsafe-path', reason: `restore target contains a link-like entry: ${path}` };
      }
    }
    return { ok: true };
  }
}

export function validateShadowRestorePath(path: string): { ok: true } | { ok: false; reason: string } {
  const normalized = path.replace(/\\/gu, '/');
  if (normalized === '' || normalized.length > 512) return { ok: false, reason: 'restore path is empty or too long' };
  if (Array.from(normalized).some((character) => {
    const code = character.codePointAt(0) ?? 32;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) {
    return { ok: false, reason: 'restore path contains terminal control characters' };
  }
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//u.test(normalized)) {
    return { ok: false, reason: `restore path is absolute: ${normalized}` };
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return { ok: false, reason: `restore path escapes the worktree: ${normalized}` };
  }
  const root = parts[0].toLowerCase();
  if (root === '.git' || root === 'data' || root === 'node_modules' || root === 'dist' || root === 'coverage') {
    return { ok: false, reason: `restore path is protected: ${normalized}` };
  }
  if (parts.some((part) => part.toLowerCase() === '.ssh')) {
    return { ok: false, reason: `restore path is credential-bearing: ${normalized}` };
  }
  const base = parts.at(-1)?.toLowerCase() ?? '';
  if (base === '.env' || base.startsWith('.env.')
    || ['.npmrc', '.netrc', '.git-credentials', 'auth.json'].includes(base)
    || /^(?:credential|credentials)(?:\..+)?$/u.test(base)
    || /\.(?:key|pem|p12|pfx|token|crt|cer)$/u.test(base)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519).*/u.test(base)) {
    return { ok: false, reason: `restore path is credential-bearing: ${normalized}` };
  }
  return { ok: true };
}

/** Single-quote a path/string for the POSIX shell, normalizing Windows backslashes to forward slashes
 *  (Git Bash accepts `H:/x`; a backslash inside single quotes would stay literal and break the path). */
function quote(s: string): string {
  return `'${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

/** Strip newlines/control chars from a commit label so it can't break out of the `-m` argument. */
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[\r\n]+/g, ' ').trim();
  return cleaned === '' ? 'snapshot' : cleaned.slice(0, 200);
}

function gitFail(step: string, res: ExecResult): string {
  const detail = res.spawnError ?? res.output.trim().split('\n').slice(-1)[0] ?? '';
  return `git ${step} failed (code ${res.code ?? 'killed'})${detail ? `: ${detail}` : ''}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((path) => path !== '');
}

function chunkPaths(paths: string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < paths.length; index += MAX_FORCED_ADD_BATCH) {
    batches.push(paths.slice(index, index + MAX_FORCED_ADD_BATCH));
  }
  return batches;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/gu, '/');
}

/** Expand one project-ignored directory into the ordinary regular files the
 *  snapshot will capture. Symbolic links (junctions included), hard links, and
 *  paths the harness policy refuses are skipped — skipped means never added
 *  and never read, so a restore can never recreate them; only a concurrent
 *  disappearance fails closed. */
async function walkIgnoredDirectory(
  directory: string,
  worktreeRoot: string,
  out: string[],
  budget: { remaining: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (err) {
    if (isNotFoundError(err)) return { ok: false, reason: 'worktree changed during shadow snapshot inventory' };
    throw err;
  }
  for (const name of names) {
    const child = join(directory, name);
    let info;
    try {
      info = await lstat(child);
    } catch (err) {
      if (isNotFoundError(err)) return { ok: false, reason: 'worktree changed during shadow snapshot inventory' };
      throw err;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const walked = await walkIgnoredDirectory(child, worktreeRoot, out, budget);
      if (!walked.ok) return walked;
      continue;
    }
    if (!info.isFile() || info.nlink !== 1) continue;
    const contained = toPosixPath(relative(worktreeRoot, child));
    if (!validateShadowRestorePath(contained).ok) continue;
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      return { ok: false, reason: `shadow snapshot inventory exceeds ${MAX_SNAPSHOT_PATHS} paths` };
    }
    out.push(contained);
  }
  return { ok: true };
}

async function ensureSafeDirectoryTree(target: string): Promise<void> {
  const missing: string[] = [];
  let cursor = resolve(target);
  for (;;) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`shadow git path component is a symbolic link, reparse point, or non-directory: ${cursor}`);
      }
      break;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      const parent = dirname(cursor);
      if (parent === cursor) throw err;
      missing.push(cursor);
      cursor = parent;
    }
  }
  for (const path of missing.reverse()) {
    try {
      await mkdir(path);
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`shadow git path component is unsafe after creation: ${path}`);
    }
  }
}

async function assertSafeGitLayout(gitDir: string): Promise<void> {
  for (const name of ['hooks', 'info', 'objects', 'refs']) {
    const path = join(gitDir, name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`shadow git internal directory is unsafe: ${path}`);
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }
  for (const name of ['HEAD', 'config', 'index', 'packed-refs']) {
    await assertSafeOptionalFile(join(gitDir, name));
  }
}

async function assertSafeOptionalFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`shadow git internal file is unsafe: ${path}`);
    }
    if (info.nlink !== 1) throw new Error(`shadow git internal file must not be a hard link: ${path}`);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

async function writeTrustedGitMetadata(gitDir: string): Promise<void> {
  const configPath = join(gitDir, 'config');
  await assertSafeOptionalFile(configPath);
  await writeFile(configPath, TRUSTED_GIT_CONFIG, 'utf8');

  const infoDir = join(gitDir, 'info');
  await ensureSafeDirectoryTree(infoDir);
  const excludePath = join(infoDir, 'exclude');
  await assertSafeOptionalFile(excludePath);
  await writeFile(excludePath, `${EXCLUDES.join('\n')}\n`, 'utf8');
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}

function isAlreadyExistsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code?: unknown }).code === 'EEXIST';
}
