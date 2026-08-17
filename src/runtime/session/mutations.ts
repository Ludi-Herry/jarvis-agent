/**
 * Write-side session mutations: fork, rename, archive, unarchive.
 *
 * Approved semantics (2026-08-18):
 * - fork is a full-fidelity copy: the v2/v1 header is rewritten to the new id
 *   (v2 gains `forkedFrom` lineage); request/tool receipts carry no session
 *   id, so they stay valid in the copy. A source with pending tool effects,
 *   a partially recorded v2 composition, or fail-closed damage is refused.
 * - rename is fork-to-new-id + archive-original: nothing is deleted and no
 *   existing log bytes are rewritten.
 * - archive moves the session file into `data/sessions/archived/` (content
 *   untouched) and moves its checkpoint audit alongside; unarchive reverses
 *   it. Archived ids are invisible to latest/list/resume resolution.
 *
 * Every mutation appends to the workspace-level append-only audit log
 * `data/session-mutations.jsonl` (planned before the write, created/failed/
 * blocked after) using the same confinement discipline as the checkpoint
 * audit. Drift between preview and write aborts before any byte is written.
 * Nothing here grants completion authority, touches resume resolution, or
 * deletes any file.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseJsonlWithDiagnostics } from '../jsonl-integrity.js';
import {
  isSessionRecord,
  loadSessionLog,
  replaySession,
  resolveSessionFilePath,
  serializeRecord,
  validateSessionId,
  type SessionRecord,
} from './session-store.js';

// ---------------------------------------------------------------------------
// Mutation audit log
// ---------------------------------------------------------------------------

export const SESSION_MUTATION_KINDS = ['fork', 'archive', 'unarchive', 'rename'] as const;
export type SessionMutationKind = (typeof SESSION_MUTATION_KINDS)[number];
export const SESSION_MUTATION_OUTCOMES = ['planned', 'created', 'failed', 'blocked'] as const;
export type SessionMutationOutcome = (typeof SESSION_MUTATION_OUTCOMES)[number];

export interface SessionMutationRecord {
  schemaVersion: 1;
  seq: number;
  at: string;
  t: 'session-mutation';
  mutationId: string;
  kind: SessionMutationKind;
  sourceSessionId: string;
  targetSessionId?: string;
  outcome: SessionMutationOutcome;
  reason?: string;
}

const MAX_REASON_CHARS = 500;

export function isSessionMutationRecord(value: unknown): value is SessionMutationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && Number.isInteger(record.seq) && (record.seq as number) >= 1
    && typeof record.at === 'string'
    && record.t === 'session-mutation'
    && typeof record.mutationId === 'string'
    && (SESSION_MUTATION_KINDS as readonly unknown[]).includes(record.kind)
    && typeof record.sourceSessionId === 'string'
    && (record.targetSessionId === undefined || typeof record.targetSessionId === 'string')
    && (SESSION_MUTATION_OUTCOMES as readonly unknown[]).includes(record.outcome)
    && (record.reason === undefined || typeof record.reason === 'string');
}

export interface SessionMutationLogParse {
  records: SessionMutationRecord[];
  issues: Array<{ kind: string; line: number }>;
}

export function parseSessionMutationLog(text: string): SessionMutationLogParse {
  const parsed = parseJsonlWithDiagnostics(text, isSessionMutationRecord);
  return { records: parsed.records, issues: parsed.malformed };
}

/** Fail-closed operational gate: any non-tail damage is corruption; a
 * truncated tail only blocks appends (the next record must not overwrite it). */
export function assertSessionMutationLogOperational(
  parsed: SessionMutationLogParse,
  options: { requireAppendSafe: boolean },
): void {
  const unsafe = parsed.issues.find((issue) => issue.kind !== 'malformed-tail');
  if (unsafe) throw new Error(`session mutation log is corrupt at line ${unsafe.line} (${unsafe.kind})`);
  const tail = parsed.issues.find((issue) => issue.kind === 'malformed-tail');
  if (tail && options.requireAppendSafe) {
    throw new Error(`session mutation log has a truncated tail at line ${tail.line}; refusing append`);
  }
  for (let index = 0; index < parsed.records.length; index += 1) {
    if (parsed.records[index].seq !== index + 1) {
      throw new Error(`session mutation log sequence mismatch at record ${index + 1}`);
    }
  }
}

