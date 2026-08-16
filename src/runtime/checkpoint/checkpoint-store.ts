import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isJsonObject,
  parseJsonlWithDiagnostics,
  type JsonlMalformedLine,
} from '../jsonl-integrity.js';
import { validateSessionId } from '../session/session-store.js';

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const MAX_CHECKPOINT_REASON_LENGTH = 512;
const MAX_CHECKPOINT_TIMESTAMP_LENGTH = 128;
const MAX_CHECKPOINT_CWD_LENGTH = 4_096;

export type CheckpointPhase = 'before-user-prompt' | 'before-model-wave' | 'manual';
export type CheckpointExternalEffects = 'none-observed' | 'possible' | 'unknown';
export type CheckpointRewindMode = 'conversation' | 'conversation-and-files';
export type CheckpointRewindOutcome = 'planned' | 'created' | 'declined' | 'blocked' | 'failed';

export interface CheckpointCursor {
  sessionSeq: number;
  recordCount: number;
  messageCount: number;
}

export type CheckpointShadow =
  | { status: 'captured'; ref: string }
  | { status: 'unavailable'; reason: string };

export interface CheckpointEffects {
  managedFileWrites: number;
  external: CheckpointExternalEffects;
  canRewindConversation: boolean;
  canRewindFiles: boolean;
}

interface CheckpointAuditBase {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  seq: number;
  at: string;
}

export interface CheckpointCreatedRecord extends CheckpointAuditBase {
  t: 'checkpoint';
  checkpointId: string;
  sessionId: string;
  cwd: string;
  phase: CheckpointPhase;
  cursor: CheckpointCursor;
  shadow: CheckpointShadow;
  effects: CheckpointEffects;
}

export interface CheckpointRewindRecord extends CheckpointAuditBase {
  t: 'rewind';
  rewindId: string;
  checkpointId: string;
  sourceSessionId: string;
  forkSessionId?: string;
  mode: CheckpointRewindMode;
  outcome: CheckpointRewindOutcome;
  reason?: string;
}

export type CheckpointAuditRecord = CheckpointCreatedRecord | CheckpointRewindRecord;

export interface CheckpointAuditParseResult {
  records: CheckpointAuditRecord[];
  issues: JsonlMalformedLine[];
}

export interface CheckpointAuditLoadResult extends CheckpointAuditParseResult {
  path: string;
}

export interface CheckpointAppendInput {
  phase: CheckpointPhase;
  cursor: CheckpointCursor;
  shadow: CheckpointShadow;
  effects: CheckpointEffects;
}

export interface RewindAuditInput {
  rewindId: string;
  checkpointId: string;
  sourceSessionId: string;
  forkSessionId?: string;
  mode: CheckpointRewindMode;
  outcome: CheckpointRewindOutcome;
  reason?: string;
}

export interface FileCheckpointAuditStoreOptions {
  cwd: string;
  sessionId: string;
  now?: () => string;
  createId?: () => string;
  readText?: (path: string) => Promise<string>;
  appendText?: (path: string, text: string) => Promise<void>;
}

export interface CheckpointAuditOperationalOptions {
  requireAppendSafe: boolean;
  expectedSessionId?: string;
}

/** Checkpoint ids deliberately share the cross-platform filename-safe Session language. */
export function validateCheckpointId(id: string): ReturnType<typeof validateSessionId> {
  return validateSessionId(id);
}

export function checkpointAuditPath(cwd: string, sessionId: string): string {
  const check = validateSessionId(sessionId);
  if (!check.ok) throw new Error(check.reason);
  return join(cwd, 'data', 'checkpoints', `${sessionId}.jsonl`);
}

export function parseCheckpointAudit(text: string): CheckpointAuditParseResult {
  const parsed = parseJsonlWithDiagnostics(text, isCheckpointAuditRecord);
  return { records: parsed.records, issues: parsed.malformed };
}

