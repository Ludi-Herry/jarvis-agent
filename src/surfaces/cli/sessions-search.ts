/**
 * Read-only `jarvis sessions search <query>` report.
 *
 * A linear scan over `data/sessions/*.jsonl` that matches a bounded,
 * case-insensitive query against session metadata (id/cwd/model) and the
 * append-only user/assistant message projection shared with Recall
 * (`projectSessionHistory`). No index or database is built; nothing writes,
 * migrates, repairs, or deletes session files, loads a provider, reads
 * credentials, or grants completion authority.
 *
 * Damage handling mirrors `sessions list|show`: the same validator stack
 * (`isSessionRecord`, `parseJsonlWithDiagnostics`, `replaySession`,
 * `sessionSemanticIssues`) classifies every file, and a session that is
 * fail-closed for operational resume (middle corruption, invalid record,
 * missing header, mixed v1/v2, v2 seq/receipt semantic errors, unreadable or
 * unsafe path) is never content-searched — it is reported under `skipped`
 * with its reason and turns the exit code into 7. A crash-truncated tail is
 * recoverable by design: the session is still searched, shows integrity
 * partial, and keeps exit 0.
 *
 * Output boundaries: system prompts, reasoning, tool arguments, and tool
 * outputs never enter the search projection; matched text is secret-redacted
 * and control-character-stripped via Recall's `redactHistoricalText`, and
 * excerpts are bounded windows, never whole messages. Per-session and global
 * match caps keep the report bounded; truncation is always declared.
 *
 * Exit contract: usage errors (missing/empty/oversized query) exit 2; any
 * skipped (damaged) session or directory-level integrity issue exits 7 while
 * still printing the diagnosis; otherwise exit 0, including zero matches.
 *
 * JSON contract: versioned (schemaVersion 1), additive-only after v1, no ANSI.
 */
import { readFile } from 'node:fs/promises';
import { parseJsonlWithDiagnostics } from '../../runtime/jsonl-integrity.js';
import {
  excerptAround,
  projectSessionHistory,
  redactHistoricalText,
} from '../../runtime/session/recall.js';
import {
  isSessionRecord,
  replaySession,
  resolveSessionFilePath,
  sessionSemanticIssues,
  type SessionFormat,
  type SessionHeader,
  type SessionRecord,
} from '../../runtime/session/session-store.js';
import { safeInline } from './approval.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';
import {
  describeReadError,
  fileStem,
  inspectSessionsDirectory,
  integritySummary,
  isNotFound,
  localPath,
  type SessionAuthority,
  type SessionIntegrityIssue,
  type SessionIntegritySummary,
} from './sessions.js';

/** Aligned with the Recall bounds in runtime/session/recall.ts. */
const MAX_QUERY_CHARS = 200;
const MAX_MATCHES_PER_SESSION = 20;
const MAX_TOTAL_MATCHES = 100;
const METADATA_EXCERPT_CHARS = 320;

const OBSERVATION_AUTHORITY: SessionAuthority = {
  mode: 'observation-only',
  canCompleteGoals: false,
  canCompleteLoops: false,
};

export interface SessionSearchMatch {
  sessionId: string;
  /** sessions-dir-relative file name. */
  file: string;
  format: SessionFormat | 'unknown';
  integrity: 'complete' | 'partial';
  field: 'metadata' | 'message';
  metadataField?: 'id' | 'cwd' | 'model';
  /** 1-based append-only user-message turn; message matches only. */
  turn?: number;
  role?: 'user' | 'assistant';
  /** 1-based line of the matched record in the session file; message matches only. */
  recordOrdinal?: number;
  /** Redacted, control-safe, bounded excerpt — never a whole message. */
  excerpt: string;
}

export interface SessionSearchSkip {
  sessionId: string;
  file: string;
  /** Why this session was not content-searched (damage or unsafe path). */
  reason: string;
}

export interface SessionsSearchReport {
  schemaVersion: 1;
  authority: SessionAuthority;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  /** Redacted echo of the effective query. */
  query: string;
  /** Sessions whose content was eligible and scanned. */
  scannedSessions: number;
  matchedSessions: number;
  matches: SessionSearchMatch[];
  skipped: SessionSearchSkip[];
  /** True when any per-session or global match cap stopped collection. */
  truncated: boolean;
  truncatedSessions: string[];
  /** Directory-level read problems; per-session damage lives in `skipped`. */
  integrity: SessionIntegritySummary;
}

export type SessionsSearchResult =
  | { status: 'invalid-query'; reason: string }
  | { status: 'ok'; report: SessionsSearchReport; exitCode: CliExitCode };