export interface SessionMutationAppendInput {
  kind: SessionMutationKind;
  sourceSessionId: string;
  targetSessionId?: string;
  outcome: SessionMutationOutcome;
  reason?: string;
}

export interface SessionMutationStore {
  append(input: SessionMutationAppendInput): Promise<SessionMutationRecord>;
}

export class FileSessionMutationStore implements SessionMutationStore {
  private readonly now: () => string;
  private readonly createId: () => string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: { cwd: string; now?: () => string; createId?: () => string }) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => `mut-${randomUUID()}`);
  }

  append(input: SessionMutationAppendInput): Promise<SessionMutationRecord> {
    let result!: SessionMutationRecord;
    const action = async (): Promise<void> => {
      const path = await resolveMutationLogPath(this.options.cwd, true);
      let text = '';
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      const parsed = parseSessionMutationLog(text);
      assertSessionMutationLogOperational(parsed, { requireAppendSafe: true });
      result = {
        schemaVersion: 1,
        seq: parsed.records.length + 1,
        at: this.now(),
        t: 'session-mutation',
        mutationId: this.createId(),
        kind: input.kind,
        sourceSessionId: input.sourceSessionId,
        ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
        outcome: input.outcome,
        ...(input.reason === undefined ? {} : { reason: boundedReason(input.reason) }),
      };
      await appendFile(path, `${JSON.stringify(result)}\n`, 'utf8');
    };
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run.then(() => result);
  }
}

async function resolveMutationLogPath(cwd: string, create: boolean): Promise<string> {
  const path = join(cwd, 'data', 'session-mutations.jsonl');
  const canonicalCwd = await realpath(cwd);
  const dataDir = join(cwd, 'data');
  await ensureSafeDirectory(dataDir, create);
  const canonicalData = await realpath(dataDir);
  assertContained(canonicalCwd, canonicalData, 'data directory escapes cwd');
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('session mutation log path must be a regular non-reparse file');
    }
    if (info.nlink !== 1) throw new Error('session mutation log path must not be a hard link');
    const canonicalFile = await realpath(path);
    assertContained(canonicalData, canonicalFile, 'session mutation log path escapes data/');
  } catch (err) {
    if (!isNotFound(err) || !create) throw err;
  }
  return path;
}

async function ensureSafeDirectory(path: string, create: boolean): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (!isNotFound(err) || !create) throw err;
    await mkdir(path);
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`mutation path component must be a regular directory: ${path}`);
  }
}

function assertContained(parent: string, child: string, reason: string): void {
  const local = relative(resolve(parent), resolve(child));
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(reason);
}

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

export interface SessionMutationIoOptions {
  now?: () => string;
  createMutationId?: () => string;
  createForkId?: () => string;
  mutationStore?: SessionMutationStore;
  /** Test-only seam invoked immediately after the move rename() lands. */
  afterMove?: (paths: { from: string; to: string }) => Promise<void>;
}

export type ForkSessionResult =
  | { status: 'invalid'; reason: string }
  | { status: 'not-found'; sessionId: string }
  | { status: 'corrupt'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'created'; forkSessionId: string; path: string; recordCount: number; format: 'v1' | 'v2' };

