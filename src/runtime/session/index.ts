/**
 * session barrel — public face of `src/runtime/session` (persistence segment, plan §3.1).
 *
 * The loop imports {@link SessionStore} (type) to persist turns; the CLI builds a
 * {@link FileSessionStore} and uses {@link loadSession} / {@link latestSessionPath} to resume. The
 * pure {@link parseSessionLog} / {@link replayMessages} stay exported for direct testing.
 */
export {
  FileSessionStore,
  loadSession,
  latestSessionPath,
  parseSessionLog,
  replayMessages,
  serializeRecord,
  type SessionStore,
  type SessionRecord,
  type SessionHeader,
} from './session-store.js';
