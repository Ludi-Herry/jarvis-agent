import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSessionStore,
  SessionCompositionMismatchError,
  classifySessionFileError,
  createSessionComposition,
  createModelRequestReceipt,
  diffSessionComposition,
  loadSession,
  loadResolvedSession,
  latestSessionPath,
  parseSessionLog,
  replayMessages,
  serializeRecord,
  summarizeToolResult,
  type SessionRecord,
} from '../../src/runtime/session/session-store.js';
import type { Message } from '../../src/core/types.js';

const sys: Message = { role: 'system', content: 'sys' };
const user = (c: string): Message => ({ role: 'user', content: c });
const asst = (c: string): Message => ({ role: 'assistant', content: c });
const noDynamicAddendum = { source: 'none-v1', manifest: null } as const;
const resolveNoDynamicAddendum = (): undefined => undefined;
const composition = createSessionComposition({
  root: 'repl',
  runtimeVersion: 'test',
  permissionMode: 'interactive',
  toolSchemas: [],
  systemPrompt: 'sys',
  dynamicAddendum: noDynamicAddendum,
});

describe('session file error classification', () => {
  it('maps only explicit ENOENT to not-found', () => {
    expect(classifySessionFileError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('not-found');
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'UNKNOWN'])('maps %s to unreadable', (code) => {
    expect(classifySessionFileError(Object.assign(new Error(`read failed: ${code}`), { code }))).toBe('unreadable');
  });
});

describe('loadResolvedSession', () => {
  const resolution = {
    status: 'ok' as const,
    sessionId: 's1',
    file: 's1.jsonl',
    path: 'H:\\fixture\\data\\sessions\\s1.jsonl',
    mtimeMs: 0,
  };

  it('returns not-found when the resolved file disappears before the read', async () => {
    const reader = async (): Promise<never> => { throw fsError('ENOENT'); };

    await expect(loadResolvedSession(resolution, { requireHeader: true }, reader)).resolves.toMatchObject({
      status: 'not-found',
      sessionId: 's1',
      path: resolution.path,
    });
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('does not swallow %s from the second read', async (code) => {
    const reader = async (): Promise<never> => { throw fsError(code); };

    await expect(loadResolvedSession(resolution, { requireHeader: true }, reader)).rejects.toMatchObject({ code });
  });
});

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
    await mkdir(join(dir, 'sessions'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a header and appends only the messages past the cursor on each sync', async () => {
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
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
    const { messages, format, lastSequence } = await loadSession(path);
    const resumed = new FileSessionStore(path, messages.length, { format, initialSequence: lastSequence });
    await resumed.sync([...messages, user('q2'), asst('a2')]);

    const reloaded = await loadSession(path);
    expect(reloaded.messages).toEqual([sys, user('q1'), asst('a1'), user('q2'), asst('a2')]);
  });

  it('fails closed for operational resume when a middle record has invalid shape', async () => {
    await writeFile(
      path,
      serializeRecord({ t: 'session', id: 's1', model: 'm', cwd: dir, startedAt: 'now' })
        + '{}\n'
        + serializeRecord({ t: 'message', message: user('still parseable') }),
      'utf8',
    );

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow('session state is corrupt at line 2 (invalid-record)');
  });

  it('allows operational resume to recover a crash-truncated final append', async () => {
    await writeFile(
      path,
      serializeRecord({ t: 'session', id: 's1', model: 'm', cwd: dir, startedAt: 'now' })
        + serializeRecord({ t: 'message', message: user('kept') })
        + '{"t":"message"',
      'utf8',
    );

    await expect(loadSession(path, { requireHeader: true })).resolves.toMatchObject({ messages: [user('kept')] });
  });

  it('rejects operational resume when the session header is missing', async () => {
    await writeFile(path, serializeRecord({ t: 'message', message: user('orphan') }), 'utf8');

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow('session state is corrupt: missing header');
  });

  it('fails closed when the requested file id differs from the durable session header id', async () => {
    await writeFile(
      path,
      serializeRecord({ t: 'session', id: 'different-id', model: 'm', cwd: dir, startedAt: 'now' }),
      'utf8',
    );

    await expect(loadSession(path, { requireHeader: true, expectedSessionId: 's1' }))
      .rejects.toThrow(/header id .* does not match requested session id/);
  });

  it('writes a contiguous v2 envelope and preserves request/tool receipts outside message replay', async () => {
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    const assistant: Message = {
      role: 'assistant',
      requestId: 'req-1',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }],
    };
    await store.sync([sys, user('q')]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1',
      runId: 'run-1',
      turn: 0,
      messages: [sys, user('q')],
      systemAddendum: 'skill text',
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    }));
    await store.sync([sys, user('q'), assistant]);
    await store.recordToolPlanned({
      t: 'tool',
      phase: 'planned',
      executionId: 'exec-1',
      requestId: 'req-1',
      runId: 'run-1',
      turn: 0,
      callIndex: 0,
      call: { id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' },
    });
    await store.recordToolCommitted({
      t: 'tool',
      phase: 'committed',
      executionId: 'exec-1',
      requestId: 'req-1',
      runId: 'run-1',
      turn: 0,
      callIndex: 0,
      result: summarizeToolResult({ callId: 'call-1', content: 'A' }),
    });
    const toolMessage: Message = { role: 'tool', toolCallId: 'call-1', content: 'A', executionId: 'exec-1' };
    await store.sync([sys, user('q'), assistant, toolMessage]);

    const rawRecords = parseSessionLog(await readFile(path, 'utf8'));
    expect(rawRecords.every((record, index) => 'schemaVersion' in record && record.seq === index + 1)).toBe(true);
    const loaded = await loadSession(path, { requireHeader: true });
    expect(loaded.format).toBe('v2');
    expect(loaded.requests).toHaveLength(1);
    expect(loaded.requests[0]).toMatchObject({
      messageCount: 2,
      toolCount: 1,
      messagesHash: expect.stringMatching(/^sha256\./),
      systemAddendumHash: expect.stringMatching(/^sha256\./),
      toolsHash: expect.stringMatching(/^sha256\./),
    });
    expect(loaded.requests[0]).not.toHaveProperty('systemAddendum');
    expect(loaded.requests[0]).not.toHaveProperty('tools');
    expect(loaded.toolReceipts).toHaveLength(2);
    expect(loaded.pendingTools).toEqual([]);
    expect(loaded.messages).toEqual([sys, user('q'), assistant, toolMessage]);
  });

  it('marks a persisted assistant tool intent without a terminal receipt as pending', async () => {
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1',
      runId: 'run-1',
      turn: 0,
      messages: [sys],
      tools: [],
    }));
    await store.sync([
      sys,
      {
        role: 'assistant',
        requestId: 'req-1',
        toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"a.txt","createOnly":true,"content":"x"}' }],
      },
    ]);

    const loaded = await loadSession(path, { requireHeader: true });

    expect(loaded.pendingTools).toEqual([
      expect.objectContaining({ callId: 'call-1', toolName: 'write', reason: 'intent-without-plan' }),
    ]);
  });

  it('keeps a historical assistant intent pending when compaction omits it', async () => {
    const store = new FileSessionStore(path);
    const call = { id: 'call-1', name: 'write', arguments: '{"path":"a.txt","createOnly":true,"content":"x"}' };
    const assistant: Message = { role: 'assistant', requestId: 'req-1', toolCalls: [call] };
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
    }));
    await store.sync([sys, assistant]);
    await store.checkpoint([sys]);

    await expect(loadSession(path, { requireHeader: true, validateIntegrity: true })).resolves.toMatchObject({
      messages: [sys],
      pendingTools: [expect.objectContaining({
        requestId: 'req-1', callId: 'call-1', toolName: 'write', reason: 'intent-without-plan',
      })],
    });
  });

  it('rejects compaction that changes a historical assistant tool-call identity', async () => {
    const store = new FileSessionStore(path);
    const assistant: Message = {
      role: 'assistant',
      requestId: 'req-1',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }],
    };
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
    }));
    await store.sync([sys, assistant]);
    await store.checkpoint([sys, { role: 'assistant', requestId: 'req-1', toolCalls: [] }]);

    await expect(loadSession(path, { requireHeader: true, validateIntegrity: true }))
      .rejects.toThrow(/compaction changes historical assistant request req-1/);
  });

  it('fails closed on a v2 sequence gap', async () => {
    const header: SessionRecord = {
      schemaVersion: 2,
      seq: 1,
      at: 't0',
      t: 'session',
      id: 's1',
      model: 'm',
      cwd: dir,
      startedAt: 't0',
      composition,
    };
    const message: SessionRecord = {
      schemaVersion: 2,
      seq: 3,
      at: 't1',
      t: 'message',
      message: user('gap'),
    };
    await writeFile(path, serializeRecord(header) + serializeRecord(message), 'utf8');

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow(/sequence gap/);
  });

  it('fails closed when v1 and v2 records are mixed', async () => {
    const header: SessionRecord = {
      schemaVersion: 2,
      seq: 1,
      at: 't0',
      t: 'session',
      id: 's1',
      model: 'm',
      cwd: dir,
      startedAt: 't0',
      composition,
    };
    await writeFile(path, serializeRecord(header) + serializeRecord({ t: 'message', message: user('legacy') }), 'utf8');

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow('mixed v1/v2 records');
  });

  it('fails closed when a request receipt does not match the persisted message prefix', async () => {
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys, user('q')]);
    await store.recordRequest({
      ...createModelRequestReceipt({
        requestId: 'req-1',
        runId: 'run-1',
        turn: 0,
        messages: [sys, user('q')],
        tools: [],
      }),
      messagesHash: 'sha256.tampered',
    });

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow('request message receipt mismatch');
  });

  it('fails closed on a duplicate planned execution id', async () => {
    const store = new FileSessionStore(path);
    const request = createModelRequestReceipt({
      requestId: 'req-1',
      runId: 'run-1',
      turn: 0,
      messages: [sys, user('q')],
      tools: [],
    });
    const assistant: Message = {
      role: 'assistant',
      requestId: 'req-1',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }],
    };
    const plan = {
      t: 'tool' as const,
      phase: 'planned' as const,
      executionId: 'exec-1',
      requestId: 'req-1',
      runId: 'run-1',
      turn: 0,
      callIndex: 0,
      call: assistant.toolCalls![0],
    };
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys, user('q')]);
    await store.recordRequest(request);
    await store.sync([sys, user('q'), assistant]);
    await store.recordToolPlanned(plan);
    await store.recordToolPlanned(plan);

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow('duplicate planned executionId');
  });

  it('rejects receiptless v2 tool intent and tool projection identities', async () => {
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([
      sys,
      { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }] },
      { role: 'tool', toolCallId: 'call-1', content: 'A' },
    ]);

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow(/tool-bearing assistant message is missing requestId/);
  });

  it('rejects two execution ids for the same request and call index', async () => {
    const store = new FileSessionStore(path);
    const call = { id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' };
    const assistant: Message = { role: 'assistant', requestId: 'req-1', toolCalls: [call] };
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
    }));
    await store.sync([sys, assistant]);
    for (const executionId of ['exec-1', 'exec-2']) {
      await store.recordToolPlanned({
        t: 'tool', phase: 'planned', executionId, requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0, call,
      });
      await store.recordToolCommitted({
        t: 'tool', phase: 'committed', executionId, requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0,
        result: summarizeToolResult({ callId: 'call-1', content: 'A' }),
      });
      await store.sync([
        sys,
        assistant,
        ...['exec-1', 'exec-2'].slice(0, executionId === 'exec-1' ? 1 : 2).map((id) => ({
          role: 'tool' as const, toolCallId: 'call-1', content: 'A', executionId: id,
        })),
      ]);
    }

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow(/duplicate logical tool execution/);
  });

  it('keeps a commit pending when compaction occurs without a historical tool message', async () => {
    const store = new FileSessionStore(path);
    const call = { id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' };
    const assistant: Message = { role: 'assistant', requestId: 'req-1', toolCalls: [call] };
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
    }));
    await store.sync([sys, assistant]);
    await store.recordToolPlanned({
      t: 'tool', phase: 'planned', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0, call,
    });
    await store.recordToolCommitted({
      t: 'tool', phase: 'committed', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0,
      result: summarizeToolResult({ callId: 'call-1', content: 'A' }),
    });
    await store.checkpoint([sys, assistant]);

    await expect(loadSession(path, { requireHeader: true })).resolves.toMatchObject({
      pendingTools: [expect.objectContaining({ executionId: 'exec-1', reason: 'committed-without-message' })],
    });
  });

  it('rejects a compaction snapshot that fabricates a tool projection', async () => {
    const store = new FileSessionStore(path);
    const call = { id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' };
    const assistant: Message = { role: 'assistant', requestId: 'req-1', toolCalls: [call] };
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
    }));
    await store.sync([sys, assistant]);
    await store.recordToolPlanned({
      t: 'tool', phase: 'planned', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0, call,
    });
    await store.recordToolCommitted({
      t: 'tool', phase: 'committed', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0,
      result: summarizeToolResult({ callId: 'call-1', content: 'A' }),
    });
    await store.checkpoint([sys, assistant, { role: 'tool', toolCallId: 'call-1', content: 'A', executionId: 'exec-1' }]);

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow(/compaction introduces tool projection without historical message/);
  });

  it('rejects an unknown file effect encoded as committed', async () => {
    const store = new FileSessionStore(path);
    const call = { id: 'call-1', name: 'write', arguments: '{"path":"a.txt","content":"x","createOnly":true}' };
    const assistant: Message = { role: 'assistant', requestId: 'req-1', toolCalls: [call] };
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    await store.sync([sys]);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
    }));
    await store.sync([sys, assistant]);
    await store.recordToolPlanned({
      t: 'tool', phase: 'planned', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0, call,
    });
    await store.recordToolCommitted({
      t: 'tool', phase: 'committed', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1', turn: 0, callIndex: 0,
      result: summarizeToolResult({
        callId: 'call-1', content: '', error: 'uncertain',
        fileReceipt: { kind: 'write', path: 'a.txt', precondition: 'createOnly', outcome: 'unknown' },
      }),
    });

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow(/committed receipt contains unknown file effect/);
  });

  it('reports composition differences without changing either input', () => {
    const changed = createSessionComposition({
      root: 'goal',
      runtimeVersion: 'next',
      permissionMode: 'unattended',
      toolSchemas: [],
      systemPrompt: 'sys',
      dynamicAddendum: noDynamicAddendum,
    });
    expect(diffSessionComposition(composition, changed).map((item) => item.field)).toEqual(
      expect.arrayContaining(['root', 'runtimeVersion', 'permissionMode']),
    );
    expect(composition.root).toBe('repl');
  });

  it('detects tool-schema and system-prompt drift under full composition coverage', () => {
    const baseline = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive',
      toolSchemas: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
      systemPrompt: 'prompt A',
      dynamicAddendum: noDynamicAddendum,
    });
    const changedTool = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive',
      toolSchemas: [{ name: 'vision', description: 'vision', parameters: { type: 'object' } }],
      systemPrompt: 'prompt A',
      dynamicAddendum: noDynamicAddendum,
    });
    const changedPrompt = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive',
      toolSchemas: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
      systemPrompt: 'prompt B',
      dynamicAddendum: noDynamicAddendum,
    });

    expect(baseline.coverage).toBe('full');
    expect(diffSessionComposition(baseline, changedTool).map((item) => item.field)).toContain('toolsetHash');
    expect(diffSessionComposition(baseline, changedPrompt).map((item) => item.field)).toContain('systemPromptHash');
  });

  it('detects dynamic addendum source and manifest drift without persisting the manifest body', () => {
    const baseline = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum: { source: 'skill-registry-v1', manifest: [{ name: 'commit', body: 'A' }] },
    });
    const changedManifest = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum: { source: 'skill-registry-v1', manifest: [{ name: 'commit', body: 'B' }] },
    });
    const changedSource = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum: { source: 'skill-registry-v2', manifest: [{ name: 'commit', body: 'A' }] },
    });

    expect(baseline).not.toHaveProperty('dynamicAddendumManifest');
    expect(diffSessionComposition(baseline, changedManifest).map((item) => item.field)).toContain('dynamicAddendumManifestHash');
    expect(diffSessionComposition(baseline, changedSource).map((item) => item.field)).toContain('dynamicAddendumSource');
  });

  it('validates every request addendum against the first user activation in its run', async () => {
    const dynamicAddendum = {
      source: 'skill-registry-v1',
      manifest: [{ name: 'commit', triggers: ['commit'], body: 'RULES' }],
    } as const;
    const expectedComposition = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum,
    });
    const resolve = (text: string): string => `catalog\n${text.includes('commit') ? 'RULES' : ''}`;
    const messages1: Message[] = [sys, user('please commit this')];
    const assistant1: Message = { role: 'assistant', requestId: 'req-1', content: 'working' };
    const messages2: Message[] = [...messages1, assistant1, user('[PostToolUse feedback]')];
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition: expectedComposition });
    await store.sync(messages1);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: messages1, systemAddendum: resolve('please commit this'), tools: [],
    }));
    await store.sync([...messages1, assistant1]);
    await store.sync(messages2);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-2', runId: 'run-1', turn: 1, messages: messages2, systemAddendum: resolve('please commit this'), tools: [],
    }));
    await store.sync([...messages2, { role: 'assistant', requestId: 'req-2', content: 'done' }]);

    await expect(loadSession(path, {
      requireHeader: true,
      resume: { expectedComposition, resolveDynamicAddendum: resolve },
    })).resolves.toMatchObject({ requests: [{ requestId: 'req-1' }, { requestId: 'req-2' }] });
  });

  it('fails resume as needs-human composition drift before evaluating stale request addenda', async () => {
    const recordedComposition = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum: { source: 'skill-registry-v1', manifest: [{ name: 'commit', body: 'old' }] },
    });
    const currentComposition = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum: { source: 'skill-registry-v1', manifest: [{ name: 'commit', body: 'new' }] },
    });
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition: recordedComposition });
    await store.sync([sys, user('commit')]);

    const error = await loadSession(path, {
      requireHeader: true,
      resume: { expectedComposition: currentComposition, resolveDynamicAddendum: () => 'new' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionCompositionMismatchError);
    expect(error).toMatchObject({ differences: [expect.objectContaining({ field: 'dynamicAddendumManifestHash' })] });
  });

  it('fails resume when an older v2 header lacks dynamic provenance', async () => {
    const legacyV2Composition = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
    });
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition: legacyV2Composition });

    await expect(loadSession(path, {
      requireHeader: true,
      resume: { expectedComposition: composition, resolveDynamicAddendum: resolveNoDynamicAddendum },
    })).rejects.toBeInstanceOf(SessionCompositionMismatchError);
  });

  it('treats a request addendum mismatch under identical provenance as corrupt state', async () => {
    const dynamicComposition = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum: { source: 'skill-registry-v1', manifest: [{ name: 'commit', body: 'RULES' }] },
    });
    const messages: Message[] = [sys, user('commit')];
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition: dynamicComposition });
    await store.sync(messages);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages, systemAddendum: 'forged', tools: [],
    }));

    await expect(loadSession(path, {
      requireHeader: true,
      resume: { expectedComposition: dynamicComposition, resolveDynamicAddendum: () => 'expected' },
    })).rejects.toThrow(/dynamic addendum receipt mismatch/);
  });

  it('fails closed when a dynamic request has no durable user activation to replay', async () => {
    const dynamicComposition = createSessionComposition({
      root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'sys',
      dynamicAddendum: { source: 'skill-registry-v1', manifest: [] },
    });
    const messages: Message[] = [sys];
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition: dynamicComposition });
    await store.sync(messages);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages, systemAddendum: '', tools: [],
    }));

    await expect(loadSession(path, {
      requireHeader: true,
      resume: { expectedComposition: dynamicComposition, resolveDynamicAddendum: () => '' },
    })).rejects.toThrow(/dynamic addendum activation is ambiguous/);
  });

  it('rejects a v2 header with only one half of dynamic provenance as an invalid record', async () => {
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 's1', model: 'm', cwd: dir, startedAt: 'now', composition });
    const [headerLine] = (await readFile(path, 'utf8')).trim().split('\n');
    const header = JSON.parse(headerLine) as { composition: Record<string, unknown> };
    delete header.composition.dynamicAddendumManifestHash;
    await writeFile(path, `${JSON.stringify(header)}\n`, 'utf8');

    await expect(loadSession(path, { requireHeader: true })).rejects.toThrow(/invalid-record/);
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

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: fixture filesystem failure`), { code });
}
