/**
 * Append-only Session JSONL. Version 2 adds sequence numbers, composition
 * provenance, request receipts, and tool execution receipts while preserving
 * read compatibility with the original message/compaction format.
 */
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileReceipt, Message, ToolCall, ToolResult, ToolSchema } from '../../core/types.js';
import {
  assertOperationalJsonlIntegrity,
  hasStringFields,
  isJsonObject,
  parseJsonlWithDiagnostics,
} from '../jsonl-integrity.js';

export const SESSION_SCHEMA_VERSION = 2 as const;

export type SessionFormat = 'v1' | 'v2';
export type SessionRoot = 'repl' | 'goal' | 'loop';
export type SessionPermissionMode = 'interactive' | 'unattended' | 'worktree-unattended';

export interface SessionComposition {
  root: SessionRoot;
  runtimeVersion: string;
  permissionMode: SessionPermissionMode;
  coverage: 'full' | 'partial';
  toolsetHash?: string;
  systemPromptHash?: string;
  /** Versioned identity of the deterministic per-run addendum resolver. */
  dynamicAddendumSource?: string;
  /** Hash of the resolver's complete source manifest; the manifest body is not duplicated here. */
  dynamicAddendumManifestHash?: string;
}

export interface SessionDynamicAddendumInput {
  source: string;
  manifest: unknown;
}

export interface SessionCompositionInput {
  root: SessionRoot;
  runtimeVersion: string;
  permissionMode: SessionPermissionMode;
  toolSchemas?: readonly ToolSchema[];
  systemPrompt?: string;
  dynamicAddendum?: SessionDynamicAddendumInput;
}

export interface SessionCompositionDifference {
  field: keyof SessionComposition;
  recorded: string | undefined;
  current: string | undefined;
}

export type SessionDynamicAddendumResolver = (activationText: string) => string | undefined;

export interface SessionResumeValidation {
  expectedComposition: SessionComposition;
  resolveDynamicAddendum: SessionDynamicAddendumResolver;
}

export interface LoadSessionOptions {
  requireHeader?: boolean;
  validateIntegrity?: boolean;
  /** File-name identity expected by an explicit/latest resume selection. */
  expectedSessionId?: string;
  /** Resume-only proof. Observers can omit it and remain non-authoritative. */
  resume?: SessionResumeValidation;
}

export class SessionCompositionMismatchError extends Error {
  readonly differences: SessionCompositionDifference[];

  constructor(message: string, differences: SessionCompositionDifference[] = []) {
    super(message);
    this.name = 'SessionCompositionMismatchError';
    this.differences = differences;
  }
}

export const NO_DYNAMIC_ADDENDUM = Object.freeze({
  source: 'none-v1',
  manifest: null,
}) satisfies SessionDynamicAddendumInput;

export const resolveNoDynamicAddendum: SessionDynamicAddendumResolver = () => undefined;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const WINDOWS_DEVICE_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

export type SessionIdCheck = { ok: true } | { ok: false; reason: string };

/**
 * Session ids are durable file names on every supported platform. Keep the
 * accepted language deliberately narrower than either POSIX or Windows so the
 * same id cannot name two files after Windows strips a suffix or resolves a
 * device alias.
 */
export function validateSessionId(id: string): SessionIdCheck {
  if (id.trim() === '') return { ok: false, reason: 'session id must not be empty' };
  if (/[. ]$/u.test(id)) {
    return {
      ok: false,
      reason: `session id has a Windows-ambiguous trailing dot or space: ${JSON.stringify(id.slice(0, 80))}`,
    };
  }
  if (!SESSION_ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason: `session id is not a safe identifier: ${JSON.stringify(id.slice(0, 80))}`
        + ' (expected letters, digits, ".", "_", "-"; no separators, absolute paths, or Windows namespaced paths)',
    };
  }
  const windowsStem = id.split('.', 1)[0];
  if (WINDOWS_DEVICE_STEM.test(windowsStem)) {
    return {
      ok: false,
      reason: `session id uses a reserved Windows device name: ${JSON.stringify(id.slice(0, 80))}`,
    };
  }
  return { ok: true };
}

export type SessionFileResolution =
  | { status: 'ok'; sessionId: string; file: string; path: string; mtimeMs: number }
  | { status: 'invalid-session-id'; sessionId: string; reason: string }
  | { status: 'not-found'; sessionId: string; file: string; path: string }
  | { status: 'unreadable' | 'unsafe-path'; sessionId: string; file: string; path: string; reason: string };

/**
 * Resolve one session id without following a symlink/junction out of the
 * workspace. Inspection and execution both call this boundary before reading
 * JSONL so they cannot disagree about which file an id denotes.
 *
 * `scope` defaults to the active `data/sessions` directory; `'archived'`
 * resolves inside `data/sessions/archived` with the identical safety checks.
 */
