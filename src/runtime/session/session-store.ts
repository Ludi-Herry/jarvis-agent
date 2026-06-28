/**
 * SessionStore — append-only JSONL persistence so a session survives a crash/exit and can be
 * resumed (persistence segment, plan §3.1). Durable, human-readable, no schema lock-in — the
 * single-user-friendly choice over a binary DB (plan §1 decisions).
 *
 * It persists the actual conversation `messages` (not EventBus events): events ≠ messages (an
 * assistant turn is assembled from deltas + tool calls, reasoning is dropped), so logging the
 * messages themselves is the faithful record (plan §1 decision 2). Each line is one record:
 *   {t:'session', …}     — the header (first line)
 *   {t:'message', message} — one conversation message, appended as it's added
 *   {t:'compaction', messages} — a full snapshot written when compaction rewrites the array
 * Compaction can't be expressed as an append over earlier lines (it mutates the middle), so it
 * records the full post-compaction array and replay resets to it (plan §1 decision 3).
 *
 * Crash safety: each record is one append; a crash can only truncate the LAST line, and the reader
 * skips any line that fails to parse — so resume recovers to the last complete record (decision 4).
 *
 * The store is injected into the loop (like ctx.context / ctx.gate). Pure parse/replay live here
 * too, so reconstruction is unit-testable without touching disk.
 */
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Message } from '../../core/types.js';

/** One line of the session log. */
export type SessionRecord =
  | { t: 'session'; id: string; model: string; cwd: string; startedAt: string }
  | { t: 'message'; message: Message }
  | { t: 'compaction'; messages: Message[] };

export type SessionHeader = Extract<SessionRecord, { t: 'session' }>;

/** The contract the loop depends on (injected as optional `ctx.store`). */
export interface SessionStore {
  /** Append every message past the persisted cursor (a pure-append growth). */
  sync(messages: Message[]): Promise<void>;
  /** Record a compaction: a full snapshot + reset the cursor (the array was rewritten). */
  checkpoint(messages: Message[]): Promise<void>;
}

/** Serialize one record as a JSONL line (object + newline). */
export function serializeRecord(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Parse a JSONL log into records, skipping blank lines and any line that fails to parse — the
 *  latter is the crash-truncated tail (or rare corruption); best-effort recovery keeps the rest. */
export function parseSessionLog(text: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as SessionRecord);
    } catch {
      // truncated/corrupt line — skip it and recover the rest
    }
  }
  return records;
}

/** Fold records back into the conversation: `message` pushes, `compaction` replaces the whole array
 *  (so messages compacted away never reappear), `session` is the header. Pure. */
export function replayMessages(records: SessionRecord[]): { messages: Message[]; header?: SessionHeader } {
  let messages: Message[] = [];
  let header: SessionHeader | undefined;
  for (const record of records) {
    switch (record.t) {
      case 'session':
        header = record;
        break;
      case 'message':
        messages.push(record.message);
        break;
      case 'compaction':
        messages = [...record.messages];
        break;
    }
  }
  return { messages, header };
}

/**
 * A file-backed append-only store. `cursor` is how many messages are already persisted; `sync`
 * appends the tail beyond it, `checkpoint` writes a compaction snapshot and resets the cursor to
 * the (now smaller) array length. On resume the store is constructed with the replayed message
 * count so it keeps appending after the existing history.
 */
export class FileSessionStore implements SessionStore {
  private cursor: number;
  private dirEnsured = false;

  constructor(
    private readonly path: string,
    initialCursor = 0,
  ) {
    this.cursor = initialCursor;
  }

  /** Write the session header line. Call once when starting a NEW session (not on resume). */
  async writeHeader(header: Omit<SessionHeader, 't'>): Promise<void> {
    await this.append({ t: 'session', ...header });
  }

  async sync(messages: Message[]): Promise<void> {
    for (let i = this.cursor; i < messages.length; i++) {
      await this.append({ t: 'message', message: messages[i] });
    }
    this.cursor = messages.length;
  }

  async checkpoint(messages: Message[]): Promise<void> {
    await this.append({ t: 'compaction', messages });
    this.cursor = messages.length;
  }

  private async append(record: SessionRecord): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.path, serializeRecord(record), 'utf8');
  }
}

/** Load and replay a session log from disk. */
export async function loadSession(path: string): Promise<{ messages: Message[]; header?: SessionHeader }> {
  const text = await readFile(path, 'utf8');
  return replayMessages(parseSessionLog(text));
}

/** The most recently modified `*.jsonl` session file in `dir`, or null if there are none. */
export async function latestSessionPath(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null; // dir doesn't exist yet
  }
  const sessions = entries.filter((e) => e.endsWith('.jsonl'));
  if (sessions.length === 0) return null;

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of sessions) {
    const full = join(dir, name);
    const info = await stat(full);
    if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: info.mtimeMs };
  }
  return newest?.path ?? null;
}
