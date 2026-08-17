import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../src/core/types.js';
import {
  FileSessionStore,
  NO_DYNAMIC_ADDENDUM,
  createModelRequestReceipt,
  createSessionComposition,
  loadSessionLog,
} from '../../src/runtime/session/index.js';
import {
  forkSession,
  moveSession,
  parseSessionMutationLog,
  renameSession,
  type SessionMutationRecord,
  type SessionMutationStore,
} from '../../src/runtime/session/mutations.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('session fork', () => {
  it('creates a full-fidelity v2 copy with receipts intact, lineage recorded, and the source untouched', async () => {
    const fixture = await receiptFixture('fork-basic');
    const sourceBefore = await readFile(fixture.sessionPath, 'utf8');

    const result = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: 'fork-target' });

    expect(result).toMatchObject({ status: 'created', forkSessionId: 'fork-target', format: 'v2' });
    expect(await readFile(fixture.sessionPath, 'utf8')).toBe(sourceBefore);
    const fork = await loadSessionLog(join(fixture.cwd, 'data', 'sessions', 'fork-target.jsonl'), {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: 'fork-target',
    });
    expect(fork.loaded.header).toMatchObject({ id: 'fork-target', forkedFrom: fixture.sessionId });
    expect(fork.loaded.requests).toHaveLength(1);
    expect(fork.loaded.toolReceipts).toHaveLength(2);
    expect(fork.loaded.pendingTools).toEqual([]);
    expect(fork.loaded.messages).toHaveLength(fixture.expectedMessageCount);

    const log = parseSessionMutationLog(await readFile(join(fixture.cwd, 'data', 'session-mutations.jsonl'), 'utf8'));
    expect(log.records.map((record) => record.outcome)).toEqual(['planned', 'created']);
    expect(log.records[0]).toMatchObject({ kind: 'fork', sourceSessionId: fixture.sessionId, targetSessionId: 'fork-target', seq: 1 });
  });

  it('blocks the fork when the source changes between preview and write', async () => {
    const fixture = await receiptFixture('fork-drift');
    let calls = 0;
    const tamperingStore: SessionMutationStore = {
      append: async (input) => {
        calls += 1;
        if (calls === 1) await appendFile(fixture.sessionPath, '{"t":"message","message":{"role":"user","content":"concurrent"}}\n');
        return fakeRecord(input.outcome);
      },
    };

    const result = await forkSession({
      cwd: fixture.cwd,
      sourceSessionId: fixture.sessionId,
      targetSessionId: 'fork-drift-target',
      io: { mutationStore: tamperingStore },
    });

    expect(result).toMatchObject({ status: 'blocked' });
    expect(calls).toBe(2); // planned + blocked
    await expect(readFile(join(fixture.cwd, 'data', 'sessions', 'fork-drift-target.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('refuses a source with pending tool effects and records nothing', async () => {
    const fixture = await receiptFixture('fork-pending');
    const pending: Message = { role: 'assistant', requestId: 'req-pending', toolCalls: [{ id: 'call-p', name: 'write', arguments: '{}' }] };
    fixture.messages.push({ role: 'user', content: 'later' });
    await fixture.store.sync(fixture.messages);
    await fixture.store.recordRequest(createModelRequestReceipt({
      requestId: 'req-pending',
      runId: 'run-pending',
      turn: 1,
      messages: fixture.messages,
      tools: [],
    }));
    fixture.messages.push(pending);
    await fixture.store.sync(fixture.messages);
    await fixture.store.recordToolPlanned({
      t: 'tool',
      phase: 'planned',
      executionId: 'exec-pending',
      requestId: 'req-pending',
      runId: 'run-pending',
      turn: 1,
      callIndex: 0,
      call: { id: 'call-p', name: 'write', arguments: '{}' },
    });

    const result = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: 'fork-pending-target' });

    expect(result).toMatchObject({ status: 'refused' });
    await expect(readFile(join(fixture.cwd, 'data', 'sessions', 'fork-pending-target.jsonl'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(fixture.cwd, 'data', 'session-mutations.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('refuses a v2 source with partial composition', async () => {
    const cwd = await workspace('fork-partial');
    const sessionId = 'partial-source';
    const store = new FileSessionStore(join(cwd, 'data', 'sessions', `${sessionId}.jsonl`));
    await store.writeHeader({
      id: sessionId,
      model: 'fixture-model',
      cwd,
      startedAt: '2026-08-15T12:00:00.000Z',
      composition: {
        root: 'repl',
        runtimeVersion: '0.1.0',
        permissionMode: 'interactive',
        coverage: 'partial',
      },
    });
    await store.sync([{ role: 'user', content: 'q' }]);

    const partial = await forkSession({ cwd, sourceSessionId: sessionId, targetSessionId: 'fork-anything' });
    expect(partial).toMatchObject({ status: 'refused' });
  });

  it('rejects conflicting or unsafe target ids before writing anything', async () => {
    const fixture = await receiptFixture('fork-targets');

    const same = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: fixture.sessionId });
    expect(same).toMatchObject({ status: 'invalid' });
    const unsafe = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: '../escape' });
    expect(unsafe).toMatchObject({ status: 'invalid' });
    const device = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: 'CON' });
    expect(device).toMatchObject({ status: 'invalid' });
    const taken = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: 'fork-taken' });
    expect(taken).toMatchObject({ status: 'created' });
    const conflict = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: 'fork-taken' });
    expect(conflict).toMatchObject({ status: 'invalid' });
  });

  it('fails closed when the mutation audit log is corrupt or truncated', async () => {
    const fixture = await receiptFixture('fork-audit');
    const logPath = join(fixture.cwd, 'data', 'session-mutations.jsonl');
    await writeFile(logPath, '{"schemaVersion":1,"seq":1,"at":"t","t":"session-mutation","mutationId":"m1","kind":"fork","sourceSessionId":"s","outcome":"planned"}\n{"broken":\n', 'utf8');

    const corrupt = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: 'fork-a' });
    expect(corrupt).toMatchObject({ status: 'failed' });

    await appendFile(logPath, '{"schemaVersion":1,"seq":2,"at":"t","t":"session-mutation","mutationId":"m2","kind":"fork","sourceSessionId":"s","outcome":"created"}\n{"schemaVersion":1,"seq":3,"at":"t","t":"sess', 'utf8');
    const truncated = await forkSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, targetSessionId: 'fork-b' });
    expect(truncated).toMatchObject({ status: 'failed' });
  });
});