export async function resolveSessionFilePath(input: {
  cwd: string;
  sessionId: string;
  scope?: 'active' | 'archived';
}): Promise<SessionFileResolution> {
  const idCheck = validateSessionId(input.sessionId);
  if (!idCheck.ok) {
    return { status: 'invalid-session-id', sessionId: input.sessionId, reason: idCheck.reason };
  }

  const dataDir = join(input.cwd, 'data');
  const activeSessionsDir = join(dataDir, 'sessions');
  const archived = input.scope === 'archived';
  const sessionsDir = archived ? join(activeSessionsDir, 'archived') : activeSessionsDir;
  const file = `${input.sessionId}.jsonl`;
  const path = join(sessionsDir, file);
  const components = [
    { path: dataDir, kind: 'directory' as const },
    ...(archived ? [{ path: activeSessionsDir, kind: 'directory' as const }] : []),
    { path: sessionsDir, kind: 'directory' as const },
    { path, kind: 'file' as const },
  ];
  let fileMtimeMs = 0;

  for (const component of components) {
    let info;
    try {
      info = await lstat(component.path);
    } catch (err) {
      return sessionFileFailure(err, input.sessionId, file, path, `cannot inspect ${component.kind}`);
    }
    if (info.isSymbolicLink()) {
      return {
        status: 'unsafe-path',
        sessionId: input.sessionId,
        file,
        path,
        reason: `unsafe session path: ${component.kind} is a symbolic link or reparse point`,
      };
    }
    if (component.kind === 'directory' && !info.isDirectory()) {
      return {
        status: 'unreadable',
        sessionId: input.sessionId,
        file,
        path,
        reason: `session path is unreadable: expected directory at ${component.path}`,
      };
    }
    if (component.kind === 'file') {
      if (!info.isFile()) {
        return {
          status: 'unreadable',
          sessionId: input.sessionId,
          file,
          path,
          reason: `session path is unreadable: expected a regular file at ${component.path}`,
        };
      }
      fileMtimeMs = info.mtimeMs;
    }
  }

  try {
    const [canonicalCwd, canonicalFile] = await Promise.all([realpath(input.cwd), realpath(path)]);
    const canonicalSessionsDir = archived
      ? resolve(canonicalCwd, 'data', 'sessions', 'archived')
      : resolve(canonicalCwd, 'data', 'sessions');
    const local = relative(canonicalSessionsDir, canonicalFile);
    if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      return {
        status: 'unsafe-path',
        sessionId: input.sessionId,
        file,
        path,
        reason: 'unsafe session path: canonical target escapes data/sessions',
      };
    }
  } catch (err) {
    return sessionFileFailure(err, input.sessionId, file, path, 'cannot canonicalize session path');
  }

  return { status: 'ok', sessionId: input.sessionId, file, path, mtimeMs: fileMtimeMs };
}

function sessionFileFailure(
  err: unknown,
  sessionId: string,
  file: string,
  path: string,
  operation: string,
): Exclude<SessionFileResolution, { status: 'ok' | 'invalid-session-id' }> {
  if (classifySessionFileError(err) === 'not-found') return { status: 'not-found', sessionId, file, path };
  return {
    status: 'unreadable',
    sessionId,
    file,
    path,
    reason: `${operation}: ${describeFsError(err)}`,
  };
}

export function classifySessionFileError(err: unknown): 'not-found' | 'unreadable' {
  return isNotFoundError(err) ? 'not-found' : 'unreadable';
}

function describeFsError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = 'code' in err && typeof err.code === 'string' ? `${err.code}: ` : '';
  return `${code}${err.message}`;
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

interface LegacySessionHeader {
  t: 'session';
  id: string;
  model: string;
  cwd: string;
  startedAt: string;
}

interface LegacyMessageRecord {
  t: 'message';
  message: Message;
}

interface LegacyCompactionRecord {
  t: 'compaction';
  messages: Message[];
}

interface V2Base {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  seq: number;
  at: string;
}

export interface V2SessionHeader extends V2Base {
  t: 'session';
  id: string;
  model: string;
  cwd: string;
  startedAt: string;
  composition: SessionComposition;
  legacyImportedFrom?: string;
  /** Lineage of a full-fidelity fork: the session id this log was copied from. */
  forkedFrom?: string;
}

export interface ModelRequestReceipt {
  t: 'request';
  requestId: string;
  runId: string;
  turn: number;
  messageCount: number;
  messagesHash: string;
  systemAddendumHash?: string;
  toolCount: number;
  toolsHash: string;
}

export interface ToolExecutionPlan {
  t: 'tool';
  phase: 'planned';
  executionId: string;
  requestId: string;
  runId: string;
  turn: number;
  callIndex: number;
  call: ToolCall;
}

export interface ToolCommitSummary {
  callId: string;
  contentLength: number;
  contentHash: string;
  error?: string;
  fileReceipt?: FileReceipt;
}

export interface ToolExecutionCommit {
  t: 'tool';
  phase: 'committed';
  executionId: string;
  requestId: string;
  runId: string;
  turn: number;
  callIndex: number;
  result: ToolCommitSummary;
}

export interface ToolExecutionUnknown {
  t: 'tool';
  phase: 'unknown';
  executionId: string;
  requestId: string;
  runId: string;
  turn: number;
  callIndex: number;
  reason: string;
}

type V2SessionRecord =
  | V2SessionHeader
  | (V2Base & { t: 'message'; message: Message })
  | (V2Base & { t: 'compaction'; messages: Message[] })
  | (V2Base & ModelRequestReceipt)
  | (V2Base & (ToolExecutionPlan | ToolExecutionCommit | ToolExecutionUnknown));

type WithoutV2Base<T> = T extends V2Base ? Omit<T, keyof V2Base> : never;
type V2SessionPayload = WithoutV2Base<V2SessionRecord>;

