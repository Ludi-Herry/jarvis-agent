import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ShadowGit,
  validateShadowRestorePath,
} from '../../../src/capabilities/shadow/shadow-git.js';
import { defaultShellPath, runCommand, type ExecResult } from '../../../src/core/tools/run-command.js';

const shell = defaultShellPath();

let dir: string;
let shadow: ShadowGit;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-shadow-'));
  shadow = new ShadowGit({ shellPath: shell, cwd: dir, gitDir: join(dir, 'data', 'shadow') });
});
afterEach(async () => {
  // Recent Git ends `git commit` by starting a detached `git maintenance run --auto` that can still
  // be touching data/shadow/objects for a moment after the snapshot returned; on a busy CI runner
  // that raced this cleanup (ENOTEMPTY on Linux). Retry briefly instead of racing it.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('ShadowGit — real git round-trip', () => {
  it('previews and applies a checked restore while retaining a preflight snapshot', async () => {
    await mkdir(join(dir, 'folder with spaces'), { recursive: true });
    await writeFile(join(dir, 'folder with spaces', 'a b.txt'), 'v1');
    const target = await shadow.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'folder with spaces', 'a b.txt'), 'v2');
    await writeFile(join(dir, 'later-untracked.txt'), 'later');

    const prepared = await shadow.prepareCheckedRestore(target.sha, 'rewind preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.preview.preflightRef).toMatch(/^[0-9a-f]{40}$/u);
    expect(prepared.preview.changedPaths).toEqual([
      'folder with spaces/a b.txt',
      'later-untracked.txt',
    ]);

    const applied = await shadow.applyCheckedRestore(prepared.preview);
    expect(applied).toEqual({ ok: true, preflightRef: prepared.preview.preflightRef });
    expect(await readFile(join(dir, 'folder with spaces', 'a b.txt'), 'utf8')).toBe('v1');
    await expect(readFile(join(dir, 'later-untracked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('rejects worktree drift after preview before changing any file', async () => {
    await writeFile(join(dir, 'a.txt'), 'target');
    const target = await shadow.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'a.txt'), 'preview');
    const prepared = await shadow.prepareCheckedRestore(target.sha, 'preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await writeFile(join(dir, 'a.txt'), 'concurrent');

    const applied = await shadow.applyCheckedRestore(prepared.preview);
    expect(applied).toMatchObject({ ok: false, kind: 'drift' });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('concurrent');
  }, 20_000);

  it('leaves the preflight worktree intact when checked apply fails and never uses reset --hard', async () => {
    const commands: string[] = [];
    const intercept = (async (...args: Parameters<typeof runCommand>) => {
      const command = args[1];
      commands.push(command);
      if (command.includes(' apply --index ')) {
        return { output: 'injected apply failure', code: 1, timedOut: false, aborted: false, truncated: false };
      }
      return runCommand(...args);
    }) as typeof runCommand;
    const checked = new ShadowGit({
      shellPath: shell,
      cwd: dir,
      gitDir: join(dir, 'data', 'checked-shadow'),
      run: intercept,
    });
    await writeFile(join(dir, 'a.txt'), 'target');
    const target = await checked.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'a.txt'), 'preflight');
    const prepared = await checked.prepareCheckedRestore(target.sha, 'preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const applied = await checked.applyCheckedRestore(prepared.preview);
    expect(applied).toMatchObject({ ok: false, kind: 'apply-failed' });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('preflight');
    expect(commands.join('\n')).not.toContain('reset --hard');
    expect(commands.every((command) => command.includes('-c core.hooksPath=/dev/null -c core.fsmonitor=false'))).toBe(true);
    expect(commands.filter((command) => command.includes(' diff ')).every((command) => (
      command.includes('--no-ext-diff') && command.includes('--no-textconv')
    ))).toBe(true);
  }, 20_000);

  it('snapshots changes, logs them, and restores a prior snapshot', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1');
    const first = await shadow.snapshot('first change');
    expect(first.ok).toBe(true);
    const firstSha = first.ok ? first.sha : '';
    expect(firstSha).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(dir, 'a.txt'), 'v2');
    const second = await shadow.snapshot('second change');
    expect(second.ok).toBe(true);

    const log = await shadow.log();
    expect(log).toHaveLength(2);
    expect(log[0]).toContain('second change'); // most recent first
    expect(log[1]).toContain('first change');

    const restored = await shadow.restore(firstSha);
    expect(restored.ok).toBe(true);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('v1'); // working tree reverted
  }, 20_000);

  it('snapshots an empty change too (--allow-empty), so every round gets a marker', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');
    expect((await shadow.snapshot('round 1')).ok).toBe(true);
    expect((await shadow.snapshot('round 2 no change')).ok).toBe(true); // nothing changed → still a commit
    expect(await shadow.log()).toHaveLength(2);
  });

  it('excludes node_modules / data / .git from snapshots', async () => {
    await writeFile(join(dir, 'tracked.txt'), 'yes');
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'big.txt'), 'huge');
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'secret.txt'), 'nope');
    await shadow.snapshot('only tracked');

    // Read the tracked set directly from the shadow gitdir.
    const gitDir = join(dir, 'data', 'shadow').replace(/\\/g, '/');
    const ls: ExecResult = await runCommand(shell, `git --git-dir='${gitDir}' ls-files`, dir, 30_000, 100_000);
    const files = ls.output.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(files).toContain('tracked.txt');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(files.some((f) => f.startsWith('data/'))).toBe(false);
  });

  it('refuses a data-directory junction before git can write through it', async () => {
    const outside = join(dir, 'outside-target');
    await mkdir(outside);
    await symlink(outside, join(dir, 'data'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await shadow.snapshot('must not escape');

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/symbolic link|reparse/u);
    await expect(readFile(join(outside, 'shadow', 'HEAD'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a hard-linked shadow config before git can mutate its peer', async () => {
    const gitDir = join(dir, 'data', 'shadow');
    const outside = join(dir, 'outside-config');
    await mkdir(gitDir, { recursive: true });
    await writeFile(outside, '[core]\n\tbare = false\n', 'utf8');
    await link(outside, join(gitDir, 'config'));

    const result = await shadow.snapshot('must not cross hardlink');

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/hard link/u);
    expect(await readFile(outside, 'utf8')).toBe('[core]\n\tbare = false\n');
  });

  it('replaces untrusted local filter configuration before a later snapshot', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1');
    expect((await shadow.snapshot('initial')).ok).toBe(true);
    const configPath = join(dir, 'data', 'shadow', 'config');
    await writeFile(configPath, '[core]\n\tbare = false\n[filter "evil"]\n\tclean = echo unsafe\n', 'utf8');

    expect((await shadow.snapshot('sanitized')).ok).toBe(true);
    expect(await readFile(configPath, 'utf8')).not.toContain('[filter "evil"]');
  });

  it('refuses to snapshot a regular file with an external hard-link peer', async () => {
    const outside = join(dir, 'outside-secret');
    await writeFile(outside, 'secret bytes', 'utf8');
    await link(outside, join(dir, 'innocent.txt'));

    const result = await shadow.snapshot('hardlink must not be copied');

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/hard link/u);
  });

  it('NEVER snapshots secret files (mirrors the harness secret policy, not the project .gitignore)', async () => {
    // No project .gitignore here, so this proves the shadow's OWN info/exclude is the secret boundary.
    await writeFile(join(dir, 'app.ts'), 'export const x = 1;'); // a normal tracked file
    for (const secret of ['.env', '.env.local', '.npmrc', '.netrc', '.git-credentials', 'credentials.json', 'credential.json', 'server.key', 'cert.pem', 'auth.json', 'id_rsa']) {
      await writeFile(join(dir, secret), 'SECRET');
    }
    await mkdir(join(dir, '.ssh'), { recursive: true });
    await writeFile(join(dir, '.ssh', 'id_ed25519'), 'SECRET');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', '.env'), 'SECRET'); // a secret in a subdir must be excluded too

    await shadow.snapshot('secrets must not be tracked');

    const gitDir = join(dir, 'data', 'shadow').replace(/\\/g, '/');
    const ls: ExecResult = await runCommand(shell, `git --git-dir='${gitDir}' ls-files`, dir, 30_000, 100_000);
    const files = ls.output.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(files).toContain('app.ts'); // the normal file IS snapshotted
    for (const secret of ['.env', '.env.local', '.npmrc', '.netrc', '.git-credentials', 'credentials.json', 'credential.json', 'server.key', 'cert.pem', 'auth.json', 'id_rsa', '.ssh/id_ed25519', 'sub/.env']) {
      expect(files).not.toContain(secret); // every secret shape stays OUT of the shadow history
    }
  });

  it('handles a label with quotes/newlines without breaking the commit', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');
    const r = await shadow.snapshot("weird 'label'\nwith newline");
    expect(r.ok).toBe(true);
    expect((await shadow.log())[0]).toContain("weird 'label'");
  });

  it('snapshotAsync resolves capture before the commit finishes', async () => {
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commands: string[] = [];
    const fakeRun = (async (_shellPath, command) => {
      commands.push(command);
      if (command.includes(' commit ')) await commitGate;
      return {
        output: command.includes('rev-parse') ? '0123456789abcdef0123456789abcdef01234567\n' : '',
        code: 0,
        timedOut: false,
        aborted: false,
        truncated: false,
      } satisfies ExecResult;
    }) as typeof runCommand;
    const sg = new ShadowGit({ shellPath: shell, cwd: dir, gitDir: join(dir, 'data', 'shadow'), run: fakeRun });

    const handle = sg.snapshotAsync('async round');
    let doneSettled = false;
    handle.done.then(() => {
      doneSettled = true;
    });

    expect(await handle.captured).toEqual({ ok: true });
    await Promise.resolve();
    expect(commands.some((c) => c.includes('add -A'))).toBe(true);
    expect(doneSettled).toBe(false);

    releaseCommit();
    expect(await handle.done).toEqual({ ok: true, sha: '0123456789abcdef0123456789abcdef01234567' });
  });
});

