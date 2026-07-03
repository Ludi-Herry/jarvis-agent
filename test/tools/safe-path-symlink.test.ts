import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolve, sep } from 'node:path';

// A tiny virtual symlink topology behind the only two fs calls safe-path uses to follow links.
// node:path stays real (resolve/dirname behave normally), and isSensitivePath is pure, so this
// exercises effectiveRealPath's MULTI-HOP recursion precisely — which a real filesystem can't
// reproduce cross-platform (file symlinks need elevation on Windows; junctions can't dangle).
const topo = vi.hoisted(() => ({
  realDirs: new Set<string>(), // paths realpath() fully resolves
  links: new Map<string, string>(), // symlink path -> raw target
}));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: vi.fn(async (p: string) => {
      if (topo.realDirs.has(p)) return p;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }),
    readlink: vi.fn(async (p: string) => {
      const t = topo.links.get(p);
      if (t === undefined) throw Object.assign(new Error(`EINVAL: ${p}`), { code: 'EINVAL' });
      return t;
    }),
  };
});

import { safeResolve } from '../../src/core/tools/safe-path.js';

const ROOT = resolve(sep, 'proj');
const link1 = resolve(ROOT, 'link1');
const link2 = resolve(ROOT, 'link2');
const envp = resolve(ROOT, '.env');

beforeEach(() => {
  topo.realDirs.clear();
  topo.links.clear();
  topo.realDirs.add(ROOT); // the project root always resolves
});

describe('safeResolve — multi-hop symlink resolution (codex HIGH2: write punched through the check)', () => {
  it('blocks a dangling chain link1 -> link2 -> .env that a single readlink hop would wave through', async () => {
    topo.links.set(link1, link2);
    topo.links.set(link2, envp); // .env absent → realpath fails on the chain, forcing the fallback
    const res = await safeResolve(ROOT, 'link1');
    // Pre-fix, effectiveRealPath stopped at cwd/link2 (not sensitive) and ALLOWED the write.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/sensitive/);
  });

  it('fails closed (does not loop) on a symlink cycle link1 -> link2 -> link1', async () => {
    topo.links.set(link1, link2);
    topo.links.set(link2, link1);
    const res = await safeResolve(ROOT, 'link1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/could not be safely resolved/);
  });

  it('still allows a multi-hop chain that lands on a normal in-cwd file (no over-blocking)', async () => {
    const g1 = resolve(ROOT, 'g1');
    const g2 = resolve(ROOT, 'g2');
    const data = resolve(ROOT, 'sub', 'data.txt');
    topo.realDirs.add(data);
    topo.links.set(g1, g2);
    topo.links.set(g2, data);
    const res = await safeResolve(ROOT, 'g1');
    expect(res.ok).toBe(true);
  });

  it('blocks a symlink that lands on the worktree .git file', async () => {
    const gitFile = resolve(ROOT, '.git');
    topo.realDirs.add(gitFile);
    topo.links.set(link1, gitFile);

    const res = await safeResolve(ROOT, 'link1');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/git metadata/);
  });
});