export type SessionRecord =
  | LegacySessionHeader
  | LegacyMessageRecord
  | LegacyCompactionRecord
  | V2SessionRecord;

export type SessionHeader = LegacySessionHeader | V2SessionHeader;

export interface PendingToolExecution {
  executionId?: string;
  requestId?: string;
  callId: string;
  toolName: string;
  reason: 'intent-without-plan' | 'planned-without-terminal' | 'unknown' | 'committed-without-message';
}

export interface SessionSemanticIssue {
  kind: 'header' | 'mixed-version' | 'sequence' | 'receipt';
  /** 1-based record position in the parsed stream. */
  line: number;
  detail: string;
}

export interface LoadedSession {
  messages: Message[];
  header?: SessionHeader;
  format: SessionFormat;
  lastSequence: number;
  requests: Array<V2Base & ModelRequestReceipt>;
  toolReceipts: Array<V2Base & (ToolExecutionPlan | ToolExecutionCommit | ToolExecutionUnknown)>;
  pendingTools: PendingToolExecution[];
}

/** One validated read of the append-only source plus its active replay projection. */
export interface LoadedSessionLog {
  records: SessionRecord[];
  loaded: LoadedSession;
}

/** The contract the loop depends on. Receipt methods are optional for legacy/test stores. */
export interface SessionStore {
  readonly receiptFormat?: 'v2';
  sync(messages: Message[]): Promise<void>;
  checkpoint(messages: Message[]): Promise<void>;
  recordRequest?(receipt: ModelRequestReceipt): Promise<void>;
  recordToolPlanned?(receipt: ToolExecutionPlan): Promise<void>;
  recordToolCommitted?(receipt: ToolExecutionCommit): Promise<void>;
  recordToolUnknown?(receipt: ToolExecutionUnknown): Promise<void>;
}

export interface ModelRequestReceiptInput {
  requestId: string;
  runId: string;
  turn: number;
  messages: readonly Message[];
  systemAddendum?: string;
  tools: readonly ToolSchema[];
}

export function createModelRequestReceipt(input: ModelRequestReceiptInput): ModelRequestReceipt {
  return {
    t: 'request',
    requestId: input.requestId,
    runId: input.runId,
    turn: input.turn,
    messageCount: input.messages.length,
    messagesHash: digestValue(input.messages),
    ...(input.systemAddendum === undefined ? {} : { systemAddendumHash: digestValue(input.systemAddendum) }),
    toolCount: input.tools.length,
    toolsHash: digestValue(input.tools),
  };
}

export function createSessionComposition(input: SessionCompositionInput): SessionComposition {
  return {
    root: input.root,
    runtimeVersion: input.runtimeVersion,
    permissionMode: input.permissionMode,
    coverage: input.toolSchemas !== undefined && input.systemPrompt !== undefined ? 'full' : 'partial',
    ...(input.toolSchemas === undefined ? {} : { toolsetHash: digestValue(input.toolSchemas) }),
    ...(input.systemPrompt === undefined ? {} : { systemPromptHash: digestValue(input.systemPrompt) }),
    ...(input.dynamicAddendum === undefined
      ? {}
      : {
          dynamicAddendumSource: input.dynamicAddendum.source,
          dynamicAddendumManifestHash: digestValue(input.dynamicAddendum.manifest),
        }),
  };
}

export function diffSessionComposition(
  recorded: SessionComposition,
  current: SessionComposition,
): SessionCompositionDifference[] {
  const fields: Array<keyof SessionComposition> = [
    'root',
    'runtimeVersion',
    'permissionMode',
    'coverage',
    'toolsetHash',
    'systemPromptHash',
    'dynamicAddendumSource',
    'dynamicAddendumManifestHash',
  ];
  return fields.flatMap((field) => {
    const left = recorded[field];
    const right = current[field];
    return left === right ? [] : [{ field, recorded: left, current: right }];
  });
}

export function summarizeToolResult(result: ToolResult): ToolCommitSummary {
  return {
    callId: result.callId,
    contentLength: result.content.length,
    contentHash: digestValue(result.content),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.fileReceipt === undefined ? {} : { fileReceipt: result.fileReceipt }),
  };
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isJsonObject(value) || typeof value.t !== 'string') return false;
  if (value.schemaVersion === SESSION_SCHEMA_VERSION) return isV2SessionRecord(value);
  if ('schemaVersion' in value) return false;
  switch (value.t) {
    case 'session':
      return hasStringFields(value, 'id', 'model', 'cwd', 'startedAt');
    case 'message':
      return isMessage(value.message);
    case 'compaction':
      return Array.isArray(value.messages) && value.messages.every(isMessage);
    default:
      return false;
  }
}