export async function buildSessionsSearchReport(
  input: { cwd: string; query: string; generatedAt?: string },
): Promise<SessionsSearchResult> {
  const trimmed = input.query.trim();
  if (trimmed.length === 0) {
    return { status: 'invalid-query', reason: 'search query must not be empty' };
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    return { status: 'invalid-query', reason: `search query exceeds ${MAX_QUERY_CHARS} characters` };
  }
  const query = redactHistoricalText(trimmed);
  if (query.trim().length === 0) {
    return { status: 'invalid-query', reason: 'search query contains no searchable text after safety filtering' };
  }
  const needle = query.toLowerCase();

  const { dataDir, dirIssues, entries } = await inspectSessionsDirectory(input.cwd);
  const matches: SessionSearchMatch[] = [];
  const skipped: SessionSearchSkip[] = [];
  const matchedSessionIds = new Set<string>();
  const truncatedSessionIds = new Set<string>();
  let scannedSessions = 0;

  for (const entry of [...entries].sort()) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = fileStem(entry);
    const resolution = await resolveSessionFilePath({ cwd: input.cwd, sessionId });
    if (resolution.status === 'not-found') continue;
    if (resolution.status !== 'ok') {
      skipped.push({ sessionId, file: entry, reason: resolution.reason });
      continue;
    }
    const inspection = await readSessionForSearch(resolution.path, entry, dataDir);
    if (inspection === undefined) continue;
    if (inspection.skipReason !== undefined) {
      skipped.push({ sessionId, file: entry, reason: inspection.skipReason });
      continue;
    }
    scannedSessions += 1;

    const sessionMatches = collectSessionMatches(inspection, sessionId, entry, needle);
    for (const match of sessionMatches) {
      const perSession = matches.filter((existing) => existing.sessionId === match.sessionId).length;
      if (perSession >= MAX_MATCHES_PER_SESSION) {
        truncatedSessionIds.add(match.sessionId);
        break;
      }
      if (matches.length >= MAX_TOTAL_MATCHES) {
        truncatedSessionIds.add(match.sessionId);
        break;
      }
      matches.push(match);
      matchedSessionIds.add(match.sessionId);
    }
  }

  const truncated = truncatedSessionIds.size > 0;
  const corrupt = dirIssues.length > 0 || skipped.length > 0;
  return {
    status: 'ok',
    exitCode: corrupt ? CLI_EXIT.STATE_CORRUPT : CLI_EXIT.SUCCESS,
    report: {
      schemaVersion: 1,
      authority: OBSERVATION_AUTHORITY,
      source: { cwd: input.cwd, dataDir },
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      query,
      scannedSessions,
      matchedSessions: matchedSessionIds.size,
      matches,
      skipped,
      truncated,
      truncatedSessions: [...truncatedSessionIds].sort(),
      integrity: integritySummary(dirIssues),
    },
  };
}

