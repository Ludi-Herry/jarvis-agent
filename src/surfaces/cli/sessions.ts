/**
 * Read-only `jarvis sessions list|show` reports.
 *
 * Both commands reuse the session validator stack (`isSessionRecord`,
 * `parseJsonlWithDiagnostics`, `replaySession`, `sessionSemanticIssues`) so a
 * damaged log can never be presented as a clean one. `show` additionally runs
 * the operational loader (`loadSession` with the integrity assertions resume
 * itself uses), so its resumability verdict is grounded in the same reader.
 * Nothing here writes, migrates, repairs, or deletes session files, loads a
 * provider, reads credentials, or grants completion authority.
 *
 * Exit contract: usage errors (unsafe session id, unknown id) exit 2; a
 * session whose damage is fail-closed for operational resume (middle
 * corruption, invalid record, missing header, mixed v1/v2, v2 seq/receipt
 * semantic errors, unreadable file) exits 7 while still printing its
 * diagnosis. A crash-truncated tail is recoverable by design and only shows
 * integrity partial with exit 0 — the same predicate loadSession applies.
 *
 * JSON contract: versioned (schemaVersion 1), additive-only after v1, no ANSI.
 * Message contents, tool arguments, tool outputs, and system prompts are never
 * included — only counts, hashes, and safe identifiers.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseJsonlWithDiagnostics } from '../../runtime/jsonl-integrity.js';
import {
  isSessionRecord,
  loadResolvedSession,
  resolveSessionFilePath,
  replaySession,
  sessionSemanticIssues,
  validateSessionId,
  type PendingToolExecution,
  type SessionFormat,
  type SessionHeader,
  type SessionRoot,
} from '../../runtime/session/session-store.js';
import { safeInline } from './approval.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';
import {
  applySessionSelection,
  type SessionSelectionInfo,
  type SessionSelectionQuery,
} from './sessions-query.js';

const MAX_ISSUES_PER_SESSION = 50;

const OBSERVATION_AUTHORITY = {
  mode: 'observation-only',
  canCompleteGoals: false,
  canCompleteLoops: false,
} as const;

export type SessionCompositionCoverage = 'full' | 'partial' | 'legacy';

export interface SessionCompositionSummary {
  coverage: SessionCompositionCoverage;
  dynamicAddendumCoverage: SessionCompositionCoverage;
  root?: SessionRoot;
  runtimeVersion?: string;
  permissionMode?: string;
  toolsetHash?: string;
  systemPromptHash?: string;
  dynamicAddendumSource?: string;
  dynamicAddendumManifestHash?: string;
}

export type SessionIntegrityIssueKind =
  | 'malformed-middle'
  | 'malformed-tail'
  | 'invalid-record'
  | 'unreadable'
  | 'unsafe-path'
  | 'header'
  | 'mixed-version'
  | 'sequence'
  | 'receipt';

export interface SessionIntegrityIssue {
  kind: SessionIntegrityIssueKind;
  /** dataDir-relative path with forward slashes. */
  path: string;
  /** 1-based line for record-level issues; absent for unreadable files. */
  line?: number;
  /** Semantic or filesystem detail; absent only when no safe detail exists. */
  detail?: string;
}

export interface SessionIntegritySummary {
  status: 'complete' | 'partial';
  issues: SessionIntegrityIssue[];
  omittedIssueCount: number;
}

export type SessionResumeVerdict =
  | 'ready-for-resume-check'
  | 'review-pending-effects'
  | 'review-composition'
  | 'legacy-incomplete-evidence'
  | 'refuse-resume';

export interface SessionResumeAdvice {
  verdict: SessionResumeVerdict;
  reason: string;
}

export interface SessionCounts {
  messageRecords: number;
  compactions: number;
  requestReceipts: number;
  toolReceipts: number;
  /** Messages the replayed projection would restore on resume. */
  projectedMessages: number;
}

/** Safe pending-effect summary: identifiers and reason only, never arguments. */
export interface SessionPendingEffectSummary {
  executionId?: string;
  requestId?: string;
  callId: string;
  toolName: string;
  reason: PendingToolExecution['reason'];
}

export interface SessionAuthority {
  mode: 'observation-only';
  canCompleteGoals: false;
  canCompleteLoops: false;
}