export async function forkSession(input: {
  cwd: string;
  sourceSessionId: string;
  targetSessionId?: string;
  io?: SessionMutationIoOptions;
}): Promise<ForkSessionResult> {
  const sourceCheck = validateSessionId(input.sourceSessionId);
  if (!sourceCheck.ok) return { status: 'invalid', reason: sourceCheck.reason };
  const resolution = await resolveSessionFilePath({ cwd: input.cwd, sessionId: input.sourceSessionId });
  if (resolution.status === 'invalid-session-id') return { status: 'invalid', reason: resolution.reason };
  if (resolution.status === 'not-found') return { status: 'not-found', sessionId: input.sourceSessionId };
  if (resolution.status !== 'ok') return { status: 'corrupt', reason: resolution.reason };

  let rawBefore: string;
  try {
    rawBefore = await readFile(resolution.path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return { status: 'not-found', sessionId: input.sourceSessionId };
    return { status: 'corrupt', reason: `cannot read source session: ${describeError(err)}` };
  }
  let loaded;
  try {
    loaded = await loadSessionLog(resolution.path, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: input.sourceSessionId,
    });
  } catch (err) {
    return { status: 'corrupt', reason: describeError(err) };
  }
  let rawAfter: string;
  try {
    rawAfter = await readFile(resolution.path, 'utf8');
  } catch (err) {
    return { status: 'blocked', reason: `cannot re-read source session: ${describeError(err)}` };
  }
  if (rawAfter !== rawBefore) {
    return { status: 'blocked', reason: 'source session changed during fork preview' };
  }

  const header = loaded.loaded.header;
  if (header === undefined) return { status: 'corrupt', reason: 'source session has no header' };
  if (loaded.loaded.pendingTools.length > 0) {
    return {
      status: 'refused',
      reason: `${loaded.loaded.pendingTools.length} pending tool effect(s) need manual review before any fork`,
    };
  }
  if (loaded.loaded.format === 'v2' && 'composition' in header) {
    const composition = header.composition;
    if (composition.coverage !== 'full'
      || composition.dynamicAddendumSource === undefined
      || composition.dynamicAddendumManifestHash === undefined) {
      return { status: 'refused', reason: 'fork requires a fully recorded v2 session composition' };
    }
  } else if (loaded.loaded.format !== 'v1') {
    return { status: 'corrupt', reason: 'source session format is not a recognized v1/v2 log' };
  }

  const targetSessionId = input.targetSessionId
    ?? input.io?.createForkId?.()
    ?? `fork-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const targetCheck = validateSessionId(targetSessionId);
  if (!targetCheck.ok) return { status: 'invalid', reason: targetCheck.reason };
  if (targetSessionId === input.sourceSessionId) {
    return { status: 'invalid', reason: 'fork target id must differ from the source session id' };
  }
  const targetActive = await resolveSessionFilePath({ cwd: input.cwd, sessionId: targetSessionId });
  if (targetActive.status === 'ok') {
    return { status: 'invalid', reason: `target session id already exists: ${targetSessionId}` };
  }
  if (targetActive.status !== 'not-found') {
    return { status: 'blocked', reason: `cannot verify target path is free: ${targetActive.reason}` };
  }
  const targetArchived = await resolveSessionFilePath({ cwd: input.cwd, sessionId: targetSessionId, scope: 'archived' });
  if (targetArchived.status === 'ok') {
    return { status: 'invalid', reason: `target session id already exists in the archive: ${targetSessionId}` };
  }
  if (targetArchived.status !== 'not-found') {
    return { status: 'blocked', reason: `cannot verify archived target path is free: ${targetArchived.reason}` };
  }

  const headerRecord = loaded.records[0];
  if (headerRecord === undefined || headerRecord.t !== 'session') {
    return { status: 'corrupt', reason: 'source session has no header record' };
  }
  const forkHeader: SessionRecord = 'schemaVersion' in headerRecord
    ? { ...headerRecord, id: targetSessionId, forkedFrom: input.sourceSessionId }
    : { ...headerRecord, id: targetSessionId };
  const serialized = [forkHeader, ...loaded.records.slice(1)].map((record) => serializeRecord(record)).join('');

  const store = input.io?.mutationStore ?? new FileSessionMutationStore({ cwd: input.cwd, now: input.io?.now, createId: input.io?.createMutationId });
  try {
    await store.append({ kind: 'fork', sourceSessionId: input.sourceSessionId, targetSessionId, outcome: 'planned' });
  } catch (err) {
    return { status: 'failed', reason: `cannot append mutation audit before fork: ${describeError(err)}` };
  }

  const forkPath = join(dirname(resolution.path), `${targetSessionId}.jsonl`);
  try {
    const rawFinal = await readFile(resolution.path, 'utf8');
    if (rawFinal !== rawBefore) {
      await appendOutcomeBestEffort(store, 'fork', input.sourceSessionId, targetSessionId, 'blocked', 'source session changed while creating fork');
      return { status: 'blocked', reason: 'source session changed while creating fork' };
    }
    await writeFile(forkPath, serialized, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'EEXIST') {
      await appendOutcomeBestEffort(store, 'fork', input.sourceSessionId, targetSessionId, 'blocked', 'target appeared during fork');
      return { status: 'invalid', reason: `target session id already exists: ${targetSessionId}` };
    }
    await appendOutcomeBestEffort(store, 'fork', input.sourceSessionId, targetSessionId, 'failed', describeError(err));
    return { status: 'failed', reason: `cannot write fork: ${describeError(err)}` };
  }
  const written = await readFile(forkPath, 'utf8');
  if (written !== serialized) {
    await appendOutcomeBestEffort(store, 'fork', input.sourceSessionId, targetSessionId, 'failed', 'fork content mismatch after write');
    return { status: 'failed', reason: 'fork content mismatch after write' };
  }
  try {
    await store.append({ kind: 'fork', sourceSessionId: input.sourceSessionId, targetSessionId, outcome: 'created' });
  } catch (err) {
    return { status: 'failed', reason: `fork created but the mutation audit append failed: ${describeError(err)}` };
  }
  return {
    status: 'created',
    forkSessionId: targetSessionId,
    path: forkPath,
    recordCount: loaded.records.length,
    format: loaded.loaded.format === 'v2' ? 'v2' : 'v1',
  };
}

// ---------------------------------------------------------------------------
// archive / unarchive
// ---------------------------------------------------------------------------

export type MoveSessionResult =
  | { status: 'invalid'; reason: string }
  | { status: 'not-found'; sessionId: string }
  | { status: 'corrupt'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string }
  | {
    status: 'moved';
    sessionId: string;
    from: string;
    to: string;
    warnings: string[];
    pendingToolEffects?: number;
  };

export async function moveSession(input: {
  cwd: string;
  sessionId: string;
  direction: 'archive' | 'unarchive';
  io?: SessionMutationIoOptions;
}): Promise<MoveSessionResult> {
  const idCheck = validateSessionId(input.sessionId);
  if (!idCheck.ok) return { status: 'invalid', reason: idCheck.reason };
  const sourceScope = input.direction === 'archive' ? 'active' : 'archived';
  const destScope = input.direction === 'archive' ? 'archived' : 'active';

  const source = await resolveSessionFilePath({ cwd: input.cwd, sessionId: input.sessionId, scope: sourceScope });
  if (source.status === 'invalid-session-id') return { status: 'invalid', reason: source.reason };
  if (source.status === 'not-found') {
    const elsewhere = await resolveSessionFilePath({ cwd: input.cwd, sessionId: input.sessionId, scope: destScope });
    if (elsewhere.status === 'ok') {
      return {
        status: 'invalid',
        reason: input.direction === 'archive'
          ? `session is already archived: ${input.sessionId}`
          : `session is not archived: ${input.sessionId}`,
      };
    }
    return { status: 'not-found', sessionId: input.sessionId };
  }
  if (source.status !== 'ok') return { status: 'corrupt', reason: source.reason };

  const dest = await resolveSessionFilePath({ cwd: input.cwd, sessionId: input.sessionId, scope: destScope });
  if (dest.status === 'ok') {
    return {
      status: 'invalid',
      reason: `cannot ${input.direction}: a session file already exists at the destination for ${input.sessionId}`,
    };
  }
  if (dest.status !== 'not-found') return { status: 'corrupt', reason: dest.reason };

  let rawBefore: string;
  try {
    rawBefore = await readFile(source.path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return { status: 'not-found', sessionId: input.sessionId };
    return { status: 'corrupt', reason: `cannot read session file: ${describeError(err)}` };
  }
  const fingerprintBefore = fingerprint(rawBefore);
  // Content-agnostic pending-effect warning (archive keeps damaged sessions movable).
  const pendingToolEffects = countPendingToolsBestEffort(rawBefore);

  const store = input.io?.mutationStore ?? new FileSessionMutationStore({ cwd: input.cwd, now: input.io?.now, createId: input.io?.createMutationId });
  try {
    await store.append({ kind: input.direction, sourceSessionId: input.sessionId, outcome: 'planned' });
  } catch (err) {
    return { status: 'failed', reason: `cannot append mutation audit before ${input.direction}: ${describeError(err)}` };
  }

  const destPath = dest.path;
  try {
    await ensureSafeDirectory(dirname(destPath), true);
    await rename(source.path, destPath);
    if (input.io?.afterMove !== undefined) await input.io.afterMove({ from: source.path, to: destPath });
  } catch (err) {
    await appendOutcomeBestEffort(store, input.direction, input.sessionId, undefined, 'failed', describeError(err));
    return { status: 'failed', reason: `cannot move session file: ${describeError(err)}` };
  }

  const warnings: string[] = [];
  const sourceReappeared = await pathExists(source.path);
  if (sourceReappeared === true) {
    await appendOutcomeBestEffort(
      store,
      input.direction,
      input.sessionId,
      undefined,
      'blocked',
      'source path reappeared after the move; a live writer may be active',
    );
    return {
      status: 'blocked',
      reason: `source path reappeared after the move; a live writer may be active (the moved copy is intact at ${destPath})`,
    };
  }
  if (sourceReappeared === undefined) {
    warnings.push('cannot confirm the source path is gone after the move');
  }
  try {
    const rawMoved = await readFile(destPath, 'utf8');
    if (fingerprint(rawMoved) !== fingerprintBefore) {
      await appendOutcomeBestEffort(store, input.direction, input.sessionId, undefined, 'failed', 'moved content mismatch');
      return { status: 'failed', reason: 'moved session content does not match the pre-move fingerprint' };
    }
  } catch (err) {
    await appendOutcomeBestEffort(store, input.direction, input.sessionId, undefined, 'failed', describeError(err));
    return { status: 'failed', reason: `cannot verify the moved session file: ${describeError(err)}` };
  }

  const auditWarning = await moveCheckpointAudit(input.cwd, input.sessionId, input.direction);
  if (auditWarning !== undefined) warnings.push(auditWarning);

  try {
    await store.append({ kind: input.direction, sourceSessionId: input.sessionId, outcome: 'created' });
  } catch (err) {
    warnings.push(`move completed but the mutation audit append failed: ${describeError(err)}`);
  }
  return {
    status: 'moved',
    sessionId: input.sessionId,
    from: source.path,
    to: destPath,
    warnings,
    ...(pendingToolEffects > 0 ? { pendingToolEffects } : {}),
  };
}

/** Move `data/checkpoints/<id>.jsonl` alongside the session. Missing audit is
 * normal (session without checkpoints); a failed move is a warning, never a
 * rollback of the session move. */
async function moveCheckpointAudit(
  cwd: string,
  sessionId: string,
  direction: 'archive' | 'unarchive',
): Promise<string | undefined> {
  const checkpointsDir = join(cwd, 'data', 'checkpoints');
  const archivedDir = join(checkpointsDir, 'archived');
  const from = direction === 'archive'
    ? join(checkpointsDir, `${sessionId}.jsonl`)
    : join(archivedDir, `${sessionId}.jsonl`);
  const to = direction === 'archive'
    ? join(archivedDir, `${sessionId}.jsonl`)
    : join(checkpointsDir, `${sessionId}.jsonl`);
  let info;
  try {
    info = await lstat(from);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    return `cannot inspect the checkpoint audit file: ${describeError(err)}`;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return 'checkpoint audit path is not a regular non-reparse file; left in place';
  }
  try {
    await lstat(to);
    return 'checkpoint audit destination already exists; left in place';
  } catch (err) {
    if (!isNotFound(err)) return `cannot inspect the checkpoint audit destination: ${describeError(err)}`;
  }
  try {
    await ensureSafeDirectory(dirname(to), true);
    await rename(from, to);
  } catch (err) {
    return `cannot move the checkpoint audit file: ${describeError(err)}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// rename = fork + archive
// ---------------------------------------------------------------------------

export type RenameSessionResult =
  | { status: 'invalid'; reason: string }
  | { status: 'not-found'; sessionId: string }
  | { status: 'corrupt'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'partial'; reason: string; forkSessionId: string }
  | {
    status: 'renamed';
    from: string;
    to: string;
    forkPath: string;
    archivedPath: string;
    warnings: string[];
  };

export async function renameSession(input: {
  cwd: string;
  sourceSessionId: string;
  newSessionId: string;
  io?: SessionMutationIoOptions;
}): Promise<RenameSessionResult> {
  const newCheck = validateSessionId(input.newSessionId);
  if (!newCheck.ok) return { status: 'invalid', reason: newCheck.reason };
  if (input.newSessionId === input.sourceSessionId) {
    return { status: 'invalid', reason: 'rename target id must differ from the source session id' };
  }
  const store = input.io?.mutationStore ?? new FileSessionMutationStore({ cwd: input.cwd, now: input.io?.now, createId: input.io?.createMutationId });

  const forked = await forkSession({
    cwd: input.cwd,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.newSessionId,
    io: { ...input.io, mutationStore: store },
  });
  if (forked.status !== 'created') return forked;

  const archived = await moveSession({
    cwd: input.cwd,
    sessionId: input.sourceSessionId,
    direction: 'archive',
    io: { ...input.io, mutationStore: store },
  });
  if (archived.status !== 'moved') {
    const reason = `fork to ${forked.forkSessionId} succeeded but archiving the source failed: ${
      'reason' in archived ? archived.reason : archived.status
    }`;
    await appendOutcomeBestEffort(store, 'rename', input.sourceSessionId, input.newSessionId, 'failed', reason);
    return { status: 'partial', reason, forkSessionId: forked.forkSessionId };
  }
  try {
    await store.append({
      kind: 'rename',
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.newSessionId,
      outcome: 'created',
    });
  } catch (err) {
    return {
      status: 'renamed',
      from: input.sourceSessionId,
      to: input.newSessionId,
      forkPath: forked.path,
      archivedPath: archived.to,
      warnings: [...archived.warnings, `rename completed but the summary audit append failed: ${describeError(err)}`],
    };
  }
  return {
    status: 'renamed',
    from: input.sourceSessionId,
    to: input.newSessionId,
    forkPath: forked.path,
    archivedPath: archived.to,
    warnings: archived.warnings,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function countPendingToolsBestEffort(raw: string): number {
  try {
    const parsed = parseJsonlWithDiagnostics(raw, isSessionRecord);
    return replaySession(parsed.records).pendingTools.length;
  } catch {
    return 0;
  }
}

async function appendOutcomeBestEffort(
  store: SessionMutationStore,
  kind: SessionMutationKind,
  sourceSessionId: string,
  targetSessionId: string | undefined,
  outcome: SessionMutationOutcome,
  reason: string,
): Promise<void> {
  try {
    await store.append({
      kind,
      sourceSessionId,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
      outcome,
      reason,
    });
  } catch {
    // Preserve the operational failure; the audit append must never hide it.
  }
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** true = exists, false = gone, undefined = cannot tell. */
async function pathExists(path: string): Promise<boolean | undefined> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    return undefined;
  }
}

function boundedReason(reason: string): string {
  return Array.from(reason.slice(0, MAX_REASON_CHARS), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }).join('');
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