function isV2SessionRecord(value: unknown): value is V2SessionRecord {
  if (!isJsonObject(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION) return false;
  if (!Number.isInteger(value.seq) || (value.seq as number) < 1 || typeof value.at !== 'string') return false;
  switch (value.t) {
    case 'session':
      return hasStringFields(value, 'id', 'model', 'cwd', 'startedAt')
        && isSessionComposition(value.composition)
        && (value.legacyImportedFrom === undefined || typeof value.legacyImportedFrom === 'string')
        && (value.forkedFrom === undefined || typeof value.forkedFrom === 'string');
    case 'message':
      return isMessage(value.message);
    case 'compaction':
      return Array.isArray(value.messages) && value.messages.every(isMessage);
    case 'request':
      return hasStringFields(value, 'requestId', 'runId', 'messagesHash', 'toolsHash')
        && Number.isInteger(value.turn) && (value.turn as number) >= 0
        && Number.isInteger(value.messageCount) && (value.messageCount as number) >= 0
        && Number.isInteger(value.toolCount) && (value.toolCount as number) >= 0
        && (value.systemAddendumHash === undefined || typeof value.systemAddendumHash === 'string');
    case 'tool':
      return isToolReceipt(value);
    default:
      return false;
  }
}

function isSessionComposition(value: unknown): value is SessionComposition {
  if (!isJsonObject(value)) return false;
  const hasDynamicSource = value.dynamicAddendumSource !== undefined;
  const hasDynamicManifest = value.dynamicAddendumManifestHash !== undefined;
  return (value.root === 'repl' || value.root === 'goal' || value.root === 'loop')
    && typeof value.runtimeVersion === 'string'
    && (value.permissionMode === 'interactive' || value.permissionMode === 'unattended' || value.permissionMode === 'worktree-unattended')
    && (value.coverage === 'full' || value.coverage === 'partial')
    && (value.toolsetHash === undefined || typeof value.toolsetHash === 'string')
    && (value.systemPromptHash === undefined || typeof value.systemPromptHash === 'string')
    && hasDynamicSource === hasDynamicManifest
    && (value.dynamicAddendumSource === undefined
      || (typeof value.dynamicAddendumSource === 'string' && value.dynamicAddendumSource.trim() !== ''))
    && (value.dynamicAddendumManifestHash === undefined || typeof value.dynamicAddendumManifestHash === 'string');
}

function isToolReceipt(value: Record<string, unknown>): boolean {
  if (!hasStringFields(value, 'executionId', 'requestId', 'runId')) return false;
  if (!Number.isInteger(value.turn) || (value.turn as number) < 0) return false;
  if (!Number.isInteger(value.callIndex) || (value.callIndex as number) < 0) return false;
  switch (value.phase) {
    case 'planned':
      return isToolCall(value.call);
    case 'committed':
      return isToolCommitSummary(value.result);
    case 'unknown':
      return typeof value.reason === 'string';
    default:
      return false;
  }
}

function isToolCommitSummary(value: unknown): value is ToolCommitSummary {
  if (!isJsonObject(value) || !hasStringFields(value, 'callId', 'contentHash')) return false;
  return Number.isInteger(value.contentLength) && (value.contentLength as number) >= 0
    && (value.error === undefined || typeof value.error === 'string')
    && (value.fileReceipt === undefined || isFileReceipt(value.fileReceipt));
}

function isFileReceipt(value: unknown): value is FileReceipt {
  if (!isJsonObject(value) || typeof value.kind !== 'string' || typeof value.path !== 'string') return false;
  if (value.kind === 'read') return typeof value.version === 'string';
  return value.kind === 'write'
    && (value.precondition === 'createOnly' || value.precondition === 'expectedVersion')
    && (value.outcome === 'applied' || value.outcome === 'conflict' || value.outcome === 'unknown')
    && (value.expectedVersion === undefined || typeof value.expectedVersion === 'string')
    && (value.preVersion === undefined || typeof value.preVersion === 'string')
    && (value.postVersion === undefined || typeof value.postVersion === 'string');
}

function isMessage(value: unknown): value is Message {
  if (!isJsonObject(value) || typeof value.role !== 'string') return false;
  switch (value.role) {
    case 'system':
    case 'user':
      return typeof value.content === 'string';
    case 'assistant':
      return (value.content === undefined || typeof value.content === 'string')
        && (value.reasoning === undefined || typeof value.reasoning === 'string')
        && (value.requestId === undefined || typeof value.requestId === 'string')
        && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall)));
    case 'tool':
      return hasStringFields(value, 'toolCallId', 'content')
        && (value.executionId === undefined || typeof value.executionId === 'string');
    default:
      return false;
  }
}

function isToolCall(value: unknown): value is ToolCall {
  return isJsonObject(value) && hasStringFields(value, 'id', 'name', 'arguments');
}