describe('session archive/unarchive move', () => {
  it('archives and unarchives byte-identically, moving the checkpoint audit alongside', async () => {
    const fixture = await receiptFixture('move-roundtrip');
    const sourceBefore = await readFile(fixture.sessionPath, 'utf8');
    const auditPath = join(fixture.cwd, 'data', 'checkpoints', `${fixture.sessionId}.jsonl`);
    await mkdir(join(fixture.cwd, 'data', 'checkpoints'), { recursive: true });
    await writeFile(auditPath, '{"audit":true}\n', 'utf8');

    const archived = await moveSession({ cwd: fixture.cwd, sessionId: fixture.sessionId, direction: 'archive' });
    expect(archived).toMatchObject({ status: 'moved', sessionId: fixture.sessionId, warnings: [] });
    await expect(readFile(fixture.sessionPath, 'utf8')).rejects.toThrow();
    const archivedPath = join(fixture.cwd, 'data', 'sessions', 'archived', `${fixture.sessionId}.jsonl`);
    expect(await readFile(archivedPath, 'utf8')).toBe(sourceBefore);
    expect(await readFile(join(fixture.cwd, 'data', 'checkpoints', 'archived', `${fixture.sessionId}.jsonl`), 'utf8')).toBe('{"audit":true}\n');
    await expect(readFile(auditPath, 'utf8')).rejects.toThrow();

    const restored = await moveSession({ cwd: fixture.cwd, sessionId: fixture.sessionId, direction: 'unarchive' });
    expect(restored).toMatchObject({ status: 'moved', warnings: [] });
    expect(await readFile(fixture.sessionPath, 'utf8')).toBe(sourceBefore);
    expect(await readFile(auditPath, 'utf8')).toBe('{"audit":true}\n');
  });

  it('reports invalid state transitions and missing sessions without moving anything', async () => {
    const fixture = await receiptFixture('move-state');
    const missing = await moveSession({ cwd: fixture.cwd, sessionId: 'missing-id', direction: 'archive' });
    expect(missing).toMatchObject({ status: 'not-found' });

    await moveSession({ cwd: fixture.cwd, sessionId: fixture.sessionId, direction: 'archive' });
    const again = await moveSession({ cwd: fixture.cwd, sessionId: fixture.sessionId, direction: 'archive' });
    expect(again).toMatchObject({ status: 'invalid', reason: expect.stringContaining('already archived') });
    const notArchived = await moveSession({ cwd: fixture.cwd, sessionId: fixture.sessionId, direction: 'unarchive' });
    expect(notArchived.status).toBe('moved');
  });

  it('warns about pending tool effects on archive without refusing the move', async () => {
    const fixture = await receiptFixture('move-pending');
    fixture.messages.push({ role: 'user', content: 'later' });
    await fixture.store.sync(fixture.messages);
    await fixture.store.recordRequest(createModelRequestReceipt({
      requestId: 'req-p2',
      runId: 'run-p2',
      turn: 1,
      messages: fixture.messages,
      tools: [],
    }));
    fixture.messages.push({ role: 'assistant', requestId: 'req-p2', toolCalls: [{ id: 'call-p2', name: 'write', arguments: '{}' }] });
    await fixture.store.sync(fixture.messages);
    await fixture.store.recordToolPlanned({
      t: 'tool',
      phase: 'planned',
      executionId: 'exec-p2',
      requestId: 'req-p2',
      runId: 'run-p2',
      turn: 1,
      callIndex: 0,
      call: { id: 'call-p2', name: 'write', arguments: '{}' },
    });

    const result = await moveSession({ cwd: fixture.cwd, sessionId: fixture.sessionId, direction: 'archive' });

    expect(result).toMatchObject({ status: 'moved', pendingToolEffects: 1 });
  });

  it('reports a reappeared source path after the move instead of claiming a clean archive', async () => {
    const fixture = await receiptFixture('move-reappear');

    const result = await moveSession({
      cwd: fixture.cwd,
      sessionId: fixture.sessionId,
      direction: 'archive',
      io: {
        afterMove: async ({ from }) => {
          await writeFile(from, '{"t":"session","id":"recreated","model":"m","cwd":"c","startedAt":"t0"}\n', 'utf8');
        },
      },
    });

    expect(result).toMatchObject({ status: 'blocked' });
    expect((result as { reason?: string }).reason).toContain('reappeared');
    const archivedPath = join(fixture.cwd, 'data', 'sessions', 'archived', `${fixture.sessionId}.jsonl`);
    expect((await readFile(archivedPath, 'utf8')).length).toBeGreaterThan(0);
  });
});