export interface SessionListItem {
  id: string;
  file: string;
  lastModifiedAt?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  format: SessionFormat | 'unknown';
  composition: SessionCompositionSummary;
  pendingToolEffects: number;
  integrity: SessionIntegritySummary;
  resume: SessionResumeAdvice;
  /** Present and true when the item was listed from the archive directory. */
  archived?: boolean;
}

export interface SessionsListReport {
  schemaVersion: 1;
  authority: SessionAuthority;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  /** Directory-level read problems; per-session damage lives on each item. */
  integrity: SessionIntegritySummary;
  /** Sorted by last modification, newest first; name asc as tie-breaker. */
  sessions: SessionListItem[];
  /** Additive echo of the applied filter/sort/page; absent when no selection flags were given. */
  selection?: SessionSelectionInfo;
}

export interface SessionsShowReport {
  schemaVersion: 1;
  authority: SessionAuthority;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  session: {
    id: string;
    file: string;
    format: SessionFormat | 'unknown';
    lastModifiedAt?: string;
    cwd?: string;
    model?: string;
    startedAt?: string;
    /** True when the report was read from the archive directory. */
    archived?: boolean;
    /** Lineage recorded by a full-fidelity fork (v2 headers only). */
    forkedFrom?: string;
    counts: SessionCounts;
    composition: SessionCompositionSummary;
    pendingToolEffects: SessionPendingEffectSummary[];
    integrity: SessionIntegritySummary;
    resume: SessionResumeAdvice;
  };
}

export { validateSessionId };

/** Directory-level safety check shared by the read-only sessions reports:
 * rejects symlink/reparse data roots, treats a missing directory as an empty
 * entry set, and surfaces any other read failure as an integrity issue. */
export interface SessionsDirectoryInspection {
  dataDir: string;
  sessionsDir: string;
  dirIssues: SessionIntegrityIssue[];
  entries: string[];
}

export async function inspectSessionsDirectory(
  cwd: string,
  location: 'active' | 'archived' = 'active',
): Promise<SessionsDirectoryInspection> {
  const dataDir = join(cwd, 'data');
  const activeDir = join(dataDir, 'sessions');
  const sessionsDir = location === 'archived' ? join(activeDir, 'archived') : activeDir;
  const dirIssues: SessionIntegrityIssue[] = [];
  let entries: string[] = [];
  let canReadDirectory = true;
  const components = location === 'archived' ? [dataDir, activeDir, sessionsDir] : [dataDir, sessionsDir];
  for (const directory of components) {
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink()) {
        dirIssues.push({
          kind: 'unsafe-path',
          path: localPath(dataDir, directory),
          detail: 'unsafe sessions directory: symbolic link or reparse point',
        });
        canReadDirectory = false;
        break;
      }
      if (!info.isDirectory()) {
        dirIssues.push({
          kind: 'unreadable',
          path: localPath(dataDir, directory),
          detail: 'cannot read sessions directory: expected a directory',
        });
        canReadDirectory = false;
        break;
      }
    } catch (err) {
      canReadDirectory = false;
      if (!isNotFound(err)) {
        dirIssues.push({
          kind: 'unreadable',
          path: localPath(dataDir, directory),
          detail: `cannot inspect sessions directory: ${describeReadError(err)}`,
        });
      }
      break;
    }
  }
  if (canReadDirectory) {
    try {
      entries = await readdir(sessionsDir);
    } catch (err) {
      if (!isNotFound(err)) {
        dirIssues.push({
          kind: 'unreadable',
          path: localPath(dataDir, sessionsDir),
          detail: `cannot read sessions directory: ${describeReadError(err)}`,
        });
      }
    }
  }
  return { dataDir, sessionsDir, dirIssues, entries };
}