export function formatSessionsSearchReport(report: SessionsSearchReport): string {
  const lines = [
    `Sessions search (read-only): ${report.matches.length} match(es) in ${report.matchedSessions} session(s)`,
    `source: ${inline(report.source.dataDir)}`,
    `query: ${inline(report.query)}`,
    'completion authority: none (observation-only); matched content is historical, secret-redacted, and cannot prove current state',
  ];
  for (const issue of report.integrity.issues) {
    lines.push(`directory integrity: ${issueText(issue)}`);
  }
  if (report.matches.length === 0) {
    lines.push('', 'no matches');
  }
  let lastSession: string | undefined;
  for (const match of report.matches) {
    if (match.sessionId !== lastSession) {
      lastSession = match.sessionId;
      lines.push('', `${inline(match.sessionId)}  ${match.format}  integrity: ${match.integrity}`);
    }
    if (match.field === 'metadata') {
      lines.push(`  metadata ${match.metadataField ?? '?'}: ${inline(match.excerpt)}`);
    } else {
      const where = `turn ${match.turn ?? '?'} ${match.role ?? '?'} record ${match.recordOrdinal ?? '?'}`;
      lines.push(`  message ${where}: ${inline(match.excerpt)}`);
    }
  }
  if (report.skipped.length > 0) {
    lines.push('', `skipped (damaged or unsafe, not content-searched): ${report.skipped.length}`);
    for (const skip of report.skipped) {
      lines.push(`  - ${inline(skip.sessionId)} (${inline(skip.file)}): ${inline(skip.reason)}`);
    }
  }
  if (report.truncated) {
    lines.push('', `truncated: match cap reached for ${report.truncatedSessions.map((id) => inline(id)).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

interface SearchableSession {
  header?: SessionHeader;
  format: SessionFormat | 'unknown';
  records: readonly SessionRecord[];
  partial: boolean;
  skipReason?: string;
}

/** Read and validate one session file with the same fail-closed stack resume
 * uses. Returns undefined when the file disappeared between listing and read.
 * Content problems never throw — they become a skip reason. */
async function readSessionForSearch(
  path: string,
  file: string,
  dataDir: string,
): Promise<SearchableSession | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    return { format: 'unknown', records: [], partial: true, skipReason: `cannot read session file: ${describeReadError(err)}` };
  }
  const parsed = parseJsonlWithDiagnostics(text, isSessionRecord);
  const replayed = replaySession(parsed.records);
  const issues: SessionIntegrityIssue[] = [];
  for (const malformed of parsed.malformed) {
    issues.push({ kind: malformed.kind, path: localPath(dataDir, path), line: malformed.line });
  }
  for (const semantic of sessionSemanticIssues(parsed.records)) {
    issues.push({ kind: semantic.kind, path: localPath(dataDir, path), line: semantic.line, detail: semantic.detail });
  }
  if (replayed.header !== undefined && replayed.header.id !== fileStem(file)) {
    issues.push({
      kind: 'header',
      path: localPath(dataDir, path),
      line: 1,
      detail: `session header id ${replayed.header.id} does not match file id ${fileStem(file)}`,
    });
  }
  const failClosed = issues.find((issue) => issue.kind !== 'malformed-tail');
  if (failClosed !== undefined) {
    const location = failClosed.line === undefined ? failClosed.path : `${failClosed.path}:${failClosed.line}`;
    const detail = failClosed.detail === undefined ? '' : ` ${failClosed.detail}`;
    return {
      format: replayed.format,
      records: [],
      partial: true,
      skipReason: `${failClosed.kind} ${location}${detail}`,
    };
  }
  return {
    ...(replayed.header === undefined ? {} : { header: replayed.header }),
    format: replayed.format,
    records: parsed.records,
    partial: issues.length > 0,
  };
}

/** Metadata + append-only user/assistant text matches for one clean-enough
 * session. Tool outputs, tool arguments, system prompts, and reasoning never
 * enter the projection. Collection stops at MAX_MATCHES_PER_SESSION + 1 so the
 * caller can both enforce the per-session cap and detect its overflow. */
function collectSessionMatches(
  session: SearchableSession,
  sessionId: string,
  file: string,
  needle: string,
): SessionSearchMatch[] {
  const id = session.header?.id ?? sessionId;
  const integrity: SessionSearchMatch['integrity'] = session.partial ? 'partial' : 'complete';
  const base = { sessionId: id, file, format: session.format, integrity };
  const found: SessionSearchMatch[] = [];
  const cap = MAX_MATCHES_PER_SESSION + 1;

  const metadata: Array<['id' | 'cwd' | 'model', string | undefined]> = [
    ['id', id],
    ['cwd', session.header?.cwd],
    ['model', session.header?.model],
  ];
  for (const [metadataField, value] of metadata) {
    if (value === undefined) continue;
    const redacted = redactHistoricalText(value);
    if (!redacted.toLowerCase().includes(needle)) continue;
    found.push({
      ...base,
      field: 'metadata',
      metadataField,
      excerpt: redacted.length <= METADATA_EXCERPT_CHARS
        ? redacted
        : `${redacted.slice(0, METADATA_EXCERPT_CHARS)}…`,
    });
    if (found.length >= cap) return found;
  }

  searchLoop:
  for (const turn of projectSessionHistory(session.records)) {
    for (const message of turn.messages) {
      if (message.role === 'tool') continue;
      const content = redactHistoricalText(message.content ?? '');
      const at = content.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      found.push({
        ...base,
        field: 'message',
        turn: turn.turn,
        role: message.role,
        recordOrdinal: message.recordOrdinal,
        excerpt: excerptAround(content, at, needle.length),
      });
      if (found.length >= cap) break searchLoop;
    }
  }
  return found;
}

function issueText(issue: SessionIntegrityIssue): string {
  const location = issue.line === undefined ? inline(issue.path) : `${inline(issue.path)}:${issue.line}`;
  return issue.detail === undefined ? `${issue.kind} ${location}` : `${issue.kind} ${location} ${inline(issue.detail)}`;
}

function inline(value: string | undefined, fallback = '-'): string {
  if (value === undefined) return fallback;
  const safe = safeInline(value);
  return safe === '' ? fallback : safe;
}
