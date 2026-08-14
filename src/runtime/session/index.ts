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
  replaySession,
  sessionSemanticIssues,
  serializeRecord,
  createSessionComposition,
  createModelRequestReceipt,
  diffSessionComposition,
  summarizeToolResult,
  SESSION_SCHEMA_VERSION,
  type SessionStore,
  type SessionRecord,
  type SessionSemanticIssue,
  type SessionHeader,
  type SessionFormat,
  type SessionComposition,
  type SessionCompositionInput,
  type SessionCompositionDifference,
  type PendingToolExecution,
  type LoadedSession,
  type ModelRequestReceipt,
  type ModelRequestReceiptInput,
  type ToolExecutionPlan,
  type ToolExecutionCommit,
  type ToolExecutionUnknown,
} from './session-store.js';
