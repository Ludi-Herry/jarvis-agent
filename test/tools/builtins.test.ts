import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool, writeTool, grepTool } from '../../src/core/tools/builtins.js';
import type { ToolRunCtx } from '../../src/core/tools/types.js';

let dir: string;
let ctx: ToolRunCtx;

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
  });

  it('returns a clean error (not a throw) for a missing file', async () => {
    const out = await readTool.run({ path: 'nope.txt' }, ctx);
    expect(out.content).toBe('');
    expect(out.error).toMatch(/Cannot read nope\.txt/);
  });
});

describe('writeTool', () => {
  it('writes a file and creates missing parent directories', async () => {
    const out = await writeTool.run({ path: 'sub/deep/out.txt', content: 'data' }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.content).toMatch(/Wrote 4 chars/);
    const written = await readFile(join(dir, 'sub/deep/out.txt'), 'utf8');
    expect(written).toBe('data');
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
    const out = await writeTool.run({ path: 'safe_dir/id_test', content: 'PWNED' }, ctx);
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
