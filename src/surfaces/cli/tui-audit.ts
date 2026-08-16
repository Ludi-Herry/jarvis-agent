import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isJsonObject,
  parseJsonlWithDiagnostics,
  type JsonlMalformedLine,
} from '../../runtime/jsonl-integrity.js';
import { validateSessionId } from '../../runtime/session/index.js';
import type { TuiAuditDetail } from './tui-state.js';

export const TUI_ACTION_AUDIT_SCHEMA_VERSION = 1 as const;
const MAX_IDENTITY_LENGTH = 200;
const MAX_TIMESTAMP_LENGTH = 128;

export interface TuiActionAuditRecord {
  schemaVersion: typeof TUI_ACTION_AUDIT_SCHEMA_VERSION;
  seq: number;
  at: string;
  sessionId: string;
  detail: TuiAuditDetail;
}

export interface TuiActionAuditLoadResult {
  path: string;
  records: TuiActionAuditRecord[];
  issues: JsonlMalformedLine[];
}

export interface FileTuiActionAuditStoreOptions {
  cwd: string;
  sessionId: string;
  now?: () => string;
}

export class FileTuiActionAuditStore {
  private readonly now: () => string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileTuiActionAuditStoreOptions) {
    const check = validateSessionId(options.sessionId);
    if (!check.ok) throw new Error(check.reason);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  append(detail: TuiAuditDetail): Promise<TuiActionAuditRecord> {
    let record!: TuiActionAuditRecord;
    const action = async (): Promise<void> => {
      const path = await resolveTuiAuditPath(this.options.cwd, this.options.sessionId, true);
      let text = '';
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
      const parsed = parseAudit(text);
      assertOperational(parsed.records, parsed.issues, this.options.sessionId, true);
      record = {
        schemaVersion: TUI_ACTION_AUDIT_SCHEMA_VERSION,
        seq: parsed.records.length + 1,
        at: this.now(),
        sessionId: this.options.sessionId,
        detail: normalizeDetail(detail),
      };
      if (!isTuiActionAuditRecord(record)) throw new Error('tui action audit record exceeds its bounded schema');
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    };
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run.then(() => record);
  }
}

export async function loadTuiActionAudit(input: {
  cwd: string;
  sessionId: string;
}): Promise<TuiActionAuditLoadResult> {
  const path = await resolveTuiAuditPath(input.cwd, input.sessionId, false);
  const parsed = parseAudit(await readFile(path, 'utf8'));
  assertOperational(parsed.records, parsed.issues, input.sessionId, false);
  return { path, ...parsed };
}

function parseAudit(text: string): {
  records: TuiActionAuditRecord[];
  issues: JsonlMalformedLine[];
} {
  const parsed = parseJsonlWithDiagnostics(text, isTuiActionAuditRecord);
  return { records: parsed.records, issues: parsed.malformed };
}

function assertOperational(
  records: readonly TuiActionAuditRecord[],
  issues: readonly JsonlMalformedLine[],
  sessionId: string,
  requireAppendSafe: boolean,
): void {
  const unsafe = issues.find((issue) => requireAppendSafe || issue.kind !== 'malformed-tail');
  if (unsafe) throw new Error(`tui action audit is corrupt or invalid at line ${unsafe.line}`);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.seq !== index + 1) throw new Error(`tui action audit sequence is corrupt at record ${index + 1}`);
    if (record.sessionId !== sessionId) throw new Error(`tui action audit session identity is corrupt at record ${index + 1}`);
  }
}

async function resolveTuiAuditPath(cwd: string, sessionId: string, create: boolean): Promise<string> {
  const check = validateSessionId(sessionId);
  if (!check.ok) throw new Error(check.reason);
  const canonicalCwd = await realpath(cwd);
  const dataDir = join(cwd, 'data');
  const tuiDir = join(dataDir, 'tui');
  await ensureSafeDirectory(dataDir, create);
  await ensureSafeDirectory(tuiDir, create);
  const canonicalTui = await realpath(tuiDir);
  assertContained(canonicalCwd, canonicalTui, 'tui audit directory escapes cwd');
  const path = join(tuiDir, `${sessionId}.jsonl`);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('tui audit path must be a regular non-reparse file');
    }
    if (info.nlink !== 1) throw new Error('tui audit path must not be a hard link');
    const canonicalFile = await realpath(path);
    assertContained(canonicalTui, canonicalFile, 'tui audit path escapes data/tui');
  } catch (err) {
    if (!isNotFoundError(err) || !create) throw err;
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
    throw new Error(`tui audit path component is a symbolic link, reparse point, or non-directory: ${path}`);
  }
}