export function serializeRecord(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseSessionLog(text: string): SessionRecord[] {
  return parseJsonlWithDiagnostics(text, isSessionRecord).records;
}

export function replayMessages(records: SessionRecord[]): { messages: Message[]; header?: SessionHeader } {
  const replayed = replaySession(records);
  return { messages: replayed.messages, ...(replayed.header === undefined ? {} : { header: replayed.header }) };
}

export function replaySession(records: SessionRecord[]): LoadedSession {
  let messages: Message[] = [];
  let header: SessionHeader | undefined;
  const requests: Array<V2Base & ModelRequestReceipt> = [];
  const toolReceipts: Array<V2Base & (ToolExecutionPlan | ToolExecutionCommit | ToolExecutionUnknown)> = [];
  // Only an append-only message record proves that a tool result reached the
  // durable conversation. A later compaction snapshot may preserve that proof,
  // but it may not create it retroactively.
  const historicalToolProjections = new Set<string>();
  // Tool intent has the same append-only authority. Compaction may remove an
  // old assistant message from the active model projection, but it cannot erase
  // an unresolved call that was already persisted.
  const historicalAssistantIntents: Array<{ requestId: string; callIndex: number; call: ToolCall }> = [];
  let format: SessionFormat = records.some(isV2Record) ? 'v2' : 'v1';
  let lastSequence = 0;
  for (const record of records) {
    if (isV2Record(record)) lastSequence = Math.max(lastSequence, record.seq);
    switch (record.t) {
      case 'session':
        header = record;
        format = isV2Record(record) ? 'v2' : 'v1';
        break;
      case 'message':
        messages.push(record.message);
        if (record.message.role === 'assistant' && record.message.requestId && record.message.toolCalls) {
          const requestId = record.message.requestId;
          record.message.toolCalls.forEach((call, callIndex) => {
            historicalAssistantIntents.push({ requestId, callIndex, call });
          });
        }
        if (record.message.role === 'tool' && record.message.executionId) {
          historicalToolProjections.add(record.message.executionId);
        }
        break;
      case 'compaction':
        messages = [...record.messages];
        break;
      case 'request':
        requests.push(record);
        break;
      case 'tool':
        toolReceipts.push(record);
        break;
    }
  }
  return {
    messages,
    ...(header === undefined ? {} : { header }),
    format,
    lastSequence,
    requests,
    toolReceipts,
    pendingTools: findPendingTools(
      messages,
      toolReceipts,
      historicalToolProjections,
      historicalAssistantIntents,
    ),
  };
}

function findPendingTools(
  messages: readonly Message[],
  receipts: readonly (V2Base & (ToolExecutionPlan | ToolExecutionCommit | ToolExecutionUnknown))[],
  historicalToolProjections: ReadonlySet<string>,
  historicalAssistantIntents: ReadonlyArray<{ requestId: string; callIndex: number; call: ToolCall }>,
): PendingToolExecution[] {
  const pending: PendingToolExecution[] = [];
  const plans = new Map<string, V2Base & ToolExecutionPlan>();
  const terminals = new Map<string, V2Base & (ToolExecutionCommit | ToolExecutionUnknown)>();
  for (const receipt of receipts) {
    if (receipt.phase === 'planned') plans.set(receipt.executionId, receipt);
    else terminals.set(receipt.executionId, receipt);
  }
  for (const plan of plans.values()) {
    const terminal = terminals.get(plan.executionId);
    if (terminal === undefined) {
      pending.push(toolPending(plan, 'planned-without-terminal'));
    } else if (terminal.phase === 'unknown') {
      pending.push(toolPending(plan, 'unknown'));
    } else if (!historicalToolProjections.has(plan.executionId)) {
      pending.push(toolPending(plan, 'committed-without-message'));
    }
  }

  const plannedIntents = new Set(
    [...plans.values()].map((plan) => `${plan.requestId}:${plan.callIndex}`),
  );
  for (const intent of historicalAssistantIntents) {
    if (!plannedIntents.has(`${intent.requestId}:${intent.callIndex}`)) {
      pending.push({
        requestId: intent.requestId,
        callId: intent.call.id,
        toolName: intent.call.name,
        reason: 'intent-without-plan',
      });
    }
  }

  // Legacy logs have no request/execution ids. Pair their calls and results in order.
  const legacyPending: ToolCall[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && !message.requestId && message.toolCalls) legacyPending.push(...message.toolCalls);
    if (message.role === 'tool' && !message.executionId) {
      const index = legacyPending.findIndex((call) => normalizeCallId(call.id) === normalizeCallId(message.toolCallId));
      if (index >= 0) legacyPending.splice(index, 1);
    }
  }
  for (const call of legacyPending) {
    pending.push({ callId: call.id, toolName: call.name, reason: 'intent-without-plan' });
  }
  return pending;
}

function toolPending(plan: ToolExecutionPlan, reason: PendingToolExecution['reason']): PendingToolExecution {
  return {
    executionId: plan.executionId,
    requestId: plan.requestId,
    callId: plan.call.id,
    toolName: plan.call.name,
    reason,
  };
}

function normalizeCallId(id: string): string {
  return id.slice(0, 64);
}

export interface FileSessionStoreOptions {
  format?: SessionFormat;
  initialSequence?: number;
}