export async function buildSessionsListReport(
  input: { cwd: string; generatedAt?: string; selection?: SessionSelectionQuery; archived?: boolean },
): Promise<{ report: SessionsListReport; exitCode: CliExitCode }> {
  const scope = input.archived === true ? 'archived' : 'active';
  const { dataDir, sessionsDir, dirIssues, entries } = await inspectSessionsDirectory(input.cwd, scope);
  const inspections: SessionInspection[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = fileStem(entry);
    const resolution = await resolveSessionFilePath({ cwd: input.cwd, sessionId, scope });
    if (resolution.status === 'not-found') continue;
    if (resolution.status !== 'ok') {
      inspections.push(problemInspection(
        entry,
        resolution.status === 'invalid-session-id' ? 'unsafe-path' : resolution.status,
        resolution.reason,
        dataDir,
        resolution.status === 'invalid-session-id' ? join(sessionsDir, entry) : resolution.path,
      ));
      continue;
    }
    const inspection = await inspectSessionFile(resolution.path, entry, dataDir, resolution.mtimeMs);
    if (inspection !== undefined) inspections.push(inspection);
  }
  inspections.sort((left, right) => right.mtimeMs - left.mtimeMs || compareText(left.file, right.file));
  const allSessions = inspections.map((inspection) => toListItem(inspection, input.archived === true));
  // Damage visibility is not selectable: corruption and exit 7 are computed on the full set.
  const corrupt = dirIssues.length > 0 || allSessions.some((item) => item.resume.verdict === 'refuse-resume');
  let sessions = allSessions;
  let selection: SessionSelectionInfo | undefined;
  if (input.selection !== undefined) {
    const rows = inspections.map((inspection, index) => {
      const item = allSessions[index];
      return {
        item,
        id: item.id,
        format: item.format,
        integrityStatus: item.integrity.status,
        resumeVerdict: item.resume.verdict,
        modifiedMs: inspection.mtimeMs,
        startedAt: item.startedAt,
      };
    });
    const selected = applySessionSelection(rows, input.selection);
    sessions = selected.items.map((row) => row.item);
    selection = selected.info;
  }
  return {
    report: {
      schemaVersion: 1,
      authority: OBSERVATION_AUTHORITY,
      source: { cwd: input.cwd, dataDir },
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      integrity: integritySummary(dirIssues),
      sessions,
      ...(selection === undefined ? {} : { selection }),
    },
    exitCode: corrupt ? CLI_EXIT.STATE_CORRUPT : CLI_EXIT.SUCCESS,
  };
}

export type SessionsShowResult =
  | { status: 'invalid-session-id'; reason: string }
  | { status: 'not-found'; sessionId: string; path: string }
  | { status: 'ok'; report: SessionsShowReport; exitCode: CliExitCode };

export async function buildSessionsShowReport(
  input: { cwd: string; sessionId: string; generatedAt?: string },
  dependencies: { loadResolvedSession?: typeof loadResolvedSession } = {},
): Promise<SessionsShowResult> {
  const dataDir = join(input.cwd, 'data');
  let resolution = await resolveSessionFilePath({ cwd: input.cwd, sessionId: input.sessionId });
  let archived = false;
  if (resolution.status === 'not-found') {
    // Archived sessions stay inspectable; resume resolution deliberately never
    // looks here.
    const archivedResolution = await resolveSessionFilePath({
      cwd: input.cwd,
      sessionId: input.sessionId,
      scope: 'archived',
    });
    if (archivedResolution.status !== 'not-found') {
      resolution = archivedResolution;
      archived = true;
    }
  }
  if (resolution.status === 'invalid-session-id') {
    return { status: 'invalid-session-id', reason: resolution.reason };
  }
  if (resolution.status === 'not-found') {
    return { status: 'not-found', sessionId: input.sessionId, path: resolution.path };
  }
  const inspection = resolution.status === 'ok'
    ? await inspectSessionFile(resolution.path, resolution.file, dataDir, resolution.mtimeMs)
    : problemInspection(resolution.file, resolution.status, resolution.reason, dataDir, resolution.path);
  if (inspection === undefined) {
    return { status: 'not-found', sessionId: input.sessionId, path: resolution.path };
  }

  let operationalError: string | undefined;
  if (resolution.status === 'ok') {
    try {
      const loadResult = await (dependencies.loadResolvedSession ?? loadResolvedSession)(resolution, {
        requireHeader: true,
        validateIntegrity: true,
        expectedSessionId: input.sessionId,
      });
      if (loadResult.status === 'not-found') {
        return { status: 'not-found', sessionId: input.sessionId, path: resolution.path };
      }
    } catch (err) {
      operationalError = err instanceof Error ? err.message : String(err);
      if (inspection.issues.length === 0) {
        inspection.issues.push({
          kind: 'unreadable',
          path: localPath(dataDir, resolution.path),
          detail: `cannot complete operational session read: ${describeReadError(err)}`,
        });
      }
    }
  }

  const failClosed = inspection.issues.some((issue) => issue.kind !== 'malformed-tail') || operationalError !== undefined;
  const composition = compositionSummary(inspection.header);
  const resume = resumeAdvice({
    failClosed,
    operationalError,
    format: inspection.format,
    pending: inspection.pendingTools,
    composition,
    issues: inspection.issues,
  });
  return {
    status: 'ok',
    exitCode: failClosed ? CLI_EXIT.STATE_CORRUPT : CLI_EXIT.SUCCESS,
    report: {
      schemaVersion: 1,
      authority: OBSERVATION_AUTHORITY,
      source: { cwd: input.cwd, dataDir },
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      session: {
        id: inspection.header?.id ?? fileStem(inspection.file),
        file: inspection.file,
        format: inspection.format,
        ...(archived ? { archived: true } : {}),
        ...optional('forkedFrom', forkedFromOf(inspection.header)),
        ...optional('lastModifiedAt', inspection.mtimeMs > 0 ? new Date(inspection.mtimeMs).toISOString() : undefined),
        ...optional('cwd', inspection.header?.cwd),
        ...optional('model', inspection.header?.model),
        ...optional('startedAt', inspection.header?.startedAt),
        counts: inspection.counts,
        composition,
        pendingToolEffects: inspection.pendingTools.map(pendingSummary),
        integrity: integritySummary(inspection.issues),
        resume,
      },
    },
  };
}