describe('session rename (fork + archive)', () => {
  it('renames: new id active with lineage, original archived, rename summary audited', async () => {
    const fixture = await receiptFixture('rename-basic');

    const result = await renameSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, newSessionId: 'renamed-target' });

    expect(result).toMatchObject({ status: 'renamed', from: fixture.sessionId, to: 'renamed-target', warnings: [] });
    const fork = await loadSessionLog(join(fixture.cwd, 'data', 'sessions', 'renamed-target.jsonl'), {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: 'renamed-target',
    });
    expect(fork.loaded.header).toMatchObject({ id: 'renamed-target', forkedFrom: fixture.sessionId });
    await expect(readFile(fixture.sessionPath, 'utf8')).rejects.toThrow();
    const log = parseSessionMutationLog(await readFile(join(fixture.cwd, 'data', 'session-mutations.jsonl'), 'utf8'));
    expect(log.records.at(-1)).toMatchObject({ kind: 'rename', outcome: 'created', targetSessionId: 'renamed-target' });
  });

  it('stops at the fork step for a refused source and leaves the original active', async () => {
    const cwd = await workspace('rename-refused');
    const sessionId = 'partial-source';
    const store = new FileSessionStore(join(cwd, 'data', 'sessions', `${sessionId}.jsonl`));
    await store.writeHeader({
      id: sessionId,
      model: 'fixture-model',
      cwd,
      startedAt: '2026-08-15T12:00:00.000Z',
      composition: { root: 'repl', runtimeVersion: '0.1.0', permissionMode: 'interactive', coverage: 'partial' },
    });
    await store.sync([{ role: 'user', content: 'q' }]);

    const result = await renameSession({ cwd, sourceSessionId: sessionId, newSessionId: 'never-created' });

    expect(result).toMatchObject({ status: 'refused' });
    await expect(readFile(join(cwd, 'data', 'sessions', `${sessionId}.jsonl`), 'utf8')).resolves.toContain(sessionId);
    await expect(readFile(join(cwd, 'data', 'sessions', 'never-created.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('reports a partial rename when the fork succeeded but the archive destination is occupied', async () => {
    const fixture = await receiptFixture('rename-partial');
    const archivedDir = join(fixture.cwd, 'data', 'sessions', 'archived');
    await mkdir(archivedDir, { recursive: true });
    await writeFile(join(archivedDir, `${fixture.sessionId}.jsonl`), '{"t":"session","id":"other","model":"m","cwd":"c","startedAt":"t0"}\n', 'utf8');

    const result = await renameSession({ cwd: fixture.cwd, sourceSessionId: fixture.sessionId, newSessionId: 'rename-orphan' });

    expect(result).toMatchObject({ status: 'partial', forkSessionId: 'rename-orphan' });
    expect((await readFile(join(fixture.cwd, 'data', 'sessions', 'rename-orphan.jsonl'), 'utf8')).length).toBeGreaterThan(0);
    expect((await readFile(fixture.sessionPath, 'utf8')).length).toBeGreaterThan(0);
    const log = parseSessionMutationLog(await readFile(join(fixture.cwd, 'data', 'session-mutations.jsonl'), 'utf8'));
    expect(log.records.at(-1)).toMatchObject({ kind: 'rename', outcome: 'failed' });
  });
});

async function workspace(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `jarvis session mutations ${prefix} `));
  tempDirs.push(cwd);
  await mkdir(join(cwd, 'data', 'sessions'), { recursive: true });
  return cwd;
}

