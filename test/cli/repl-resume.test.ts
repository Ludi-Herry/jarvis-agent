import { describe, expect, it } from 'vitest';
import {
  SessionCompositionMismatchError,
  type SessionFileResolution,
} from '../../src/runtime/index.js';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';
import { loadResumeSessionForCli } from '../../src/surfaces/cli/repl-resume.js';

const resolution: Extract<SessionFileResolution, { status: 'ok' }> = {
  status: 'ok',
  sessionId: 'session-1',
  file: 'session-1.jsonl',
  path: 'H:\\fixture\\data\\sessions\\session-1.jsonl',
  mtimeMs: 10,
};

describe('loadResumeSessionForCli', () => {
  it('maps a second-read disappearance to not-found exit 2', async () => {
    const result = await loadResumeSessionForCli(resolution, {}, {
      loadResolvedSession: async () => ({
        status: 'not-found',
        sessionId: resolution.sessionId,
        file: resolution.file,
        path: resolution.path,
      }),
    });

    expect(result).toEqual({
      status: 'not-found',
      sessionId: resolution.sessionId,
      path: resolution.path,
      exitCode: CLI_EXIT.USAGE,
    });
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('maps a second-read %s failure to exit 7', async (code) => {
    const error = fsError(code);
    const result = await loadResumeSessionForCli(resolution, {}, {
      loadResolvedSession: async () => { throw error; },
    });

    expect(result).toEqual({ status: 'failed', error, exitCode: CLI_EXIT.STATE_CORRUPT });
  });

  it('maps composition drift to exit 3', async () => {
    const error = new SessionCompositionMismatchError('composition drift');
    const result = await loadResumeSessionForCli(resolution, {}, {
      loadResolvedSession: async () => { throw error; },
    });

    expect(result).toEqual({ status: 'failed', error, exitCode: CLI_EXIT.NEEDS_HUMAN });
  });
});

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: second read failed`), { code });
}
