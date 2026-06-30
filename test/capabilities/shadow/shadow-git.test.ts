import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowGit } from '../../../src/capabilities/shadow/shadow-git.js';
import { defaultShellPath, runCommand, type ExecResult } from '../../../src/core/tools/run-command.js';

const shell = defaultShellPath();

let dir: string;
let shadow: ShadowGit;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-shadow-'));
  shadow = new ShadowGit({ shellPath: shell, cwd: dir, gitDir: join(dir, 'data', 'shadow') });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ShadowGit — real git round-trip', () => {
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
  });

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