export function assertCheckpointAuditOperational(
  parsed: CheckpointAuditParseResult,
  options: CheckpointAuditOperationalOptions,
): void {
  const unsafe = parsed.issues.find((issue) => issue.kind !== 'malformed-tail');
  if (unsafe) throw new Error(`checkpoint audit is corrupt at line ${unsafe.line} (${unsafe.kind})`);
  const tail = parsed.issues.find((issue) => issue.kind === 'malformed-tail');
  if (tail && options.requireAppendSafe) {
    throw new Error(`checkpoint audit has a truncated tail at line ${tail.line}; refusing append`);
  }

  const checkpointIds = new Set<string>();
  let sessionId = options.expectedSessionId;
  for (let index = 0; index < parsed.records.length; index++) {
    const record = parsed.records[index];
    if (record.seq !== index + 1) {
      throw new Error(`checkpoint audit sequence mismatch at record ${index + 1}`);
    }
    if (record.t === 'checkpoint') {
      if (checkpointIds.has(record.checkpointId)) {
        throw new Error(`checkpoint audit has duplicate checkpoint id at record ${index + 1}`);
      }
      checkpointIds.add(record.checkpointId);
      sessionId ??= record.sessionId;
      if (record.sessionId !== sessionId) {
        throw new Error(`checkpoint audit session identity mismatch at record ${index + 1}`);
      }
    } else {
      if (!checkpointIds.has(record.checkpointId)) {
        throw new Error(`checkpoint audit rewind references an unrecorded checkpoint at record ${index + 1}`);
      }
      if (sessionId !== undefined && record.sourceSessionId !== sessionId) {
        throw new Error(`checkpoint audit rewind identity mismatch at record ${index + 1}`);
      }
    }
  }
}

export async function loadCheckpointAudit(input: {
  cwd: string;
  sessionId: string;
  readText?: (path: string) => Promise<string>;
}): Promise<CheckpointAuditLoadResult> {
  const path = await resolveCheckpointAuditPath(input.cwd, input.sessionId, false);
  const text = await (input.readText ?? readUtf8)(path);
  const parsed = parseCheckpointAudit(text);
  assertCheckpointAuditOperational(parsed, {
    requireAppendSafe: false,
    expectedSessionId: input.sessionId,
  });
  return { path, ...parsed };
}

export class FileCheckpointAuditStore {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly readText: (path: string) => Promise<string>;
  private readonly appendText: (path: string, text: string) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileCheckpointAuditStoreOptions) {
    const sessionCheck = validateSessionId(options.sessionId);
    if (!sessionCheck.ok) throw new Error(sessionCheck.reason);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => `cp-${randomUUID()}`);
    this.readText = options.readText ?? readUtf8;
    this.appendText = options.appendText ?? appendUtf8;
  }

  appendCheckpoint(input: CheckpointAppendInput): Promise<CheckpointCreatedRecord> {
    validateCheckpointInput(input);
    const checkpointId = this.createId();
    const idCheck = validateCheckpointId(checkpointId);
    if (!idCheck.ok) return Promise.reject(new Error(idCheck.reason));
    return this.append((seq): CheckpointCreatedRecord => ({
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      seq,
      at: this.now(),
      t: 'checkpoint',
      checkpointId,
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
      phase: input.phase,
      cursor: { ...input.cursor },
      shadow: normalizeShadow(input.shadow),
      effects: { ...input.effects },
    }));
  }

  appendRewind(input: RewindAuditInput): Promise<CheckpointRewindRecord> {
    validateRewindInput(input);
    return this.append((seq): CheckpointRewindRecord => ({
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      seq,
      at: this.now(),
      t: 'rewind',
      rewindId: input.rewindId,
      checkpointId: input.checkpointId,
      sourceSessionId: input.sourceSessionId,
      ...(input.forkSessionId === undefined ? {} : { forkSessionId: input.forkSessionId }),
      mode: input.mode,
      outcome: input.outcome,
      ...(input.reason === undefined ? {} : { reason: boundedInline(input.reason) }),
    }));
  }

  private append<T extends CheckpointAuditRecord>(build: (seq: number) => T): Promise<T> {
    let result!: T;
    const action = async (): Promise<void> => {
      const path = await resolveCheckpointAuditPath(this.options.cwd, this.options.sessionId, true);
      let text = '';
      try {
        text = await this.readText(path);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
      const parsed = parseCheckpointAudit(text);
      assertCheckpointAuditOperational(parsed, {
        requireAppendSafe: true,
        expectedSessionId: this.options.sessionId,
      });
      result = build(parsed.records.length + 1);
      if (!isCheckpointAuditRecord(result)) {
        throw new Error('checkpoint audit record exceeds its bounded schema');
      }
      await this.appendText(path, `${JSON.stringify(result)}\n`);
    };
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run.then(() => result);
  }
}

