import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link, mkdtemp, rm, readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool, writeTool, editTool, grepTool } from '../../src/core/tools/builtins.js';
import type { ToolRunCtx } from '../../src/core/tools/types.js';

let dir: string;
let ctx: ToolRunCtx;
const fileSymlinkIt = process.platform === 'win32' ? it.skip : it;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-tools-'));
  ctx = { cwd: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readTool', () => {
  it('reads a file relative to cwd', async () => {
    await writeFile(join(dir, 'note.txt'), 'hello world', 'utf8');
    const out = await readTool.run({ path: 'note.txt' }, ctx);
    expect(out.content).toBe('hello world');
    expect(out.error).toBeUndefined();
    expect(out.fileReceipt).toMatchObject({ kind: 'read', path: 'note.txt' });
    expect(out.fileReceipt?.kind === 'read' ? out.fileReceipt.version : '').toMatch(/^fv1\./);
  });

  it('returns a clean error (not a throw) for a missing file', async () => {
    const out = await readTool.run({ path: 'nope.txt' }, ctx);
    expect(out.content).toBe('');
    expect(out.error).toMatch(/Cannot read nope\.txt/);
  });

  it('refuses a singular credential file (credential.json), not just the plural form', async () => {
    // codex HIGH-2: the secret policy matched `credentials` but not the singular `credential.json`,
    // so an ungated read (e.g. the leg-3 verifier) could slurp it. The regex now covers credential(s).
    await writeFile(join(dir, 'credential.json'), 'TOKEN-DO-NOT-LEAK', 'utf8');
    const out = await readTool.run({ path: 'credential.json' }, ctx);
    expect(out.content).toBe('');
    expect(out.error).toMatch(/sensitive/);
    expect(out.error).not.toContain('DO-NOT-LEAK');
  });
});

