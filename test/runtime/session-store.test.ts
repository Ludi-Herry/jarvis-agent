import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSessionStore,
  loadSession,
  latestSessionPath,
  parseSessionLog,
  replayMessages,
  serializeRecord,
  type SessionRecord,
} from '../../src/runtime/session/session-store.js';
import type { Message } from '../../src/core/types.js';

const sys: Message = { role: 'system', content: 'sys' };
const user = (c: string): Message => ({ role: 'user', content: c });
const asst = (c: string): Message => ({ role: 'assistant', content: c });

describe('parseSessionLog + replayMessages (pure)', () => {
  it('round-trips messages: serialize → parse → replay reproduces the conversation', () => {
    const records: SessionRecord[] = [
      { t: 'session', id: 's1', model: 'm', cwd: '/x', startedAt: '2026-01-01' },
      { t: 'message', message: sys },
      { t: 'message', message: user('hello') },
      { t: 'message', message: asst('hi') },
    ];
    const text = records.map(serializeRecord).join('');
    const { messages, header } = replayMessages(parseSessionLog(text));
    expect(messages).toEqual([sys, user('hello'), asst('hi')]);
    expect(header?.id).toBe('s1');
  });

  it('compaction replay: a compaction record replaces the array (compacted-away messages do NOT reappear)', () => {
    const records: SessionRecord[] = [
      { t: 'message', message: sys },
      { t: 'message', message: user('old q') },
      { t: 'message', message: asst('old a') },
      { t: 'compaction', messages: [sys, user('[summary]')] },
      { t: 'message', message: user('new q') },
    ];
    const { messages } = replayMessages(records);
    expect(messages).toEqual([sys, user('[summary]'), user('new q')]);
    expect(messages.some((m) => m.content === 'old q')).toBe(false);
  });

  it('crash safety: a truncated/garbage trailing line is skipped, earlier records recovered', () => {
    const good = [serializeRecord({ t: 'message', message: user('a') }), serializeRecord({ t: 'message', message: user('b') })].join('');
    const truncated = `${good}{"t":"message","message":{"role":"user","cont`; // half-written last line
    const { messages } = replayMessages(parseSessionLog(truncated));
    expect(messages).toEqual([user('a'), user('b')]);
  });
});

describe('FileSessionStore', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sessions-'));
    path = join(dir, 'sessions', 's1.jsonl');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a header and appends only the messages past the cursor on each sync', async () => {
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now' });
    await store.sync([sys, user('q1')]);
    await store.sync([sys, user('q1'), asst('a1')]); // only a1 is new
    await store.sync([sys, user('q1'), asst('a1')]); // nothing new → no extra lines

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3 messages, a1 written once
    const { messages } = await loadSession(path);
    expect(messages).toEqual([sys, user('q1'), asst('a1')]);
  });

  it('checkpoint records a compaction snapshot and keeps replay correct', async () => {
    const store = new FileSessionStore(path);
    await store.sync([sys, user('old'), asst('old a')]);
    await store.checkpoint([sys, user('[summary]')]); // compaction shrank the array
    await store.sync([sys, user('[summary]'), user('new')]);
    const { messages } = await loadSession(path);
    expect(messages).toEqual([sys, user('[summary]'), user('new')]);
  });

  it('resumes appending after a replayed history (cursor seeded from prior length)', async () => {
    const first = new FileSessionStore(path);
    await first.sync([sys, user('q1'), asst('a1')]);

    // simulate a fresh process: load, then continue with a new store seeded at the replayed count
    const { messages } = await loadSession(path);
    const resumed = new FileSessionStore(path, messages.length);
    await resumed.sync([...messages, user('q2'), asst('a2')]);

    const reloaded = await loadSession(path);
    expect(reloaded.messages).toEqual([sys, user('q1'), asst('a1'), user('q2'), asst('a2')]);
  });
});

describe('latestSessionPath', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sessions-latest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when there are no sessions', async () => {
    expect(await latestSessionPath(join(dir, 'nope'))).toBeNull();
  });

  it('returns the most recently modified .jsonl', async () => {
    await writeFile(join(dir, 'old.jsonl'), '{}\n', 'utf8');
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(dir, 'new.jsonl'), '{}\n', 'utf8');
    await appendFile(join(dir, 'new.jsonl'), '{}\n', 'utf8');
    expect(await latestSessionPath(dir)).toBe(join(dir, 'new.jsonl'));
  });
});
