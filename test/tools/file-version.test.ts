import { describe, expect, it } from 'vitest';
import { fileVersion, isFileVersion } from '../../src/core/tools/file-version.js';

describe('fileVersion', () => {
  it('is stable for the same bytes and changes with content', () => {
    const first = fileVersion(Buffer.from('same', 'utf8'));
    expect(fileVersion(Buffer.from('same', 'utf8'))).toBe(first);
    expect(fileVersion(Buffer.from('changed', 'utf8'))).not.toBe(first);
    expect(isFileVersion(first)).toBe(true);
  });

  it('does not expose the original content', () => {
    const token = fileVersion(Buffer.from('private-value', 'utf8'));
    expect(token).toMatch(/^fv1\.[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain('private-value');
    expect(isFileVersion('fv1.invalid')).toBe(false);
  });
});