export function formatSessionsListReport(report: SessionsListReport): string {
  const lines = [
    `Sessions (read-only): ${report.sessions.length}`,
    `source: ${inline(report.source.dataDir)}`,
    'completion authority: none (observation-only)',
  ];
  for (const issue of report.integrity.issues) {
    lines.push(`directory integrity: ${issueText(issue)}`);
  }
  if (report.selection !== undefined) {
    lines.push(selectionText(report.selection));
  }
  if (report.sessions.length === 0) {
    lines.push('', report.selection === undefined ? 'no sessions recorded' : 'no sessions match the selection');
    return `${lines.join('\n')}\n`;
  }
  for (const session of report.sessions) {
    lines.push(
      '',
      `${inline(session.lastModifiedAt)}  ${session.format}  ${inline(session.id)}${session.archived === true ? '  [archived]' : ''}`,
      `  cwd: ${inline(session.cwd)}  model: ${inline(session.model)}`,
      `  composition: ${compositionText(session.composition)}  pending tool effects: ${session.pendingToolEffects}  integrity: ${session.integrity.status}`,
      `  resume: ${session.resume.verdict}: ${inline(session.resume.reason)}`,
    );
    for (const issue of session.integrity.issues) lines.push(`    - ${issueText(issue)}`);
    if (session.integrity.omittedIssueCount > 0) {
      lines.push(`    - ${session.integrity.omittedIssueCount} additional issue(s) omitted`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatSessionsShowReport(report: SessionsShowReport): string {
  const session = report.session;
  const lines = [
    `Session ${inline(session.id)} (read-only)`,
    `source: ${inline(report.source.dataDir)}`,
    `file: ${inline(session.file)}`,
    `format: ${session.format}  integrity: ${session.integrity.status}`,
    `model: ${inline(session.model)}  cwd: ${inline(session.cwd)}`,
    `started: ${inline(session.startedAt)}  last modified: ${inline(session.lastModifiedAt)}`,
    `counts: messageRecords=${session.counts.messageRecords} compactions=${session.counts.compactions}`
      + ` requestReceipts=${session.counts.requestReceipts} toolReceipts=${session.counts.toolReceipts}`
      + ` projectedMessages=${session.counts.projectedMessages}`,
    `composition: ${compositionText(session.composition)}`,
  ];
  if (session.archived === true) {
    lines.push('archived: yes — unarchive before any resume (resume resolves only the active sessions directory)');
  }
  if (session.forkedFrom !== undefined) lines.push(`forkedFrom: ${inline(session.forkedFrom)}`);
  if (session.composition.toolsetHash !== undefined) lines.push(`  toolsetHash: ${inline(session.composition.toolsetHash)}`);
  if (session.composition.systemPromptHash !== undefined) lines.push(`  systemPromptHash: ${inline(session.composition.systemPromptHash)}`);
  if (session.composition.dynamicAddendumSource !== undefined) {
    lines.push(`  dynamicAddendumSource: ${inline(session.composition.dynamicAddendumSource)}`);
  }
  if (session.composition.dynamicAddendumManifestHash !== undefined) {
    lines.push(`  dynamicAddendumManifestHash: ${inline(session.composition.dynamicAddendumManifestHash)}`);
  }
  lines.push(`pending tool effects: ${session.pendingToolEffects.length}`);
  for (const effect of session.pendingToolEffects) {
    const ids = [
      effect.executionId === undefined ? undefined : `execution=${inline(effect.executionId)}`,
      effect.requestId === undefined ? undefined : `request=${inline(effect.requestId)}`,
    ].filter((part): part is string => part !== undefined);
    lines.push(`  - ${inline(effect.toolName)} ${inline(effect.callId)} ${effect.reason}${ids.length === 0 ? '' : ` (${ids.join(' ')})`}`);
  }
  lines.push('integrity issues:');
  if (session.integrity.issues.length === 0) {
    lines.push('  none');
  } else {
    for (const issue of session.integrity.issues) lines.push(`  - ${issueText(issue)}`);
    if (session.integrity.omittedIssueCount > 0) {
      lines.push(`  - ${session.integrity.omittedIssueCount} additional issue(s) omitted`);
    }
  }
  lines.push(`resume: ${session.resume.verdict}: ${inline(session.resume.reason)}`);
  lines.push('completion authority: none (observation-only)');
  return `${lines.join('\n')}\n`;
}

interface SessionInspection {
  file: string;
  mtimeMs: number;
  header?: SessionHeader;
  format: SessionFormat | 'unknown';
  counts: SessionCounts;
  pendingTools: PendingToolExecution[];
  issues: SessionIntegrityIssue[];
}

/** Read one session file with full diagnostics. Returns undefined when the
 * file disappeared between listing and reading. Never throws for content
 * problems — they become integrity issues so the caller can still show them. */
async function inspectSessionFile(
  path: string,
  file: string,
  dataDir: string,
  mtimeMs: number,
): Promise<SessionInspection | undefined> {
  let text: string | undefined;
  const issues: SessionIntegrityIssue[] = [];
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    issues.push({
      kind: 'unreadable',
      path: localPath(dataDir, path),
      detail: `cannot read session file: ${describeReadError(err)}`,
    });
  }
  if (text === undefined) {
    return { file, mtimeMs, format: 'unknown', counts: emptyCounts(), pendingTools: [], issues };
  }
  const parsed = parseJsonlWithDiagnostics(text, isSessionRecord);
  const replayed = replaySession(parsed.records);
  for (const malformed of parsed.malformed) {
    issues.push({ kind: malformed.kind, path: localPath(dataDir, path), line: malformed.line });
  }
  for (const semantic of sessionSemanticIssues(parsed.records)) {
    issues.push({
      kind: semantic.kind,
      path: localPath(dataDir, path),
      line: semantic.line,
      detail: semantic.detail,
    });
  }
  const expectedId = fileStem(file);
  if (replayed.header !== undefined && replayed.header.id !== expectedId) {
    issues.push({
      kind: 'header',
      path: localPath(dataDir, path),
      line: 1,
      detail: `session header id ${replayed.header.id} does not match file id ${expectedId}`,
    });
  }
  return {
    file,
    mtimeMs,
    ...optional('header', replayed.header),
    format: replayed.format,
    counts: {
      messageRecords: parsed.records.filter((record) => record.t === 'message').length,
      compactions: parsed.records.filter((record) => record.t === 'compaction').length,
      requestReceipts: replayed.requests.length,
      toolReceipts: replayed.toolReceipts.length,
      projectedMessages: replayed.messages.length,
    },
    pendingTools: replayed.pendingTools,
    issues,
  };
}

function problemInspection(
  file: string,
  kind: 'unreadable' | 'unsafe-path',
  detail: string,
  dataDir: string,
  path: string,
): SessionInspection {
  return {
    file,
    mtimeMs: 0,
    format: 'unknown',
    counts: emptyCounts(),
    pendingTools: [],
    issues: [{ kind, path: localPath(dataDir, path), detail }],
  };
}

function toListItem(inspection: SessionInspection, archived = false): SessionListItem {
  const failClosed = inspection.issues.some((issue) => issue.kind !== 'malformed-tail');
  const composition = compositionSummary(inspection.header);
  return {
    id: inspection.header?.id ?? fileStem(inspection.file),
    file: inspection.file,
    ...optional('lastModifiedAt', inspection.mtimeMs > 0 ? new Date(inspection.mtimeMs).toISOString() : undefined),
    ...optional('cwd', inspection.header?.cwd),
    ...optional('model', inspection.header?.model),
    ...optional('startedAt', inspection.header?.startedAt),
    format: inspection.format,
    composition,
    pendingToolEffects: inspection.pendingTools.length,
    integrity: integritySummary(inspection.issues),
    resume: resumeAdvice({
      failClosed,
      format: inspection.format,
      pending: inspection.pendingTools,
      composition,
      issues: inspection.issues,
    }),
    ...(archived ? { archived: true } : {}),
  };
}

function resumeAdvice(input: {
  failClosed: boolean;
  operationalError?: string;
  format: SessionFormat | 'unknown';
  pending: readonly PendingToolExecution[];
  composition: SessionCompositionSummary;
  issues: readonly SessionIntegrityIssue[];
}): SessionResumeAdvice {
  if (input.failClosed) {
    const first = input.issues.find((issue) => issue.kind !== 'malformed-tail') ?? input.issues[0];
    const cause = input.operationalError ?? (first === undefined ? 'unreadable session state' : issueReason(first));
    return {
      verdict: 'refuse-resume',
      reason: `state is corrupt (${cause}); refusing resume — inspect the reported issue(s) before continuing`,
    };
  }
  if (input.pending.length > 0) {
    const first = input.pending[0];
    return {
      verdict: 'review-pending-effects',
      reason: `${input.pending.length} pending tool effect(s) need manual review before any resume`
        + ` (first=${first.toolName}/${first.callId} reason=${first.reason})`,
    };
  }
  if (input.format === 'v1') {
    return {
      verdict: 'legacy-incomplete-evidence',
      reason: 'legacy v1 session: request/tool receipts and composition coverage are not recorded',
    };
  }
  if (input.composition.coverage === 'partial') {
    return {
      verdict: 'review-composition',
      reason: 'v2 composition coverage is partial; fork into a fully recorded session before continuing',
    };
  }
  if (input.composition.dynamicAddendumCoverage === 'partial') {
    return {
      verdict: 'review-composition',
      reason: 'v2 dynamic addendum provenance is incomplete; restore the original sources or fork into a fully recorded session',
    };
  }
  const tail = input.issues.find((issue) => issue.kind === 'malformed-tail');
  return {
    verdict: 'ready-for-resume-check',
    reason: tail === undefined
      ? 'no session-side blockers; run exact-session resume to compare cwd, model, current sources, and request addendum receipts'
      : `no session-side blockers besides the crash-truncated tail at line ${tail.line ?? '?'}; `
        + 'the truncated append is skipped, then exact-session resume must still verify current sources and request addendum receipts',
  };
}

function pendingSummary(pending: PendingToolExecution): SessionPendingEffectSummary {
  return {
    ...optional('executionId', pending.executionId),
    ...optional('requestId', pending.requestId),
    callId: pending.callId,
    toolName: pending.toolName,
    reason: pending.reason,
  };
}

function forkedFromOf(header: SessionHeader | undefined): string | undefined {
  if (header === undefined || !('forkedFrom' in header)) return undefined;
  return header.forkedFrom;
}

function compositionSummary(header: SessionHeader | undefined): SessionCompositionSummary {
  if (header === undefined || !('schemaVersion' in header)) {
    return { coverage: 'legacy', dynamicAddendumCoverage: 'legacy' };
  }
  const composition = header.composition;
  const dynamicAddendumCoverage = composition.dynamicAddendumSource !== undefined
    && composition.dynamicAddendumManifestHash !== undefined
    ? 'full'
    : 'partial';
  return {
    coverage: composition.coverage,
    dynamicAddendumCoverage,
    root: composition.root,
    runtimeVersion: composition.runtimeVersion,
    permissionMode: composition.permissionMode,
    ...optional('toolsetHash', composition.toolsetHash),
    ...optional('systemPromptHash', composition.systemPromptHash),
    ...optional('dynamicAddendumSource', composition.dynamicAddendumSource),
    ...optional('dynamicAddendumManifestHash', composition.dynamicAddendumManifestHash),
  };
}

export function integritySummary(issues: readonly SessionIntegrityIssue[]): SessionIntegritySummary {
  return {
    status: issues.length === 0 ? 'complete' : 'partial',
    issues: issues.slice(0, MAX_ISSUES_PER_SESSION),
    omittedIssueCount: Math.max(0, issues.length - MAX_ISSUES_PER_SESSION),
  };
}

function selectionText(selection: SessionSelectionInfo): string {
  const filters = [
    selection.filters.format === undefined ? undefined : `format=${selection.filters.format}`,
    selection.filters.integrity === undefined ? undefined : `integrity=${selection.filters.integrity}`,
    selection.filters.resume === undefined ? undefined : `resume=${selection.filters.resume}`,
  ].filter((part): part is string => part !== undefined);
  const parts = [
    `sort=${selection.sort} ${selection.order}`,
    `filters: ${filters.length === 0 ? 'none' : filters.join(' ')}`,
    `showing ${selection.returned} of ${selection.filtered} matching (${selection.total} total)`,
  ];
  if (selection.page !== undefined) {
    parts.push(`page ${selection.page}/${selection.totalPages ?? '?'} (size ${selection.pageSize ?? '?'})`);
  }
  return `selection: ${parts.join('  ')}`;
}

function compositionText(composition: SessionCompositionSummary): string {
  if (composition.coverage === 'legacy') return 'legacy (not recorded)';
  const extras = [
    composition.root === undefined ? undefined : `root=${inline(composition.root)}`,
    composition.runtimeVersion === undefined ? undefined : `runtime=${inline(composition.runtimeVersion)}`,
    composition.permissionMode === undefined ? undefined : `permission=${inline(composition.permissionMode)}`,
    `dynamic=${composition.dynamicAddendumCoverage}`,
    composition.dynamicAddendumSource === undefined ? undefined : `source=${inline(composition.dynamicAddendumSource)}`,
  ].filter((part): part is string => part !== undefined);
  return extras.length === 0 ? composition.coverage : `${composition.coverage} (${extras.join(' ')})`;
}

function issueText(issue: SessionIntegrityIssue): string {
  const location = issue.line === undefined ? inline(issue.path) : `${inline(issue.path)}:${issue.line}`;
  return issue.detail === undefined ? `${issue.kind} ${location}` : `${issue.kind} ${location} ${inline(issue.detail)}`;
}

function issueReason(issue: SessionIntegrityIssue): string {
  const location = issue.line === undefined ? issue.path : `${issue.path}:${issue.line}`;
  return issue.detail === undefined ? `${issue.kind} ${location}` : `${issue.kind} ${location} ${issue.detail}`;
}

function inline(value: string | undefined, fallback = '-'): string {
  if (value === undefined) return fallback;
  const safe = safeInline(value);
  return safe === '' ? fallback : safe;
}

function emptyCounts(): SessionCounts {
  return {
    messageRecords: 0,
    compactions: 0,
    requestReceipts: 0,
    toolReceipts: 0,
    projectedMessages: 0,
  };
}

export function fileStem(file: string): string {
  return file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : file;
}

export function localPath(dataDir: string, path: string): string {
  const local = relative(dataDir, path);
  return (local === '' ? '.' : local).replaceAll('\\', '/');
}

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

export function describeReadError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = 'code' in err && typeof err.code === 'string' ? `${err.code}: ` : '';
  return `${code}${err.message}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function optional<K extends string, T>(key: K, value: T | undefined): { [P in K]: T } | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as { [P in K]: T };
}