async function resolveCheckpointAuditPath(cwd: string, sessionId: string, create: boolean): Promise<string> {
  const path = checkpointAuditPath(cwd, sessionId);
  const canonicalCwd = await realpath(cwd);
  const dataDir = join(cwd, 'data');
  const checkpointsDir = join(dataDir, 'checkpoints');
  await ensureSafeDirectory(dataDir, create);
  await ensureSafeDirectory(checkpointsDir, create);
  const canonicalCheckpoints = await realpath(checkpointsDir);
  assertContained(canonicalCwd, canonicalCheckpoints, 'checkpoint directory escapes cwd');

  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('checkpoint audit path must be a regular non-reparse file');
    }
    if (info.nlink !== 1) throw new Error('checkpoint audit path must not be a hard link');
    const canonicalFile = await realpath(path);
    assertContained(canonicalCheckpoints, canonicalFile, 'checkpoint audit path escapes data/checkpoints');
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    if (!create) throw err;
  }
  return path;
}

async function ensureSafeDirectory(path: string, create: boolean): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (!isNotFoundError(err) || !create) throw err;
    await mkdir(path);
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`checkpoint path component must be a regular directory: ${path}`);
  }
}

function assertContained(parent: string, child: string, reason: string): void {
  const local = relative(resolve(parent), resolve(child));
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(reason);
}