describe('writeTool', () => {
  it('writes a file and creates missing parent directories', async () => {
    const out = await writeTool.run({ path: 'sub/deep/out.txt', content: 'data', createOnly: true }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.content).toMatch(/Created sub\/deep\/out\.txt \(4 chars\)/);
    expect(out.fileReceipt).toMatchObject({ kind: 'write', outcome: 'applied', precondition: 'createOnly' });
    const written = await readFile(join(dir, 'sub/deep/out.txt'), 'utf8');
    expect(written).toBe('data');
  });

  it('requires a version for replacement and returns the new postVersion', async () => {
    await writeFile(join(dir, 'note.txt'), 'before', 'utf8');
    const read = await readTool.run({ path: 'note.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';

    const out = await writeTool.run({ path: 'note.txt', content: 'after', expectedVersion }, ctx);

    expect(out.error).toBeUndefined();
    expect(out.fileReceipt).toMatchObject({
      kind: 'write',
      outcome: 'applied',
      precondition: 'expectedVersion',
      expectedVersion,
    });
    expect(out.fileReceipt?.kind === 'write' ? out.fileReceipt.postVersion : '').toMatch(/^fv1\./);
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('after');
  });

  it('rejects a stale expectedVersion without changing the newer file', async () => {
    await writeFile(join(dir, 'note.txt'), 'baseline', 'utf8');
    const read = await readTool.run({ path: 'note.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';
    await writeFile(join(dir, 'note.txt'), 'external edit', 'utf8');

    const out = await writeTool.run({ path: 'note.txt', content: 'agent edit', expectedVersion }, ctx);

    expect(out.error).toMatch(/Write conflict/);
    expect(out.fileReceipt).toMatchObject({ kind: 'write', outcome: 'conflict' });
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('external edit');
  });

  it('rejects createOnly when the target already exists', async () => {
    await writeFile(join(dir, 'note.txt'), 'keep', 'utf8');

    const out = await writeTool.run({ path: 'note.txt', content: 'replace', createOnly: true }, ctx);

    expect(out.error).toMatch(/already exists/);
    expect(out.fileReceipt).toMatchObject({ kind: 'write', outcome: 'conflict' });
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('keep');
  });

  it('rejects a direct unversioned write without touching the path', async () => {
    const out = await writeTool.run({ path: 'note.txt', content: 'unsafe' }, ctx);

    expect(out.error).toMatch(/exactly one precondition/);
    await expect(readFile(join(dir, 'note.txt'), 'utf8')).rejects.toThrow();
  });

  it('serializes same-process updates so one stale contender loses', async () => {
    await writeFile(join(dir, 'note.txt'), 'baseline', 'utf8');
    const read = await readTool.run({ path: 'note.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';

    const [first, second] = await Promise.all([
      writeTool.run({ path: 'note.txt', content: 'first', expectedVersion }, ctx),
      writeTool.run({ path: 'note.txt', content: 'second', expectedVersion }, ctx),
    ]);

    expect([first, second].filter((out) => out.fileReceipt?.kind === 'write' && out.fileReceipt.outcome === 'applied')).toHaveLength(1);
    expect([first, second].filter((out) => out.fileReceipt?.kind === 'write' && out.fileReceipt.outcome === 'conflict')).toHaveLength(1);
  });

  fileSymlinkIt('refuses to replace a symbolic-link leaf with a regular file', async () => {
    await writeFile(join(dir, 'target.txt'), 'baseline', 'utf8');
    await symlink(join(dir, 'target.txt'), join(dir, 'link.txt'), 'file');
    const read = await readTool.run({ path: 'link.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';

    const out = await writeTool.run({ path: 'link.txt', content: 'agent edit', expectedVersion }, ctx);

    expect(out.error).toMatch(/symbolic link/);
    expect(out.fileReceipt).toMatchObject({ kind: 'write', outcome: 'conflict' });
    expect(await readFile(join(dir, 'target.txt'), 'utf8')).toBe('baseline');
  });

  it('refuses to replace a multiply-linked file', async () => {
    await writeFile(join(dir, 'target.txt'), 'baseline', 'utf8');
    await link(join(dir, 'target.txt'), join(dir, 'alias.txt'));
    const read = await readTool.run({ path: 'target.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';

    const out = await writeTool.run({ path: 'target.txt', content: 'agent edit', expectedVersion }, ctx);

    expect(out.error).toMatch(/multiple hard links/);
    expect(out.fileReceipt).toMatchObject({ kind: 'write', outcome: 'conflict' });
    expect(await readFile(join(dir, 'alias.txt'), 'utf8')).toBe('baseline');
  });

  it('refuses to mutate git metadata', async () => {
    await writeFile(join(dir, '.git'), 'gitdir: original', 'utf8');
    const out = await writeTool.run({ path: '.git', content: 'gitdir: pwned', expectedVersion: 'fv1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, ctx);

    expect(out.error).toMatch(/git metadata/);
    expect(await readFile(join(dir, '.git'), 'utf8')).toBe('gitdir: original');
  });

  it('refuses to mutate git metadata through a symlinked directory', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'config'), 'original', 'utf8');
    await symlink(join(dir, '.git'), join(dir, 'safe_dir'), 'junction');

    const out = await writeTool.run({ path: 'safe_dir/config', content: 'pwned', createOnly: true }, ctx);

    expect(out.error).toMatch(/git metadata/);
    expect(await readFile(join(dir, '.git', 'config'), 'utf8')).toBe('original');
  });
});

describe('editTool', () => {
  it('replaces one exact match in a large file without resending the full contents', async () => {
    const before = `${'prefix\r\n'.repeat(4_000)}TARGET\r\n${'suffix\r\n'.repeat(4_000)}`;
    await writeFile(join(dir, 'large.txt'), before, 'utf8');
    const read = await readTool.run({ path: 'large.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';

    const out = await editTool.run({
      path: 'large.txt',
      oldText: 'TARGET\r\n',
      newText: 'REPLACED\r\n',
      expectedVersion,
    }, ctx);

    expect(out.error).toBeUndefined();
    expect(out.content).toMatch(/Edited large\.txt/);
    expect(out.fileReceipt).toMatchObject({
      kind: 'write',
      outcome: 'applied',
      precondition: 'expectedVersion',
      expectedVersion,
    });
    expect(await readFile(join(dir, 'large.txt'), 'utf8')).toBe(before.replace('TARGET\r\n', 'REPLACED\r\n'));
  });

  it.each([
    ['no match', 'missing'],
    ['more than once', 'repeat'],
  ])('rejects when oldText occurs %s', async (_label, oldText) => {
    await writeFile(join(dir, 'note.txt'), 'repeat and repeat', 'utf8');
    const read = await readTool.run({ path: 'note.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';

    const out = await editTool.run({ path: 'note.txt', oldText, newText: 'changed', expectedVersion }, ctx);

    expect(out.error).toMatch(/exactly once/);
    expect(out.fileReceipt).toMatchObject({ kind: 'write', outcome: 'conflict' });
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('repeat and repeat');
  });

  it('rejects a stale expectedVersion without changing the newer file', async () => {
    await writeFile(join(dir, 'note.txt'), 'baseline target', 'utf8');
    const read = await readTool.run({ path: 'note.txt' }, ctx);
    const expectedVersion = read.fileReceipt?.kind === 'read' ? read.fileReceipt.version : '';
    await writeFile(join(dir, 'note.txt'), 'external target', 'utf8');

    const out = await editTool.run({
      path: 'note.txt',
      oldText: 'target',
      newText: 'changed',
      expectedVersion,
    }, ctx);

    expect(out.error).toMatch(/Write conflict/);
    expect(out.fileReceipt).toMatchObject({ kind: 'write', outcome: 'conflict' });
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('external target');
  });
});

describe('grepTool', () => {
  it('returns matches as path:line:text and skips non-matching lines', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\ngamma', 'utf8');
    const out = await grepTool.run({ pattern: 'beta' }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.content).toBe('a.txt:2:beta');
  });

  it('searches recursively and reports forward-slash relative paths', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'x.ts'), 'const needle = 1;', 'utf8');
    const out = await grepTool.run({ pattern: 'needle' }, ctx);
    expect(out.content).toBe('src/x.ts:1:const needle = 1;');
  });

  it('NEVER reads secrets during recursive traversal (codex P0: grep was a secret side-door)', async () => {
    // grep with no `path` recurses from root with read-only allow — it must skip secret files
    // itself, or it leaks .env / .ssh content with zero approval.
    await writeFile(join(dir, '.env'), 'API_KEY=SECRET-DO-NOT-LEAK', 'utf8');
    await mkdir(join(dir, '.ssh'), { recursive: true });
    await writeFile(join(dir, '.ssh', 'id_rsa'), 'PRIVATE-KEY-DO-NOT-LEAK', 'utf8');
    await writeFile(join(dir, 'note.txt'), 'API_KEY mentioned safely here', 'utf8');

    const out = await grepTool.run({ pattern: 'DO-NOT-LEAK|API_KEY' }, ctx);
    expect(out.content).not.toContain('DO-NOT-LEAK'); // no secret value leaked
    expect(out.content).not.toContain('.env');
    expect(out.content).not.toContain('id_rsa');
    expect(out.content).toContain('note.txt'); // normal files are still searched
  });

  it('reports no matches without erroring', async () => {
    await writeFile(join(dir, 'a.txt'), 'nothing here', 'utf8');
    const out = await grepTool.run({ pattern: 'absent' }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.content).toMatch(/No matches/);
  });

  it('returns an error for an invalid regular expression', async () => {
    const out = await grepTool.run({ pattern: '[' }, ctx);
    expect(out.content).toBe('');
    expect(out.error).toMatch(/Invalid regular expression/);
  });

  it('skips a file over the size cap (does not slurp a huge blob) and reports the skip', async () => {
    await writeFile(join(dir, 'small.txt'), 'find-me', 'utf8');
    await writeFile(join(dir, 'huge.txt'), `find-me\n${'x'.repeat(2_000_001)}`, 'utf8'); // > 2MB cap
    const out = await grepTool.run({ pattern: 'find-me' }, ctx);
    expect(out.content).toContain('small.txt'); // the small file is still searched and matched
    expect(out.content).not.toContain('huge.txt'); // the oversized file is skipped, not scanned
    expect(out.content).toContain('skipped'); // and the skip is reported, not silent
  });
});

describe('path confinement (codex P1: cwd escape + symlink can dodge the secret check)', () => {
  it('read: refuses an absolute path outside cwd (never reads a file elsewhere on disk)', async () => {
    // A real secret OUTSIDE the project root. Without confinement an absolute path reads it.
    const outside = await mkdtemp(join(tmpdir(), 'harness-outside-'));
    try {
      const secret = join(outside, 'loot.txt');
      await writeFile(secret, 'OUTSIDE-SECRET-DO-NOT-LEAK', 'utf8');
      const out = await readTool.run({ path: secret }, ctx);
      expect(out.content).toBe('');
      expect(out.error).toMatch(/escapes the project root/);
      expect(out.error).not.toContain('OUTSIDE-SECRET'); // and the value never surfaced
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('read: refuses a ../ traversal that climbs above cwd', async () => {
    const out = await readTool.run({ path: '../../../../etc/passwd' }, ctx);
    expect(out.content).toBe('');
    expect(out.error).toMatch(/escapes the project root/);
  });

  // A directory junction (Windows, no elevation needed) / symlink (POSIX) stands in for the
  // codex `safe.txt -> .env` case: realpath resolution is identical, but it needs no privilege.
  // The secret hides behind a NON-sensitive literal name, so only the realpath check can catch it
  // — a literal-only check (what the gate sees) would wave it through.
  it('read: refuses a symlinked dir that resolves to a secret (realpath defeats the bypass)', async () => {
    await mkdir(join(dir, '.ssh'), { recursive: true });
    await writeFile(join(dir, '.ssh', 'config'), 'SSH-SECRET-DO-NOT-LEAK', 'utf8');
    await symlink(join(dir, '.ssh'), join(dir, 'safe_dir'), 'junction');
    const out = await readTool.run({ path: 'safe_dir/config' }, ctx); // literal name looks innocent
    expect(out.content).toBe(''); // the secret behind the link is never read
    expect(out.error).toMatch(/sensitive/);
    expect(out.error).not.toContain('SSH-SECRET');
  });

  it('write: a symlinked dir cannot be used to write into a secret location', async () => {
    await mkdir(join(dir, '.ssh'), { recursive: true });
    await symlink(join(dir, '.ssh'), join(dir, 'safe_dir'), 'junction');
    const out = await writeTool.run({ path: 'safe_dir/id_test', content: 'PWNED', createOnly: true }, ctx);
    expect(out.error).toMatch(/sensitive/);
    await expect(readFile(join(dir, '.ssh', 'id_test'), 'utf8')).rejects.toThrow(); // nothing written
  });

  it('read: refuses a symlink whose target escapes cwd entirely', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-outside-'));
    try {
      await writeFile(join(outside, 'loot.txt'), 'OUTSIDE-SECRET-DO-NOT-LEAK', 'utf8');
      await symlink(outside, join(dir, 'safe_dir'), 'junction');
      const out = await readTool.run({ path: 'safe_dir/loot.txt' }, ctx);
      expect(out.content).toBe('');
      expect(out.error).toMatch(/resolves outside the project root/);
      expect(out.error).not.toContain('OUTSIDE-SECRET');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('grep: refuses a root that escapes cwd', async () => {
    const out = await grepTool.run({ pattern: 'x', path: '../..' }, ctx);
    expect(out.content).toBe('');
    expect(out.error).toMatch(/escapes the project root/);
  });
});

describe('grep abort (ToolRunCtx.signal — Ctrl-C on a long search)', () => {
  it('stops immediately and reports aborted when the signal is already aborted', async () => {
    await writeFile(join(dir, 'a.txt'), 'match-me', 'utf8');
    const ac = new AbortController();
    ac.abort();
    const out = await grepTool.run({ pattern: 'match-me' }, { cwd: dir, signal: ac.signal });
    expect(out.content).toContain('aborted'); // bailed instead of returning the match
  });

  it('stops a running search after the signal fires', async () => {
    // Enough files that the traversal/scan is interruptible; the pattern matches none.
    for (let i = 0; i < 80; i++) await writeFile(join(dir, `f${i}.txt`), 'nothing-of-interest', 'utf8');
    const ac = new AbortController();
    const p = grepTool.run({ pattern: 'WILL-NOT-MATCH' }, { cwd: dir, signal: ac.signal });
    ac.abort(); // fire while the run is in flight
    const out = await p;
    expect(out.content).toContain('aborted');
  });
});
