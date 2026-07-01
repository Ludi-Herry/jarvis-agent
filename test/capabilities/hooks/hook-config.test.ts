import { describe, expect, it } from 'vitest';
import { join, resolve, toNamespacedPath } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { loadHookConfig, loadHookConfigs, parseHookConfig, type RealPath } from '../../../src/capabilities/hooks/hook-config.js';
import type { ReadText } from '../../../src/capabilities/rules/index.js';

describe('parseHookConfig', () => {
  it('parses both events and defaults an omitted matcher to "*"', () => {
    const cfg = parseHookConfig(
      JSON.stringify({
        PreToolUse: [{ matcher: 'bash', command: 'guard.sh', timeoutMs: 1234 }, { command: 'always.sh' }],
        PostToolUse: [{ matcher: 'write', command: 'fmt.sh' }],
        RoundStart: [{ command: 'round-start.sh' }],
        SessionEnd: [{ command: 'session-end.sh' }],
      }),
    );
    expect(cfg.PreToolUse).toEqual([
      { matcher: 'bash', command: 'guard.sh', timeoutMs: 1234 },
      { matcher: '*', command: 'always.sh' }, // omitted matcher → matches every tool
    ]);
    expect(cfg.PostToolUse).toEqual([{ matcher: 'write', command: 'fmt.sh' }]);
    expect(cfg.RoundStart).toEqual([{ matcher: '*', command: 'round-start.sh' }]);
    expect(cfg.RoundEnd).toEqual([]);
    expect(cfg.SessionStart).toEqual([]);
    expect(cfg.SessionEnd).toEqual([{ matcher: '*', command: 'session-end.sh' }]);
  });

  it('treats a missing event as an empty list (not an error)', () => {
    expect(parseHookConfig('{}')).toEqual({ PreToolUse: [], PostToolUse: [], RoundStart: [], RoundEnd: [], SessionStart: [], SessionEnd: [] });
  });

  it.each([
    ['not JSON at all', 'not json{'],
    ['a top-level array', '[]'],
    ['a non-array event', JSON.stringify({ PreToolUse: { command: 'x' } })],
    ['an entry missing command', JSON.stringify({ PreToolUse: [{ matcher: 'bash' }] })],
    ['an empty command', JSON.stringify({ PreToolUse: [{ command: '   ' }] })],
    ['a non-string matcher', JSON.stringify({ PostToolUse: [{ matcher: 1, command: 'x' }] })],
    ['an unknown top-level key (typo)', JSON.stringify({ PreToolUes: [{ command: 'x' }] })],
    ['an unknown entry key (typo)', JSON.stringify({ PreToolUse: [{ command: 'x', timeoutMS: 1000 }] })],
    ['a present-but-empty matcher', JSON.stringify({ PreToolUse: [{ matcher: '', command: 'x' }] })],
    ['a non-number timeout', JSON.stringify({ PreToolUse: [{ command: 'x', timeoutMs: '1000' }] })],
    ['a zero timeout', JSON.stringify({ PreToolUse: [{ command: 'x', timeoutMs: 0 }] })],
    ['a fractional timeout', JSON.stringify({ PreToolUse: [{ command: 'x', timeoutMs: 1000.5 }] })],
    ['an over-limit timeout', JSON.stringify({ PreToolUse: [{ command: 'x', timeoutMs: 300001 }] })],
  ])('throws a descriptive error for %s', (_label, text) => {
    expect(() => parseHookConfig(text)).toThrow();
  });
});

