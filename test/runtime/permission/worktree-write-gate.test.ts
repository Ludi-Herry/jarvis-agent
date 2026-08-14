import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { DefaultPermissionGate } from '../../../src/runtime/permission/permission-gate.js';
import type { ToolCall } from '../../../src/core/types.js';

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) };
}

let dir: string;
let worktree: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-worktree-gate-'));
  worktree = join(dir, 'goal-worktree');
  outside = join(dir, 'host-checkout');
  await mkdir(worktree, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PermissionGate — unattended goal worktree writes', () => {
  it('allows the built-in write tool inside the injected goal worktree without an approver', async () => {
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const out = await gate.check(call('write', { path: 'src/a.ts', content: 'x', createOnly: true }), 'writes-files');

    expect(out).toMatchObject({ allowed: true, source: 'goal-worktree' });
  });

  it('denies parent-directory and absolute escapes instead of falling through to approval', async () => {
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const parentEscape = await gate.check(call('write', { path: '../host-checkout/pwn.txt', content: 'x', createOnly: true }), 'writes-files');
    const absoluteEscape = await gate.check(call('write', { path: join(outside, 'pwn.txt'), content: 'x', createOnly: true }), 'writes-files');

    expect(parentEscape).toMatchObject({ allowed: false, source: 'goal-worktree' });
    expect(absoluteEscape).toMatchObject({ allowed: false, source: 'goal-worktree' });
  });

  it('denies git metadata even though it sits under the worktree root', async () => {
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const dotGitFile = await gate.check(call('write', { path: '.git', content: 'gitdir: elsewhere', createOnly: true }), 'writes-files');
    const nestedDotGit = await gate.check(call('write', { path: 'sub/.git/config', content: '[core]', createOnly: true }), 'writes-files');

    expect(dotGitFile).toMatchObject({ allowed: false, source: 'goal-worktree' });
    expect(nestedDotGit).toMatchObject({ allowed: false, source: 'goal-worktree' });
  });

  it('denies symlink or junction escapes after following the effective target', async () => {
    await symlink(outside, join(worktree, 'link-out'), process.platform === 'win32' ? 'junction' : 'dir');
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const out = await gate.check(call('write', { path: 'link-out/pwn.txt', content: 'x', createOnly: true }), 'writes-files');

    expect(out).toMatchObject({ allowed: false, source: 'goal-worktree' });
  });

  it('denies symlink or junction targets that land on git metadata inside the worktree', async () => {
    await mkdir(join(worktree, '.git'), { recursive: true });
    await writeFile(join(worktree, '.git', 'config'), 'original', 'utf8');
    await symlink(join(worktree, '.git'), join(worktree, 'link-git'), process.platform === 'win32' ? 'junction' : 'dir');
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const out = await gate.check(call('write', { path: 'link-git/config', content: 'x', createOnly: true }), 'writes-files');

    expect(out).toMatchObject({ allowed: false, source: 'goal-worktree' });
    expect(out.reason).toMatch(/git metadata/);
  });

  it('normalizes Windows namespaced roots before checking containment', async () => {
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: toNamespacedPath(worktree) });

    const out = await gate.check(call('write', { path: 'src/a.ts', content: 'x', createOnly: true }), 'writes-files');

    expect(out).toMatchObject({ allowed: true, source: 'goal-worktree' });
  });

  it('keeps bash fail-closed without an approver', async () => {
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const out = await gate.check(call('bash', { command: 'echo hi' }), 'executes-code');

    expect(out).toMatchObject({ allowed: false, source: 'fail-closed' });
  });

  it('rejects an unversioned write before unattended auto-allow', async () => {
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const out = await gate.check(call('write', { path: 'src/a.ts', content: 'x' }), 'writes-files');

    expect(out).toMatchObject({ allowed: false, source: 'goal-worktree' });
    expect(out.reason).toMatch(/precondition/);
  });

  it('keeps network and unknown write-like tools fail-closed without an approver', async () => {
    const gate = new DefaultPermissionGate({ goalWorktreeWriteRoot: worktree });

    const vision = await gate.check(call('vision', { image: 'img.png' }), 'network');
    const unknownWrite = await gate.check(call('patch_file', { path: 'src/a.ts', content: 'x' }), 'writes-files');

    expect(vision).toMatchObject({ allowed: false, source: 'fail-closed' });
    expect(unknownWrite).toMatchObject({ allowed: false, source: 'goal-worktree' });
  });
});
