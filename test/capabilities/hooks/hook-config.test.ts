import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHookConfig, parseHookConfig, type RealPath } from '../../../src/capabilities/hooks/hook-config.js';
import type { ReadText } from '../../../src/capabilities/rules/index.js';

describe('parseHookConfig', () => {
  it('parses both events and defaults an omitted matcher to "*"', () => {
    const cfg = parseHookConfig(
      JSON.stringify({
        PreToolUse: [{ matcher: 'bash', command: 'guard.sh' }, { command: 'always.sh' }],
        PostToolUse: [{ matcher: 'write', command: 'fmt.sh' }],
      }),
    );
    expect(cfg.PreToolUse).toEqual([
      { matcher: 'bash', command: 'guard.sh' },
      { matcher: '*', command: 'always.sh' }, // omitted matcher → matches every tool
    ]);
    expect(cfg.PostToolUse).toEqual([{ matcher: 'write', command: 'fmt.sh' }]);
  });

  it('treats a missing event as an empty list (not an error)', () => {
    expect(parseHookConfig('{}')).toEqual({ PreToolUse: [], PostToolUse: [] });
  });

  it.each([
    ['not JSON at all', 'not json{'],
    ['a top-level array', '[]'],
    ['a non-array event', JSON.stringify({ PreToolUse: { command: 'x' } })],
    ['an entry missing command', JSON.stringify({ PreToolUse: [{ matcher: 'bash' }] })],
    ['an empty command', JSON.stringify({ PreToolUse: [{ command: '   ' }] })],
    ['a non-string matcher', JSON.stringify({ PostToolUse: [{ matcher: 1, command: 'x' }] })],
    ['an unknown top-level key (typo)', JSON.stringify({ PreToolUes: [{ command: 'x' }] })],
    ['a present-but-empty matcher', JSON.stringify({ PreToolUse: [{ matcher: '', command: 'x' }] })],
  ])('throws a descriptive error for %s', (_label, text) => {
    expect(() => parseHookConfig(text)).toThrow();
  });
});

describe('loadHookConfig — trust boundary', () => {
  const cwd = join(tmpdir(), 'jarvis-hooks-repo');
  const fixed = (text: string | null): ReadText => async () => text;
  const okConfig = JSON.stringify({ PreToolUse: [{ matcher: 'bash', command: 'x' }] });

  it('is OFF when no path is configured (JARVIS_HOOKS unset)', async () => {
    const res = await loadHookConfig({ path: undefined, cwd, readText: fixed(okConfig) });
    expect(res).toEqual({}); // no config, no warning → simply off
  });

  it('REFUSES a config path inside cwd (in-repo hook = arbitrary code execution)', async () => {
    // Even with a perfectly valid config, an in-repo path must never be loaded.
    const res = await loadHookConfig({ path: join(cwd, '.hooks.json'), cwd, readText: fixed(okConfig) });
    expect(res.config).toBeUndefined();
    expect(res.warning).toMatch(/工作目录内|拒绝/);
  });

  it('loads a valid config from a TRUSTED path outside cwd', async () => {
    const outside = join(tmpdir(), 'trusted-hooks.json'); // sibling of the repo, not inside it
    const res = await loadHookConfig({ path: outside, cwd, readText: fixed(okConfig) });
    expect(res.warning).toBeUndefined();
    expect(res.config?.PreToolUse).toEqual([{ matcher: 'bash', command: 'x' }]);
  });

  it('warns + disables on an unreadable trusted path (rather than crashing)', async () => {
    const res = await loadHookConfig({ path: join(tmpdir(), 'missing.json'), cwd, readText: fixed(null) });
    expect(res.config).toBeUndefined();
    expect(res.warning).toMatch(/无法读取/);
  });

  it('warns + disables on a malformed trusted config (rather than crashing)', async () => {
    const res = await loadHookConfig({ path: join(tmpdir(), 'bad.json'), cwd, readText: fixed('not json{') });
    expect(res.config).toBeUndefined();
    expect(res.warning).toMatch(/解析失败/);
  });

  it('REFUSES after realpath when an outside-looking path canonicalizes INTO cwd (symlink / \\?\\ bypass)', async () => {
    // A path that LEXICALLY sits outside cwd but whose real target is an in-repo file — the codex
    // 2026-06-30 bypass (Windows \\?\ extended path, or an external symlink → in-repo file).
    const outsideLooking = join(tmpdir(), 'trusted-hooks.json');
    const realInside = join(cwd, '.hooks.json');
    const realpath: RealPath = async (p) => (p === outsideLooking ? realInside : resolve(p));
    const res = await loadHookConfig({ path: outsideLooking, cwd, readText: fixed(okConfig), realpath });
    expect(res.config).toBeUndefined(); // canonicalization caught it
    expect(res.warning).toMatch(/工作目录内|拒绝/);
  });

  it('loads when realpath keeps the canonical path outside cwd', async () => {
    const outside = join(tmpdir(), 'trusted-hooks.json');
    const realpath: RealPath = async (p) => resolve(p);
    const res = await loadHookConfig({ path: outside, cwd, readText: fixed(okConfig), realpath });
    expect(res.config?.PreToolUse).toEqual([{ matcher: 'bash', command: 'x' }]);
  });

  it('warns when realpath cannot resolve the config path (missing/unreadable)', async () => {
    const realpath: RealPath = async () => null;
    const res = await loadHookConfig({ path: join(tmpdir(), 'missing.json'), cwd, readText: fixed(okConfig), realpath });
    expect(res.config).toBeUndefined();
    expect(res.warning).toMatch(/无法读取/);
  });
});
