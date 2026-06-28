import { describe, expect, it } from 'vitest';
import { resolve, sep } from 'node:path';
import { isWithin } from '../../src/core/tools/safe-path.js';

// Pure containment decision — the disk-free core of path confinement. Anchor against a
// platform-correct absolute root so the assertions hold on win32 and POSIX alike.
const root = resolve(sep, 'project');

describe('isWithin', () => {
  it('accepts the root itself and files directly under it', () => {
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, resolve(root, 'src/index.ts'))).toBe(true);
  });

  it('rejects a parent-directory escape via ..', () => {
    expect(isWithin(root, resolve(root, '../secret.txt'))).toBe(false);
    expect(isWithin(root, resolve(root, '../../etc/passwd'))).toBe(false);
  });

  it('rejects an absolute path that lands elsewhere', () => {
    expect(isWithin(root, resolve(sep, 'elsewhere', 'x'))).toBe(false);
  });

  it('does NOT mistake a sibling whose name merely starts with .. for an escape', () => {
    expect(isWithin(root, resolve(root, '..foo'))).toBe(true);
  });
});
