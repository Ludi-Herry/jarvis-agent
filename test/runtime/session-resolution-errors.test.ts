import { resolve, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  lstat: fsMocks.lstat,
  realpath: fsMocks.realpath,
}));

import { resolveSessionFilePath } from '../../src/runtime/session/session-store.js';

describe('resolveSessionFilePath canonical containment', () => {
  beforeEach(() => {
    fsMocks.lstat.mockReset();
    fsMocks.realpath.mockReset();
  });

  it('rejects a regular-looking session whose canonical target escapes data/sessions', async () => {
    const cwd = resolve('fixture-workspace');
    const outside = resolve('outside', 'escaped.jsonl');
    fsMocks.lstat.mockImplementation(async (path: string) => {
      const isFile = path.endsWith(`${sep}escaped.jsonl`);
      return {
        isSymbolicLink: () => false,
        isDirectory: () => !isFile,
        isFile: () => isFile,
        mtimeMs: 10,
      };
    });
    fsMocks.realpath.mockImplementation(async (path: string) => path === cwd ? cwd : outside);

    const result = await resolveSessionFilePath({ cwd, sessionId: 'escaped' });

    expect(result).toMatchObject({
      status: 'unsafe-path',
      sessionId: 'escaped',
      reason: 'unsafe session path: canonical target escapes data/sessions',
    });
    expect(fsMocks.realpath).toHaveBeenCalledTimes(2);
  });
});
