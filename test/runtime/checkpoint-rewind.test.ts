import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../src/core/types.js';
import {
  FileCheckpointAuditStore,
  SessionCheckpointRecorder,
  applyConversationRewind,
  prepareConversationRewind,
} from '../../src/runtime/checkpoint/index.js';
import {
  FileSessionStore,
  NO_DYNAMIC_ADDENDUM,
  createModelRequestReceipt,
  createSessionComposition,
  loadSessionLog,
} from '../../src/runtime/session/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('conversation checkpoint rewind', () => {
  it('creates a fresh v2 Session from the checkpoint projection and leaves the source byte-identical', async () => {
    const fixture = await rewindFixture();
    const sourceBefore = await readFile(fixture.sessionPath, 'utf8');
    const plan = await prepareConversationRewind({
      cwd: fixture.cwd,
      sourceSessionId: fixture.sessionId,
      checkpointId: fixture.checkpointId,
      forkSessionId: 'session-rewind-a',
      createRewindId: () => 'rewind-a',
    });

    expect(plan).toMatchObject({
      sourceSessionId: fixture.sessionId,
      checkpointId: fixture.checkpointId,
      forkSessionId: 'session-rewind-a',
      targetMessageCount: 3,
      afterCheckpoint: { managedFileWrites: 0, external: 'none-observed' },
    });
    const result = await applyConversationRewind(plan);

    expect(result).toMatchObject({ status: 'created', forkSessionId: 'session-rewind-a', messageCount: 3 });
    expect(await readFile(fixture.sessionPath, 'utf8')).toBe(sourceBefore);
    const fork = await loadSessionLog(result.path, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: 'session-rewind-a',
    });
    expect(fork.loaded.messages).toEqual(fixture.expectedForkMessages);
    expect(fork.loaded.requests).toEqual([]);
    expect(fork.loaded.toolReceipts).toEqual([]);
    expect(fork.loaded.header).toMatchObject({ id: 'session-rewind-a', model: 'fixture-model', cwd: fixture.cwd });
    const audit = await fixture.loadAudit();
    expect(audit.records.slice(-2)).toEqual([
      expect.objectContaining({ t: 'rewind', rewindId: 'rewind-a', outcome: 'planned' }),
      expect.objectContaining({ t: 'rewind', rewindId: 'rewind-a', outcome: 'created', forkSessionId: 'session-rewind-a' }),
    ]);
  });

  it('refuses a source with an unresolved tool effect even when the checkpoint predates it', async () => {
    const fixture = await rewindFixture();
    await fixture.store.recordRequest(createModelRequestReceipt({
      requestId: 'request-pending',
      runId: 'run-pending',
      turn: 0,
      messages: fixture.allMessages,
      tools: [],
    }));
    const assistant: Message = {
      role: 'assistant',
      requestId: 'request-pending',
      toolCalls: [{ id: 'call-pending', name: 'write', arguments: '{}' }],
    };
    fixture.allMessages.push(assistant);
    await fixture.store.sync(fixture.allMessages);
    await fixture.store.recordToolPlanned({
      t: 'tool',
      phase: 'planned',
      executionId: 'execution-pending',
      requestId: 'request-pending',
      runId: 'run-pending',
      turn: 0,
      callIndex: 0,
      call: { id: 'call-pending', name: 'write', arguments: '{}' },
    });

    await expect(prepareConversationRewind({
      cwd: fixture.cwd,
      sourceSessionId: fixture.sessionId,
      checkpointId: fixture.checkpointId,
    })).rejects.toThrow(/unresolved tool execution/u);
  });

  it('refuses source drift between preview and apply before creating a fork', async () => {
    const fixture = await rewindFixture();
    const plan = await prepareConversationRewind({
      cwd: fixture.cwd,
      sourceSessionId: fixture.sessionId,
      checkpointId: fixture.checkpointId,
      forkSessionId: 'session-rewind-drift',
      createRewindId: () => 'rewind-drift',
    });
    fixture.allMessages.push({ role: 'user', content: 'concurrent append' });
    await fixture.store.sync(fixture.allMessages);

    await expect(applyConversationRewind(plan)).rejects.toThrow(/changed after rewind preview/u);
    await expect(readFile(join(fixture.cwd, 'data', 'sessions', 'session-rewind-drift.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks tool-bound history ineligible instead of copying or fabricating receipts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint tool history '));
    tempDirs.push(cwd);
    const sessionId = 'session-tool-history';
    const sessionPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
    const store = new FileSessionStore(sessionPath);
    const initial: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'read a file' },
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
    await store.sync(initial);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'request-tool',
      runId: 'run-tool',
      turn: 0,
      messages: initial,
      tools: [],
    }));
    const assistant: Message = {
      role: 'assistant',
      requestId: 'request-tool',
      toolCalls: [{ id: 'call-tool', name: 'read', arguments: '{}' }],
    };
    const messages = [...initial, assistant];
    await store.sync(messages);
    await store.recordToolPlanned({
      t: 'tool',
      phase: 'planned',
      executionId: 'execution-tool',
      requestId: 'request-tool',
      runId: 'run-tool',
      turn: 0,
      callIndex: 0,
      call: { id: 'call-tool', name: 'read', arguments: '{}' },
    });
    await store.recordToolCommitted({
      t: 'tool',
      phase: 'committed',
      executionId: 'execution-tool',
      requestId: 'request-tool',
      runId: 'run-tool',
      turn: 0,
      callIndex: 0,
      result: { callId: 'call-tool', contentLength: 2, contentHash: 'sha256.fixture' },
    });
    messages.push({ role: 'tool', toolCallId: 'call-tool', executionId: 'execution-tool', content: 'ok' });
    await store.sync(messages);
    const audit = new FileCheckpointAuditStore({ cwd, sessionId, createId: () => 'cp-tool' });
    const checkpoint = await new SessionCheckpointRecorder({
      cwd,
      sessionId,
      sessionPath,
      auditStore: audit,
    }).capture('manual', messages);

    expect(checkpoint.effects).toMatchObject({ canRewindConversation: false, canRewindFiles: false });
    await expect(prepareConversationRewind({
      cwd,
      sourceSessionId: sessionId,
      checkpointId: checkpoint.checkpointId,
    })).rejects.toThrow(/not eligible/u);
  });

  it('refuses legacy v1 and partial-composition sources', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint rewind incompatible '));
    tempDirs.push(cwd);
    const legacyId = 'legacy-session';
    const legacyPath = join(cwd, 'data', 'sessions', `${legacyId}.jsonl`);
    const legacy = new FileSessionStore(legacyPath, 0, { format: 'v1' });
    await legacy.writeHeader({
      id: legacyId,
      model: 'fixture-model',
      cwd,
      startedAt: '2026-08-15T12:00:00.000Z',
      composition: createSessionComposition({ root: 'repl', runtimeVersion: '0.1.0', permissionMode: 'interactive' }),
    });
    const legacyMessages: Message[] = [{ role: 'system', content: 'system' }];
    await legacy.sync(legacyMessages);
    const audit = new FileCheckpointAuditStore({ cwd, sessionId: legacyId, createId: () => 'cp-legacy' });
    await audit.appendCheckpoint({
      phase: 'manual',
      cursor: { sessionSeq: 0, recordCount: 2, messageCount: 1 },
      shadow: { status: 'unavailable', reason: 'disabled' },
      effects: {
        managedFileWrites: 0,
        external: 'none-observed',
        canRewindConversation: false,
        canRewindFiles: false,
      },
    });

    await expect(prepareConversationRewind({
      cwd,
      sourceSessionId: legacyId,
      checkpointId: 'cp-legacy',
    })).rejects.toThrow(/fully recorded v2 session/u);
  });
});