function validateCheckpointInput(input: CheckpointAppendInput): void {
  if (!['before-user-prompt', 'before-model-wave', 'manual'].includes(input.phase)) {
    throw new Error('invalid checkpoint phase');
  }
  for (const [name, value] of Object.entries(input.cursor)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid checkpoint cursor ${name}`);
  }
  if (!Number.isInteger(input.effects.managedFileWrites) || input.effects.managedFileWrites < 0) {
    throw new Error('invalid managed file-write count');
  }
  if (!['none-observed', 'possible', 'unknown'].includes(input.effects.external)) {
    throw new Error('invalid checkpoint external-effect summary');
  }
  normalizeShadow(input.shadow);
}

function validateRewindInput(input: RewindAuditInput): void {
  for (const id of [input.rewindId, input.checkpointId, input.sourceSessionId, input.forkSessionId]) {
    if (id === undefined) continue;
    const check = validateCheckpointId(id);
    if (!check.ok) throw new Error(check.reason);
  }
  if (!['conversation', 'conversation-and-files'].includes(input.mode)) throw new Error('invalid rewind mode');
  if (!['planned', 'created', 'declined', 'blocked', 'failed'].includes(input.outcome)) {
    throw new Error('invalid rewind outcome');
  }
}

function normalizeShadow(shadow: CheckpointShadow): CheckpointShadow {
  if (shadow.status === 'captured') {
    if (!/^[a-f0-9]{40}$/u.test(shadow.ref)) throw new Error('invalid checkpoint shadow ref');
    return { status: 'captured', ref: shadow.ref };
  }
  if (shadow.status !== 'unavailable') throw new Error('invalid checkpoint shadow status');
  return { status: 'unavailable', reason: boundedInline(shadow.reason) };
}

function isCheckpointAuditRecord(value: unknown): value is CheckpointAuditRecord {
  if (!isJsonObject(value)
    || !hasCheckpointAuditKeys(value)
    || value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
    || !isNonNegativeInteger(value.seq, 1)
    || typeof value.at !== 'string'
    || value.at.length > MAX_CHECKPOINT_TIMESTAMP_LENGTH) return false;
  if (value.t === 'checkpoint') return isCheckpointCreatedRecord(value);
  if (value.t === 'rewind') return isCheckpointRewindRecord(value);
  return false;
}

function isCheckpointCreatedRecord(value: Record<string, unknown>): boolean {
  if (typeof value.checkpointId !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.cwd !== 'string'
    || value.cwd.length > MAX_CHECKPOINT_CWD_LENGTH
    || !['before-user-prompt', 'before-model-wave', 'manual'].includes(String(value.phase))
    || !isJsonObject(value.cursor)
    || !isJsonObject(value.shadow)
    || !isJsonObject(value.effects)) return false;
  if (!validateCheckpointId(value.checkpointId).ok || !validateSessionId(value.sessionId).ok) return false;
  if (!hasExactKeys(value.cursor, ['sessionSeq', 'recordCount', 'messageCount'])
    || !isNonNegativeInteger(value.cursor.sessionSeq)
    || !isNonNegativeInteger(value.cursor.recordCount)
    || !isNonNegativeInteger(value.cursor.messageCount)) return false;
  if (value.shadow.status === 'captured') {
    if (!hasExactKeys(value.shadow, ['status', 'ref'])
      || typeof value.shadow.ref !== 'string' || !/^[a-f0-9]{40}$/u.test(value.shadow.ref)) return false;
  } else if (value.shadow.status === 'unavailable') {
    if (!hasExactKeys(value.shadow, ['status', 'reason'])
      || typeof value.shadow.reason !== 'string' || value.shadow.reason.length > MAX_CHECKPOINT_REASON_LENGTH) return false;
  } else return false;
  return hasExactKeys(value.effects, ['managedFileWrites', 'external', 'canRewindConversation', 'canRewindFiles'])
    && isNonNegativeInteger(value.effects.managedFileWrites)
    && ['none-observed', 'possible', 'unknown'].includes(String(value.effects.external))
    && typeof value.effects.canRewindConversation === 'boolean'
    && typeof value.effects.canRewindFiles === 'boolean';
}

function isCheckpointRewindRecord(value: Record<string, unknown>): boolean {
  if (typeof value.rewindId !== 'string'
    || typeof value.checkpointId !== 'string'
    || typeof value.sourceSessionId !== 'string'
    || (value.forkSessionId !== undefined && typeof value.forkSessionId !== 'string')
    || !['conversation', 'conversation-and-files'].includes(String(value.mode))
    || !['planned', 'created', 'declined', 'blocked', 'failed'].includes(String(value.outcome))
    || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > MAX_CHECKPOINT_REASON_LENGTH))) {
    return false;
  }
  return [value.rewindId, value.checkpointId, value.sourceSessionId, value.forkSessionId]
    .every((id) => id === undefined || (typeof id === 'string' && validateCheckpointId(id).ok));
}

function hasCheckpointAuditKeys(value: Record<string, unknown>): boolean {
  if (value.t === 'checkpoint') {
    return hasExactKeys(value, [
      'schemaVersion', 'seq', 'at', 't', 'checkpointId', 'sessionId', 'cwd', 'phase', 'cursor', 'shadow', 'effects',
    ]);
  }
  if (value.t === 'rewind') {
    return hasOptionalExactKeys(
      value,
      ['schemaVersion', 'seq', 'at', 't', 'rewindId', 'checkpointId', 'sourceSessionId', 'mode', 'outcome'],
      ['forkSessionId', 'reason'],
    );
  }
  return false;
}

function hasOptionalExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const expected = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function isNonNegativeInteger(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) && (value as number) >= minimum;
}

function boundedInline(value: string): string {
  const inert = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 32;
    const unsafe = code < 0x20
      || (code >= 0x7f && code <= 0x9f)
      || code === 0x061c
      || code === 0x200e
      || code === 0x200f
      || code === 0x2028
      || code === 0x2029
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069);
    return unsafe ? ' ' : character;
  }).join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return inert.slice(0, MAX_CHECKPOINT_REASON_LENGTH);
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

async function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function appendUtf8(path: string, text: string): Promise<void> {
  await appendFile(path, text, 'utf8');
}