/** File-backed writer. New instances default to v2; legacy resumes opt into v1. */
export class FileSessionStore implements SessionStore {
  readonly receiptFormat?: 'v2';
  private cursor: number;
  private sequence: number;
  private readonly format: SessionFormat;
  private dirEnsured = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    initialCursor = 0,
    options: FileSessionStoreOptions = {},
  ) {
    this.cursor = initialCursor;
    this.format = options.format ?? 'v2';
    this.receiptFormat = this.format === 'v2' ? 'v2' : undefined;
    this.sequence = options.initialSequence ?? 0;
  }

  async writeHeader(header: Omit<V2SessionHeader, keyof V2Base | 't'>): Promise<void> {
    await this.enqueue(async () => {
      if (this.format === 'v1') {
        await this.appendRaw({
          t: 'session',
          id: header.id,
          model: header.model,
          cwd: header.cwd,
          startedAt: header.startedAt,
        });
        return;
      }
      await this.appendV2({ t: 'session', ...header });
    });
  }

  async sync(messages: Message[]): Promise<void> {
    await this.enqueue(async () => {
      for (let i = this.cursor; i < messages.length; i++) {
        if (this.format === 'v1') await this.appendRaw({ t: 'message', message: messages[i] });
        else await this.appendV2({ t: 'message', message: messages[i] });
        this.cursor = i + 1;
      }
    });
  }

  async checkpoint(messages: Message[]): Promise<void> {
    await this.enqueue(async () => {
      if (this.format === 'v1') await this.appendRaw({ t: 'compaction', messages });
      else await this.appendV2({ t: 'compaction', messages });
      this.cursor = messages.length;
    });
  }

  async recordRequest(receipt: ModelRequestReceipt): Promise<void> {
    if (this.format === 'v1') return;
    await this.enqueue(() => this.appendV2(receipt));
  }

  async recordToolPlanned(receipt: ToolExecutionPlan): Promise<void> {
    if (this.format === 'v1') return;
    await this.enqueue(() => this.appendV2(receipt));
  }

  async recordToolCommitted(receipt: ToolExecutionCommit): Promise<void> {
    if (this.format === 'v1') return;
    await this.enqueue(() => this.appendV2(receipt));
  }

  async recordToolUnknown(receipt: ToolExecutionUnknown): Promise<void> {
    if (this.format === 'v1') return;
    await this.enqueue(() => this.appendV2(receipt));
  }

  private async enqueue(action: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(action, action);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private async appendV2(
    record: V2SessionPayload,
  ): Promise<void> {
    const next = this.sequence + 1;
    await this.appendRaw({ ...record, schemaVersion: SESSION_SCHEMA_VERSION, seq: next, at: new Date().toISOString() } as V2SessionRecord);
    this.sequence = next;
  }

  private async appendRaw(record: SessionRecord): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.path, serializeRecord(record), 'utf8');
  }
}

export async function loadSession(
  path: string,
  options: LoadSessionOptions = {},
): Promise<LoadedSession> {
  return (await loadSessionLog(path, options)).loaded;
}

/**
 * Load and validate the same bytes once while retaining their append-only records.
 * Resume consumes the replay projection; current-Session Recall consumes only the
 * message records and deliberately ignores compaction snapshots.
 */
export async function loadSessionLog(
  path: string,
  options: LoadSessionOptions = {},
): Promise<LoadedSessionLog> {
  const text = await readFile(path, 'utf8');
  const parsed = parseJsonlWithDiagnostics(text, isSessionRecord);
  const replayed = replaySession(parsed.records);
  if (options.requireHeader || options.validateIntegrity || options.resume !== undefined) {
    assertOperationalJsonlIntegrity(
      'session',
      parsed.malformed,
      replayed.header !== undefined,
    );
    assertSessionSemantics(parsed.records);
  }
  if (options.expectedSessionId !== undefined && replayed.header?.id !== options.expectedSessionId) {
    throw new Error(
      `session state is corrupt: header id ${replayed.header?.id ?? '(missing)'}`
        + ` does not match requested session id ${options.expectedSessionId}`,
    );
  }
  if (options.resume !== undefined && replayed.header && isV2Record(replayed.header)) {
    assertResumeComposition(replayed.header.composition, options.resume.expectedComposition);
    assertDynamicAddendumReceipts(parsed.records, options.resume.resolveDynamicAddendum);
  }
  return { records: parsed.records, loaded: replayed };
}

export type ResolvedSessionLoadResult =
  | { status: 'ok'; loaded: LoadedSession }
  | { status: 'not-found'; sessionId: string; file: string; path: string };

/**
 * Read a path that already passed resolveSessionFilePath. A disappearance in
 * the check-to-read window remains a not-found result; every other read or
 * semantic error stays intact for the caller to report as unreadable,
 * incompatible, or corrupt.
 */
export async function loadResolvedSession(
  resolution: Extract<SessionFileResolution, { status: 'ok' }>,
  options: LoadSessionOptions = {},
  reader: (path: string, options?: LoadSessionOptions) => Promise<LoadedSession> = loadSession,
): Promise<ResolvedSessionLoadResult> {
  try {
    return { status: 'ok', loaded: await reader(resolution.path, options) };
  } catch (err) {
    if (classifySessionFileError(err) === 'not-found') {
      return {
        status: 'not-found',
        sessionId: resolution.sessionId,
        file: resolution.file,
        path: resolution.path,
      };
    }
    throw err;
  }
}

function assertResumeComposition(recorded: SessionComposition, current: SessionComposition): void {
  const differences = diffSessionComposition(recorded, current);
  if (recorded.coverage !== 'full' || current.coverage !== 'full') {
    throw new SessionCompositionMismatchError(
      'session base composition coverage is partial; restore the recorded sources or fork into a new v2 session',
      differences,
    );
  }
  if (
    recorded.dynamicAddendumSource === undefined
    || recorded.dynamicAddendumManifestHash === undefined
    || current.dynamicAddendumSource === undefined
    || current.dynamicAddendumManifestHash === undefined
  ) {
    throw new SessionCompositionMismatchError(
      'session dynamic addendum provenance is incomplete; restore the recorded sources or fork into a new v2 session',
      differences,
    );
  }
  if (differences.length > 0) {
    throw new SessionCompositionMismatchError(
      `session composition changed (${differences.map((item) => item.field).join(', ')}); `
        + `current dynamic source=${current.dynamicAddendumSource}; restore the recorded sources or fork into a new v2 session`,
      differences,
    );
  }
}