describe('loadHookConfigs — multiple trusted sources', () => {
  const cwd = join(tmpdir(), 'jarvis-hooks-repo');
  const home = join(tmpdir(), 'home-hooks.json');
  const env = join(tmpdir(), 'env-hooks.json');
  const inside = join(cwd, '.hooks.json');

  it('merges PreToolUse/PostToolUse arrays in source order', async () => {
    const files = new Map([
      [home, JSON.stringify({ PreToolUse: [{ matcher: 'bash', command: 'home-pre' }], PostToolUse: [{ command: 'home-post' }] })],
      [env, JSON.stringify({ PreToolUse: [{ matcher: 'write', command: 'env-pre' }], RoundStart: [{ command: 'env-round' }] })],
    ]);
    const res = await loadHookConfigs({
      sources: [{ label: 'home', path: home }, { label: 'env', path: env }],
      cwd,
      readText: async (p) => files.get(p) ?? null,
      realpath: async (p) => resolve(p),
    });
    expect(res.warning).toBeUndefined();
    expect(res.config.PreToolUse.map((h) => h.command)).toEqual(['home-pre', 'env-pre']);
    expect(res.config.PostToolUse.map((h) => h.command)).toEqual(['home-post']);
    expect(res.config.RoundStart.map((h) => h.command)).toEqual(['env-round']);
  });

  it('skips a missing source without warning', async () => {
    const res = await loadHookConfigs({
      sources: [{ label: 'missing', path: env }],
      cwd,
      readText: async () => null,
      realpath: async () => null,
    });
    expect(res.warning).toBeUndefined();
    expect(res.config).toEqual({ PreToolUse: [], PostToolUse: [], RoundStart: [], RoundEnd: [], SessionStart: [], SessionEnd: [] });
  });

  it('warns and disables only the malformed source while keeping the other source active', async () => {
    const files = new Map([
      [home, JSON.stringify({ PreToolUse: [{ command: 'home-ok' }] })],
      [env, 'not json{'],
    ]);
    const res = await loadHookConfigs({
      sources: [{ label: 'home', path: home }, { label: 'env', path: env }],
      cwd,
      readText: async (p) => files.get(p) ?? null,
      realpath: async (p) => resolve(p),
    });
    expect(res.warning).toMatch(/env/);
    expect(res.config.PreToolUse.map((h) => h.command)).toEqual(['home-ok']);
  });

  it('refuses every source that realpaths inside cwd, while keeping outside sources active', async () => {
    const files = new Map([
      [home, JSON.stringify({ PreToolUse: [{ command: 'home-ok' }] })],
      [inside, JSON.stringify({ PreToolUse: [{ command: 'inside-bad' }] })],
    ]);
    const res = await loadHookConfigs({
      sources: [{ label: 'home', path: home }, { label: 'inside', path: inside }],
      cwd,
      readText: async (p) => files.get(p) ?? null,
      realpath: async (p) => resolve(p),
    });
    expect(res.warning).toMatch(/inside/);
    expect(res.warning).toMatch(/工作目录内|拒绝/);
    expect(res.config.PreToolUse.map((h) => h.command)).toEqual(['home-ok']);
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

  it('REFUSES a real outside symlink that points to an in-cwd hook config', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'jarvis-hooks-repo-real-'));
    const outside = await mkdtemp(join(tmpdir(), 'jarvis-hooks-outside-real-'));
    const insideConfig = join(repo, '.hooks.json');
    const outsideLink = join(outside, 'trusted-looking-hooks.json');
    await writeFile(insideConfig, okConfig, 'utf8');
    try {
      await symlink(insideConfig, outsideLink, 'file');
    } catch {
      return; // Windows without symlink privilege: synthetic realpath test above still covers the guard.
    }
    const res = await loadHookConfig({
      path: outsideLink,
      cwd: repo,
      readText: async (p) => readFile(p, 'utf8').catch(() => null),
      realpath: async (p) => realpath(p).catch(() => null),
    });
    expect(res.config).toBeUndefined();
    expect(res.warning).toMatch(/工作目录内|拒绝/);
  });

  it('REFUSES a real Windows outside junction that points into cwd', async () => {
    if (process.platform !== 'win32') return;
    const repo = await mkdtemp(join(tmpdir(), 'jarvis-hooks-repo-real-'));
    const outside = await mkdtemp(join(tmpdir(), 'jarvis-hooks-outside-real-'));
    const insideConfig = join(repo, '.hooks.json');
    const outsideLinkDir = join(outside, 'trusted-looking-repo');
    await writeFile(insideConfig, okConfig, 'utf8');
    await symlink(repo, outsideLinkDir, 'junction');
    const res = await loadHookConfig({
      path: join(outsideLinkDir, '.hooks.json'),
      cwd: repo,
      readText: async (p) => readFile(p, 'utf8').catch(() => null),
      realpath: async (p) => realpath(p).catch(() => null),
    });
    expect(res.config).toBeUndefined();
    expect(res.warning).toMatch(/工作目录内|拒绝/);
  });

  it('REFUSES a real Windows \\\\?\\ path that points to an in-cwd hook config', async () => {
    if (process.platform !== 'win32') return;
    const repo = await mkdtemp(join(tmpdir(), 'jarvis-hooks-repo-real-'));
    const insideConfig = join(repo, '.hooks.json');
    await writeFile(insideConfig, okConfig, 'utf8');
    const namespaced = toNamespacedPath(insideConfig);
    const res = await loadHookConfig({
      path: namespaced,
      cwd: repo,
      readText: async (p) => readFile(p, 'utf8').catch(() => null),
      realpath: async (p) => realpath(p).catch(() => null),
    });
    expect(res.config).toBeUndefined();
    expect(res.warning).toMatch(/工作目录内|拒绝/);
  });
});
