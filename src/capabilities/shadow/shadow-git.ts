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
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
    return `git --git-dir=${this.gitDirQ}${wt} ${args}`;
  }

  private exec(command: string): Promise<ExecResult> {
    return this.run(this.shellPath, command, this.cwd, TIMEOUT_MS, MAX_OUTPUT);
  }

  /** Create the shadow repo + its exclude list if absent. Idempotent; best-effort. */
  async init(): Promise<{ ok: boolean; reason?: string }> {
    if (this.initialized) return { ok: true };
    try {
      await mkdir(dirname(this.gitDir), { recursive: true });
      const res = await this.exec(this.cmd('init -q', false));
      if (res.code !== 0) return { ok: false, reason: gitFail('init', res) };
      // The gitdir's exclude file keeps node_modules/data/.git/etc out of every snapshot.
      await mkdir(join(this.gitDir, 'info'), { recursive: true });
      await writeFile(join(this.gitDir, 'info', 'exclude'), `${EXCLUDES.join('\n')}\n`, 'utf8');
      this.initialized = true;
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
        const add = await this.exec(this.cmd('add -A'));
        if (add.code !== 0) {
          const result = { ok: false as const, reason: gitFail('add', add) };
          settleCaptured(result);
          return result;
        }
        settleCaptured({ ok: true });
        const commit = await this.exec(this.cmd(`${IDENTITY} commit -q --allow-empty -m ${quote(sanitizeLabel(label))}`));
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

  /** The snapshot log (most recent first) as `<short-sha> <label>` lines, or [] on any failure. */
  async log(limit = 50): Promise<string[]> {
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