function assertDynamicAddendumReceipts(
  records: readonly SessionRecord[],
  resolveDynamicAddendum: SessionDynamicAddendumResolver,
): void {
  let projectedMessages: Message[] = [];
  const expectedHashByRun = new Map<string, string | undefined>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isV2Record(record)) continue;
    if (record.t === 'message') {
      projectedMessages.push(record.message);
      continue;
    }
    if (record.t === 'compaction') {
      projectedMessages = [...record.messages];
      continue;
    }
    if (record.t !== 'request') continue;

    if (!expectedHashByRun.has(record.runId)) {
      const activation = [...projectedMessages].reverse().find(
        (message): message is Extract<Message, { role: 'user' }> => message.role === 'user',
      );
      if (activation === undefined) {
        throw new Error(
          `session state is corrupt at record ${index + 1}: dynamic addendum activation is ambiguous for run ${record.runId}`,
        );
      }
      const expected = resolveDynamicAddendum(activation.content);
      expectedHashByRun.set(record.runId, expected === undefined ? undefined : digestValue(expected));
    }
    const expectedHash = expectedHashByRun.get(record.runId);
    if (record.systemAddendumHash !== expectedHash) {
      throw new Error(
        `session state is corrupt at record ${index + 1}: dynamic addendum receipt mismatch for request ${record.requestId}`,
      );
    }
  }
}

export function sessionSemanticIssues(records: readonly SessionRecord[]): SessionSemanticIssue[] {
  const headers = records.filter((record) => record.t === 'session');
  if (headers.length !== 1 || records[0]?.t !== 'session') {
    const misplaced = records.findIndex((record, index) => index > 0 && record.t === 'session');
    return [{
      kind: 'header',
      line: misplaced >= 0 ? misplaced + 1 : 1,
      detail: 'expected one header as the first record',
    }];
  }
  const firstIsV2 = isV2Record(records[0]);
  const mixedAt = records.findIndex((record) => isV2Record(record) !== firstIsV2);
  if (mixedAt >= 0) {
    return [{ kind: 'mixed-version', line: mixedAt + 1, detail: 'mixed v1/v2 records' }];
  }
  if (firstIsV2) {
    for (let i = 0; i < records.length; i++) {
      const record = records[i] as V2SessionRecord;
      if (record.seq !== i + 1) {
        return [{
          kind: 'sequence',
          line: i + 1,
          detail: `sequence gap: expected ${i + 1}, found ${record.seq}`,
        }];
      }
    }
    const receiptIssue = sessionReceiptSemanticIssue(records as readonly V2SessionRecord[]);
    if (receiptIssue) return [receiptIssue];
  }
  return [];
}

