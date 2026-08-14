import {
  loadResolvedSession,
  SessionCompositionMismatchError,
  type LoadedSession,
  type LoadSessionOptions,
  type SessionFileResolution,
} from '../../runtime/index.js';
import { CLI_EXIT } from './exit-codes.js';

export type ReplResumeLoadResult =
  | { status: 'ok'; loaded: LoadedSession }
  | { status: 'not-found'; sessionId: string; path: string; exitCode: typeof CLI_EXIT.USAGE }
  | {
      status: 'failed';
      error: unknown;
      exitCode: typeof CLI_EXIT.NEEDS_HUMAN | typeof CLI_EXIT.STATE_CORRUPT;
    };

/** Production resume-to-read boundary, injectable only so CLI exit mapping has deterministic tests. */
export async function loadResumeSessionForCli(
  resolution: Extract<SessionFileResolution, { status: 'ok' }>,
  options: LoadSessionOptions,
  dependencies: { loadResolvedSession: typeof loadResolvedSession } = { loadResolvedSession },
): Promise<ReplResumeLoadResult> {
  try {
    const result = await dependencies.loadResolvedSession(resolution, options);
    if (result.status === 'not-found') {
      return {
        status: 'not-found',
        sessionId: result.sessionId,
        path: result.path,
        exitCode: CLI_EXIT.USAGE,
      };
    }
    return { status: 'ok', loaded: result.loaded };
  } catch (error) {
    return {
      status: 'failed',
      error,
      exitCode: error instanceof SessionCompositionMismatchError
        ? CLI_EXIT.NEEDS_HUMAN
        : CLI_EXIT.STATE_CORRUPT,
    };
  }
}
