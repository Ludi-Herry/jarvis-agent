import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const fsMocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  lstat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readdir: fsMocks.readdir,
  lstat: fsMocks.lstat,
}));

import { latestSessionPath } from '../../src/runtime/session/session-store.js';

describe('latestSessionPath filesystem races', () => {
  beforeEach(() => {
    fsMocks.readdir.mockReset();
    fsMocks.lstat.mockReset();
  });

  it('skips an ENOENT entry that disappears after directory enumeration', async () => {
    const dir = 'H:\\fixture\\data\\sessions';
    fsMocks.readdir.mockResolvedValueOnce(['gone.jsonl', 'kept.jsonl']);
    fsMocks.lstat.mockImplementation(async (path: string) => {
      if (path.endsWith('gone.jsonl')) throw fsError('ENOENT');
      return { mtimeMs: 10 };
    });

    await expect(latestSessionPath(dir)).resolves.toBe(join(dir, 'kept.jsonl'));
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('preserves %s from entry inspection', async (code) => {
    fsMocks.readdir.mockResolvedValueOnce(['blocked.jsonl']);
    fsMocks.lstat.mockRejectedValueOnce(fsError(code));

    await expect(latestSessionPath('H:\\fixture\\data\\sessions')).rejects.toMatchObject({ code });
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('preserves %s from directory enumeration', async (code) => {
    fsMocks.readdir.mockRejectedValueOnce(fsError(code));

    await expect(latestSessionPath('H:\\fixture\\data\\sessions')).rejects.toMatchObject({ code });
    expect(fsMocks.lstat).not.toHaveBeenCalled();
  });
});

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: fixture filesystem failure`), { code });
}