async function rewindFixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint rewind '));
  tempDirs.push(cwd);
  const sessionId = 'session-source';
  const sessionPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
  const store = new FileSessionStore(sessionPath);
  const checkpointMessages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'checkpoint prompt' },
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
  await store.sync(checkpointMessages);
  await store.recordRequest(createModelRequestReceipt({
    requestId: 'request-complete',
    runId: 'run-complete',
    turn: 0,
    messages: checkpointMessages,
    tools: [],
  }));
  checkpointMessages.push({ role: 'assistant', requestId: 'request-complete', content: 'checkpoint answer' });
  await store.sync(checkpointMessages);
  const auditStore = new FileCheckpointAuditStore({
    cwd,
    sessionId,
    createId: () => 'cp-target',
  });
  const recorder = new SessionCheckpointRecorder({
    cwd,
    sessionId,
    sessionPath,
    auditStore,
  });
  const checkpoint = await recorder.capture('manual', checkpointMessages);
  const allMessages: Message[] = [
    ...checkpointMessages,
    { role: 'user', content: 'later prompt' },
  ];
  await store.sync(allMessages);
  return {
    cwd,
    sessionId,
    sessionPath,
    store,
    checkpointId: checkpoint.checkpointId,
    checkpointMessages,
    expectedForkMessages: checkpointMessages.map((message) => message.role === 'assistant'
      ? { role: 'assistant' as const, content: message.content }
      : message),
    allMessages,
    loadAudit: () => import('../../src/runtime/checkpoint/index.js')
      .then(({ loadCheckpointAudit }) => loadCheckpointAudit({ cwd, sessionId })),
  };
}
