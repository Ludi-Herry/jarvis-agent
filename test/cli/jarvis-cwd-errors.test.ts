import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const statMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  stat: statMock,
}));

import { runJarvisCli } from '../../src/surfaces/cli/jarvis.js';

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

describe('jarvis root cwd error classification', () => {
  beforeEach(() => {
    process.argv = ['node', 'jarvis', '--cwd', 'blocked-workspace', 'status'];
    process.exitCode = undefined;
    statMock.mockReset();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('maps only ENOENT to missing cwd and exit 2', async () => {
    statMock.mockRejectedValueOnce(fsError('ENOENT'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runJarvisCli();

    expect(process.exitCode).toBe(CLI_EXIT.USAGE);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--cwd does not exist'));
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('keeps %s visible and exits 7', async (code) => {
    statMock.mockRejectedValueOnce(fsError(code));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runJarvisCli();

    expect(process.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(code));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('--cwd does not exist'));
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('keeps %s visible when entering an inspected cwd fails', async (code) => {
    statMock.mockResolvedValueOnce({ isDirectory: () => true });
    const chdir = vi.spyOn(process, 'chdir').mockImplementationOnce(() => {
      throw fsError(code);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runJarvisCli();

    expect(chdir).toHaveBeenCalledWith(expect.stringContaining('blocked-workspace'));
    expect(process.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`cannot enter --cwd`));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(code));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('--cwd does not exist'));
  });
});

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: cannot inspect cwd`), { code });
}
