import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
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