async function receiptFixture(prefix: string) {
  const cwd = await workspace(prefix);
  const sessionId = `${prefix}-source`;
  const sessionPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
  const store = new FileSessionStore(sessionPath);
  const messages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'prompt' },
  ];
  await store.writeHeader({
    id: sessionId,
    model: 'fixture-model',
    cwd,
    startedAt: '2026-08-15T12:00:00.000Z',
    composition: createSessionComposition({
      root: 'repl',
      runtimeVersion: '0.1.0',
      permissionMode: 'interactive',
      toolSchemas: [],
      systemPrompt: 'system',
      dynamicAddendum: NO_DYNAMIC_ADDENDUM,
    }),
  });
  await store.sync(messages);
  await store.recordRequest(createModelRequestReceipt({
    requestId: 'req-1',
    runId: 'run-1',
    turn: 0,
    messages,
    tools: [],
  }));
  messages.push({
    role: 'assistant',
    requestId: 'req-1',
    toolCalls: [{ id: 'call-1', name: 'read', arguments: '{}' }],
  });
  await store.sync(messages);
  await store.recordToolPlanned({
    t: 'tool',
    phase: 'planned',
    executionId: 'exec-1',
    requestId: 'req-1',
    runId: 'run-1',
    turn: 0,
    callIndex: 0,
    call: { id: 'call-1', name: 'read', arguments: '{}' },
  });
  await store.recordToolCommitted({
    t: 'tool',
    phase: 'committed',
    executionId: 'exec-1',
    requestId: 'req-1',
    runId: 'run-1',
    turn: 0,
    callIndex: 0,
    result: { callId: 'call-1', contentLength: 2, contentHash: 'sha256.fixture' },
  });
  messages.push({ role: 'tool', toolCallId: 'call-1', executionId: 'exec-1', content: 'ok' });
  await store.sync(messages);
  return { cwd, sessionId, sessionPath, store, messages, expectedMessageCount: messages.length };
}

function fakeRecord(outcome: SessionMutationRecord['outcome']): SessionMutationRecord {
  return {
    schemaVersion: 1,
    seq: 1,
    at: 't',
    t: 'session-mutation',
    mutationId: 'mut-fake',
    kind: 'fork',
    sourceSessionId: 's',
    outcome,
  };
}