function assertContained(parent: string, child: string, reason: string): void {
  const local = relative(resolve(parent), resolve(child));
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(reason);
}

function normalizeDetail(detail: TuiAuditDetail): TuiAuditDetail {
  switch (detail.kind) {
    case 'submit':
      return {
        kind: 'submit',
        mode: detail.mode,
        textLength: boundedInteger(detail.textLength, 1_000_000),
        queueDepth: boundedInteger(detail.queueDepth, 1_000_000),
        ...(detail.runId === undefined ? {} : { runId: boundedIdentity(detail.runId) }),
      };
    case 'run-closed':
      return {
        kind: 'run-closed',
        outcome: boundedIdentity(detail.outcome, 128),
        pendingEffects: detail.pendingEffects,
        ...(detail.runId === undefined ? {} : { runId: boundedIdentity(detail.runId) }),
      };
    case 'interrupt':
      return {
        kind: 'interrupt',
        source: detail.source,
        ...(detail.runId === undefined ? {} : { runId: boundedIdentity(detail.runId) }),
        ...(detail.requestId === undefined ? {} : { requestId: boundedIdentity(detail.requestId) }),
      };
    case 'approval':
      return {
        kind: 'approval',
        requestId: boundedIdentity(detail.requestId),
        decision: detail.decision,
      };
    case 'eof':
      return { kind: 'eof' };
  }
}

function boundedInteger(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.trunc(value))) : 0;
}

function boundedIdentity(value: string, maximum = MAX_IDENTITY_LENGTH): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 32;
    const unsafe = code < 0x20
      || (code >= 0x7f && code <= 0x9f)
      || code === 0x061c
      || code === 0x200e
      || code === 0x200f
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069);
    return unsafe ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function isTuiActionAuditRecord(value: unknown): value is TuiActionAuditRecord {
  return isJsonObject(value)
    && hasExactKeys(value, ['schemaVersion', 'seq', 'at', 'sessionId', 'detail'])
    && value.schemaVersion === TUI_ACTION_AUDIT_SCHEMA_VERSION
    && Number.isInteger(value.seq)
    && (value.seq as number) >= 1
    && typeof value.at === 'string'
    && value.at.length <= MAX_TIMESTAMP_LENGTH
    && typeof value.sessionId === 'string'
    && validateSessionId(value.sessionId).ok
    && isTuiAuditDetail(value.detail);
}

function isTuiAuditDetail(value: unknown): value is TuiAuditDetail {
  if (!isJsonObject(value) || typeof value.kind !== 'string') return false;
  const optionalId = (candidate: unknown): boolean => candidate === undefined
    || (typeof candidate === 'string' && candidate.length <= MAX_IDENTITY_LENGTH);
  switch (value.kind) {
    case 'submit':
      return hasOptionalExactKeys(value, ['kind', 'mode', 'textLength', 'queueDepth'], ['runId'])
        && (value.mode === 'queue' || value.mode === 'redirect')
        && Number.isInteger(value.textLength) && (value.textLength as number) >= 0
        && (value.textLength as number) <= 1_000_000
        && Number.isInteger(value.queueDepth) && (value.queueDepth as number) >= 0
        && (value.queueDepth as number) <= 1_000_000
        && optionalId(value.runId);
    case 'run-closed':
      return hasOptionalExactKeys(value, ['kind', 'outcome', 'pendingEffects'], ['runId'])
        && typeof value.outcome === 'string' && value.outcome.length <= 128
        && typeof value.pendingEffects === 'boolean' && optionalId(value.runId);
    case 'interrupt':
      return hasOptionalExactKeys(value, ['kind', 'source'], ['runId', 'requestId'])
        && ['esc', 'ctrl-c', 'eof'].includes(String(value.source))
        && optionalId(value.runId) && optionalId(value.requestId);
    case 'approval':
      return hasExactKeys(value, ['kind', 'requestId', 'decision'])
        && typeof value.requestId === 'string' && value.requestId.length <= MAX_IDENTITY_LENGTH
        && ['allow-once', 'allow-session', 'deny'].includes(String(value.decision));
    case 'eof':
      return hasExactKeys(value, ['kind']);
    default:
      return false;
  }
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
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}