describe('ShadowGit — project-ignored capture (shadow boundary is the harness policy, not the project .gitignore)', () => {
  it('captures, drift-checks, and restores a project-ignored file', async () => {
    await writeFile(join(dir, '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(dir, 'app.log'), 'v1', 'utf8');
    const target = await shadow.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'app.log'), 'v2', 'utf8');

    const prepared = await shadow.prepareCheckedRestore(target.sha, 'preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.preview.changedPaths).toContain('app.log');

    const applied = await shadow.applyCheckedRestore(prepared.preview);
    expect(applied).toMatchObject({ ok: true });
    expect(await readFile(join(dir, 'app.log'), 'utf8')).toBe('v1');
  }, 20_000);

  it('captures nested ordinary files inside a project-ignored directory', async () => {
    await writeFile(join(dir, '.gitignore'), 'logs/\n', 'utf8');
    await mkdir(join(dir, 'logs', 'nested'), { recursive: true });
    await writeFile(join(dir, 'logs', 'a.txt'), 'v1', 'utf8');
    await writeFile(join(dir, 'logs', 'nested', 'b.txt'), 'v1', 'utf8');
    const target = await shadow.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'logs', 'a.txt'), 'v2', 'utf8');
    await writeFile(join(dir, 'logs', 'nested', 'b.txt'), 'v2', 'utf8');
    await writeFile(join(dir, 'logs', 'new.txt'), 'later', 'utf8');

    const prepared = await shadow.prepareCheckedRestore(target.sha, 'preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.preview.changedPaths).toEqual(expect.arrayContaining([
      'logs/a.txt',
      'logs/nested/b.txt',
      'logs/new.txt',
    ]));

    const applied = await shadow.applyCheckedRestore(prepared.preview);
    expect(applied).toMatchObject({ ok: true });
    expect(await readFile(join(dir, 'logs', 'a.txt'), 'utf8')).toBe('v1');
    expect(await readFile(join(dir, 'logs', 'nested', 'b.txt'), 'utf8')).toBe('v1');
    await expect(readFile(join(dir, 'logs', 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('rejects drift on a captured project-ignored path between preview and apply', async () => {
    await writeFile(join(dir, '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(dir, 'app.log'), 'v1', 'utf8');
    const target = await shadow.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'app.log'), 'v2', 'utf8');
    const prepared = await shadow.prepareCheckedRestore(target.sha, 'preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await writeFile(join(dir, 'app.log'), 'concurrent', 'utf8');

    const applied = await shadow.applyCheckedRestore(prepared.preview);
    expect(applied).toMatchObject({ ok: false, kind: 'drift' });
    expect(await readFile(join(dir, 'app.log'), 'utf8')).toBe('concurrent');
  }, 20_000);

  it('refuses to delete a project-ignored file for a target that predates forced capture, and allows rewind after manual removal', async () => {
    await writeFile(join(dir, '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(dir, 'tracked.txt'), 'base', 'utf8');
    // A legacy target commit without the capture marker: its tree cannot prove
    // whether an ignored file existed on disk when it was recorded.
    await shadow.init();
    const legacyShadowDir = join(dir, 'data', 'shadow');
    await runCommand(shell, `git -c core.hooksPath=/dev/null --git-dir='${legacyShadowDir.replace(/\\/g, '/')}' --work-tree='${dir.replace(/\\/g, '/')}' add -A`, dir, 30_000, 100_000);
    const legacyCommit = await runCommand(shell, `git -c core.hooksPath=/dev/null -c user.email=legacy@jarvis.local -c user.name=Legacy --git-dir='${legacyShadowDir.replace(/\\/g, '/')}' --work-tree='${dir.replace(/\\/g, '/')}' commit -q --allow-empty -m legacy-target`, dir, 30_000, 100_000);
    expect(legacyCommit.code).toBe(0);
    const legacyRef = (await runCommand(shell, `git --git-dir='${legacyShadowDir.replace(/\\/g, '/')}' rev-parse HEAD`, dir, 30_000, 100_000)).output.trim();
    expect(legacyRef).toMatch(/^[0-9a-f]{40}$/u);
    await writeFile(join(dir, 'app.log'), 'predates forced capture semantics', 'utf8');

    const prepared = await shadow.prepareCheckedRestore(legacyRef, 'preflight');
    expect(prepared).toMatchObject({ ok: false, kind: 'unsafe-path' });
    expect(await readFile(join(dir, 'app.log'), 'utf8')).toBe('predates forced capture semantics');

    await rm(join(dir, 'app.log'));
    const retry = await shadow.prepareCheckedRestore(legacyRef, 'preflight after manual removal');
    expect(retry.ok).toBe(true);
  }, 20_000);

  it('fail-closes when project ignore negation exposes a secret-bearing path to the snapshot', async () => {
    await writeFile(join(dir, '.gitignore'), '*.key\n!server.key\n', 'utf8');
    await writeFile(join(dir, 'app.ts'), 'export const x = 1;', 'utf8');
    await writeFile(join(dir, 'server.key'), 'SECRET', 'utf8');

    const result = await shadow.snapshot('negation must not capture');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/credential|protected|secret/u);

    const gitDir = join(dir, 'data', 'shadow').replace(/\\/g, '/');
    const ls: ExecResult = await runCommand(shell, `git --git-dir='${gitDir}' ls-files`, dir, 30_000, 100_000);
    const files = ls.output.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(files).not.toContain('server.key');
  }, 20_000);

  it('rejects a project-ignored file created between preview and apply without touching files', async () => {
    await writeFile(join(dir, '.gitignore'), 'logs/\n', 'utf8');
    await mkdir(join(dir, 'logs'), { recursive: true });
    await writeFile(join(dir, 'logs', 'a.txt'), 'v1', 'utf8');
    const target = await shadow.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'logs', 'a.txt'), 'v2', 'utf8');
    const prepared = await shadow.prepareCheckedRestore(target.sha, 'preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await writeFile(join(dir, 'logs', 'sneaked.txt'), 'appeared after preview', 'utf8');

    const applied = await shadow.applyCheckedRestore(prepared.preview);
    expect(applied).toMatchObject({ ok: false, kind: 'drift' });
    if (!applied.ok) expect(applied.reason).toMatch(/appeared after restore preview/u);
    expect(await readFile(join(dir, 'logs', 'a.txt'), 'utf8')).toBe('v2');
    expect(await readFile(join(dir, 'logs', 'sneaked.txt'), 'utf8')).toBe('appeared after preview');
  }, 20_000);

  it('does not let a subject line that merely contains the marker forge capture provenance', async () => {
    await writeFile(join(dir, '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(dir, 'tracked.txt'), 'base', 'utf8');
    // A hostile/legacy commit whose SUBJECT is the marker string but whose body
    // carries no real trailer: it must not count as force-capture-capable.
    await shadow.init();
    const gitDirPath = join(dir, 'data', 'shadow').replace(/\\/g, '/');
    await runCommand(shell, `git -c core.hooksPath=/dev/null --git-dir='${gitDirPath}' --work-tree='${dir.replace(/\\/g, '/')}' add -A`, dir, 30_000, 100_000);
    const forged = await runCommand(shell, `git -c core.hooksPath=/dev/null -c user.email=forge@jarvis.local -c user.name=Forge --git-dir='${gitDirPath}' --work-tree='${dir.replace(/\\/g, '/')}' commit -q --allow-empty -m 'shadow-capture: project-ignored-v1'`, dir, 30_000, 100_000);
    expect(forged.code).toBe(0);
    const forgedRef = (await runCommand(shell, `git --git-dir='${gitDirPath}' rev-parse HEAD`, dir, 30_000, 100_000)).output.trim();
    await writeFile(join(dir, 'app.log'), 'predates forced capture', 'utf8');

    const prepared = await shadow.prepareCheckedRestore(forgedRef, 'preflight');
    expect(prepared).toMatchObject({ ok: false, kind: 'unsafe-path' });
    expect(await readFile(join(dir, 'app.log'), 'utf8')).toBe('predates forced capture');
  }, 20_000);

  it('force-captures large ignored sets in byte-bounded batches', async () => {
    await writeFile(join(dir, '.gitignore'), 'logs/\n', 'utf8');
    await mkdir(join(dir, 'logs'), { recursive: true });
    for (let index = 0; index < 400; index += 1) {
      await writeFile(join(dir, 'logs', `f${index.toString().padStart(3, '0')}.txt`), `v${index}`, 'utf8');
    }
    const result = await shadow.snapshot('batched');
    expect(result.ok).toBe(true);
    const gitDirPath = join(dir, 'data', 'shadow').replace(/\\/g, '/');
    const ls: ExecResult = await runCommand(shell, `git --git-dir='${gitDirPath}' ls-files`, dir, 30_000, 100_000);
    const files = ls.output.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(files.filter((f) => f.startsWith('logs/'))).toHaveLength(400);
    expect(files).toContain('.gitignore');
  }, 20_000);

  it('leaves no ignore-classification probe file in the shadow gitdir after restores', async () => {
    await writeFile(join(dir, '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(dir, 'app.log'), 'v1', 'utf8');
    await writeFile(join(dir, 'tracked.txt'), 'x', 'utf8');
    const target = await shadow.snapshot('target');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await writeFile(join(dir, 'app.log'), 'v2', 'utf8');
    const prepared = await shadow.prepareCheckedRestore(target.sha, 'preflight');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect((await shadow.applyCheckedRestore(prepared.preview)).ok).toBe(true);

    const leftovers = (await readdir(join(dir, 'data', 'shadow'))).filter((name) => name.startsWith('ignore-probe-'));
    expect(leftovers).toEqual([]);
  }, 20_000);
});

describe('ShadowGit — checked restore path boundary', () => {
  it.each([
    '.env',
    'sub/.env.local',
    '.git/config',
    'data/sessions/x.jsonl',
    'node_modules/pkg/index.js',
    'dist/index.js',
    '../escape.txt',
    '/absolute.txt',
    'C:/absolute.txt',
  ])('rejects protected or escaping path %j', (path) => {
    expect(validateShadowRestorePath(path)).toMatchObject({ ok: false });
  });

  it('accepts a normal path with spaces', () => {
    expect(validateShadowRestorePath('folder with spaces/a b.txt')).toEqual({ ok: true });
  });
});

describe('ShadowGit — best-effort (never throws, observability must not break the run)', () => {
  it('returns a skip reason when a git command fails (injected failing runner)', async () => {
    const failing = (async () => ({ output: 'fatal: not a git thing', code: 1, timedOut: false, aborted: false, truncated: false }) as ExecResult) as typeof runCommand;
    const sg = new ShadowGit({ shellPath: shell, cwd: dir, gitDir: join(dir, 'data', 'shadow'), run: failing });
    const r = await sg.snapshot('x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/git init failed/);
  });

  it('log returns [] on failure rather than throwing', async () => {
    const failing = (async () => ({ output: '', code: 128, timedOut: false, aborted: false, truncated: false }) as ExecResult) as typeof runCommand;
    const sg = new ShadowGit({ shellPath: shell, cwd: dir, gitDir: join(dir, 'data', 'shadow'), run: failing });
    expect(await sg.log()).toEqual([]);
  });
});