function sessionReceiptSemanticIssue(records: readonly V2SessionRecord[]): SessionSemanticIssue | undefined {
  const requests = new Map<string, V2Base & ModelRequestReceipt>();
  const assistantRequests = new Set<string>();
  const historicalAssistantMessages = new Map<string, Extract<Message, { role: 'assistant' }>>();
  const plans = new Map<string, V2Base & ToolExecutionPlan>();
  const logicalExecutions = new Map<string, string>();
  const terminals = new Map<string, V2Base & (ToolExecutionCommit | ToolExecutionUnknown)>();
  const projectedTools = new Set<string>();
  let projectedMessages: Message[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const issue = (detail: string): SessionSemanticIssue => ({
      kind: 'receipt',
      line: index + 1,
      detail,
    });
    switch (record.t) {
      case 'session':
        break;
      case 'compaction': {
        const snapshotRequests = new Set<string>();
        const snapshotTools = new Set<string>();
        for (const message of record.messages) {
          if (message.role === 'assistant' && message.requestId) {
            if (!requests.has(message.requestId)) return issue(`compaction references missing request ${message.requestId}`);
            if (snapshotRequests.has(message.requestId)) return issue(`compaction duplicates assistant requestId ${message.requestId}`);
            const historical = historicalAssistantMessages.get(message.requestId);
            if (!historical || !assistantRequests.has(message.requestId)) {
              return issue(`compaction introduces assistant request without historical message ${message.requestId}`);
            }
            if (!sameAssistantProjection(historical, message)) {
              return issue(`compaction changes historical assistant request ${message.requestId}`);
            }
            snapshotRequests.add(message.requestId);
          } else if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
            return issue('compaction contains tool-bearing assistant without requestId');
          }
          if (message.role === 'tool' && message.executionId) {
            const terminal = terminals.get(message.executionId);
            if (!terminal || terminal.phase !== 'committed') {
              return issue(`compaction tool projection has no committed receipt ${message.executionId}`);
            }
            if (message.toolCallId !== terminal.result.callId) {
              return issue(`compaction tool callId mismatch for ${message.executionId}`);
            }
            if (snapshotTools.has(message.executionId)) return issue(`compaction duplicates tool projection ${message.executionId}`);
            if (!projectedTools.has(message.executionId)) {
              return issue(`compaction introduces tool projection without historical message ${message.executionId}`);
            }
            snapshotTools.add(message.executionId);
          } else if (message.role === 'tool') {
            return issue('compaction contains tool message without executionId');
          }
        }
        projectedMessages = [...record.messages];
        break;
      }
      case 'request': {
        if (requests.has(record.requestId)) return issue(`duplicate requestId ${record.requestId}`);
        if (record.messageCount !== projectedMessages.length || record.messagesHash !== digestValue(projectedMessages)) {
          return issue(`request message receipt mismatch for ${record.requestId}`);
        }
        requests.set(record.requestId, record);
        break;
      }
      case 'message': {
        const message = record.message;
        if (message.role === 'assistant' && message.requestId) {
          if (!requests.has(message.requestId)) return issue(`assistant references missing request ${message.requestId}`);
          if (assistantRequests.has(message.requestId)) return issue(`duplicate assistant requestId ${message.requestId}`);
          assistantRequests.add(message.requestId);
          historicalAssistantMessages.set(message.requestId, message);
        } else if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
          return issue('tool-bearing assistant message is missing requestId');
        }
        if (message.role === 'tool' && message.executionId) {
          if (projectedTools.has(message.executionId)) return issue(`duplicate tool projection ${message.executionId}`);
          const terminal = terminals.get(message.executionId);
          if (!terminal || terminal.phase !== 'committed') {
            return issue(`tool projection has no committed receipt ${message.executionId}`);
          }
          if (message.toolCallId !== terminal.result.callId) {
            return issue(`tool projection callId mismatch for ${message.executionId}`);
          }
          projectedTools.add(message.executionId);
        } else if (message.role === 'tool') {
          return issue('tool message is missing executionId');
        }
        projectedMessages.push(message);
        break;
      }
      case 'tool': {
        if (record.phase === 'planned') {
          if (plans.has(record.executionId)) return issue(`duplicate planned executionId ${record.executionId}`);
          const request = requests.get(record.requestId);
          if (!request) return issue(`planned tool references missing request ${record.requestId}`);
          if (request.runId !== record.runId || request.turn !== record.turn) {
            return issue(`planned tool request identity mismatch ${record.executionId}`);
          }
          const assistant = historicalAssistantMessages.get(record.requestId);
          const intended = assistant?.toolCalls?.[record.callIndex];
          if (!intended || !sameToolCall(intended, record.call)) {
            return issue(`planned tool does not match assistant intent ${record.executionId}`);
          }
          const logicalKey = `${record.requestId}:${record.callIndex}`;
          const priorExecution = logicalExecutions.get(logicalKey);
          if (priorExecution !== undefined) {
            return issue(`duplicate logical tool execution ${logicalKey} (${priorExecution}, ${record.executionId})`);
          }
          logicalExecutions.set(logicalKey, record.executionId);
          plans.set(record.executionId, record);
          break;
        }
        if (terminals.has(record.executionId)) return issue(`duplicate terminal executionId ${record.executionId}`);
        const plan = plans.get(record.executionId);
        if (!plan) return issue(`terminal receipt has no plan ${record.executionId}`);
        if (
          plan.requestId !== record.requestId
          || plan.runId !== record.runId
          || plan.turn !== record.turn
          || plan.callIndex !== record.callIndex
        ) {
          return issue(`terminal identity mismatch for ${record.executionId}`);
        }
        if (record.phase === 'committed' && record.result.callId !== plan.call.id) {
          return issue(`committed callId mismatch for ${record.executionId}`);
        }
        if (
          record.phase === 'committed'
          && record.result.fileReceipt?.kind === 'write'
          && record.result.fileReceipt.outcome === 'unknown'
        ) {
          return issue(`committed receipt contains unknown file effect ${record.executionId}`);
        }
        terminals.set(record.executionId, record);
        break;
      }
    }
  }
  return undefined;
}

function sameToolCall(left: ToolCall, right: ToolCall): boolean {
  return left.id === right.id && left.name === right.name && left.arguments === right.arguments;
}

function sameAssistantProjection(
  left: Extract<Message, { role: 'assistant' }>,
  right: Extract<Message, { role: 'assistant' }>,
): boolean {
  if (
    left.content !== right.content
    || left.reasoning !== right.reasoning
    || left.requestId !== right.requestId
  ) return false;
  const leftCalls = left.toolCalls ?? [];
  const rightCalls = right.toolCalls ?? [];
  return leftCalls.length === rightCalls.length
    && leftCalls.every((call, index) => sameToolCall(call, rightCalls[index]));
}

function assertSessionSemantics(records: readonly SessionRecord[]): void {
  const issue = sessionSemanticIssues(records)[0];
  if (issue) throw new Error(`session state is corrupt at record ${issue.line}: ${issue.detail}`);
}

function isV2Record(record: SessionRecord): record is V2SessionRecord {
  return 'schemaVersion' in record && record.schemaVersion === SESSION_SCHEMA_VERSION;
}

export async function latestSessionPath(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
  const sessions = entries.filter((entry) => entry.endsWith('.jsonl'));
  if (sessions.length === 0) return null;
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of sessions) {
    const full = join(dir, name);
    let info;
    try {
      // lstat keeps latest-session discovery from following a file symlink.
      // The selected id still passes through resolveSessionFilePath before read.
      info = await lstat(full);
    } catch (err) {
      if (isNotFoundError(err)) continue;
      throw err;
    }
    if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: info.mtimeMs };
  }
  return newest?.path ?? null;
}

function digestValue(value: unknown): string {
  const json = JSON.stringify(sortValue(value));
  return `sha256.${createHash('sha256').update(json).digest('base64url')}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
