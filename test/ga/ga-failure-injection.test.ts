import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../../src/core/loop/run-agent.js';
import { DoubaoProvider } from '../../src/core/model/doubao-provider.js';
import {
  emptyStreamState,
  finalizeResult,
  foldChunk,
  type StreamChunk,
} from '../../src/core/model/stream.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import type { Message } from '../../src/core/types.js';
import {
  FileCheckpointAuditStore,
  SessionCheckpointRecorder,
  applyConversationRewind,
  prepareConversationRewind,
} from '../../src/runtime/checkpoint/index.js';
import { InMemoryEventBus, type Event } from '../../src/runtime/event-bus.js';
import {
  FileSessionStore,
  NO_DYNAMIC_ADDENDUM,
  createModelRequestReceipt,
  createSessionComposition,
  loadSessionLog,
  resolveNoDynamicAddendum,
  resolveSessionFilePath,
} from '../../src/runtime/session/index.js';
import { loadResumeSessionForCli } from '../../src/surfaces/cli/repl-resume.js';
import {
  forkSession,
  moveSession,
  parseSessionMutationLog,
} from '../../src/runtime/session/mutations.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GA-1 Session monotonic persistence fault injection', () => {
  it('keeps the source append-only across restart, resume, fork, archive, and rewind', async () => {
    const cwd = await workspace('ga-session-monotonic');
    const sessionId = 'ga-long-source';
    const sessionPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
    const store = new FileSessionStore(sessionPath);
    const messages: Message[] = [{ role: 'system', content: 'GA system' }];
    await store.writeHeader({
      id: sessionId,
      model: 'ga-fixture-model',
      cwd,
      startedAt: '2026-08-23T00:00:00.000Z',
      composition: composition('GA system'),
    });

    let previousRaw = await readFile(sessionPath, 'utf8');
    for (let batch = 0; batch < 4; batch++) {
      appendTurns(messages, batch * 20, 20);
      await store.sync(messages);
      previousRaw = await expectMonotonicSession(sessionPath, messages, previousRaw);
    }

    await store.recordRequest(createModelRequestReceipt({
      requestId: 'ga-text-request',
      runId: 'ga-run',
      turn: 80,
      messages,
      tools: [],
    }));
    messages.push({ role: 'assistant', requestId: 'ga-text-request', content: 'receipt-bound reply' });
    await store.sync(messages);
    await store.checkpoint(messages);
    previousRaw = await expectMonotonicSession(sessionPath, messages, previousRaw);

    const checkpointMessages = structuredClone(messages);
    const auditStore = new FileCheckpointAuditStore({
      cwd,
      sessionId,
      createId: () => 'ga-checkpoint',
    });
    const recorder = new SessionCheckpointRecorder({ cwd, sessionId, sessionPath, auditStore });
    const checkpoint = await recorder.capture('manual', checkpointMessages);

    appendTurns(messages, 80, 20);
    await store.sync(messages);
    await store.recordRequest(createModelRequestReceipt({
      requestId: 'ga-tool-request',
      runId: 'ga-run',
      turn: 100,
      messages,
      tools: [],
    }));
    messages.push({
      role: 'assistant',
      requestId: 'ga-tool-request',
      toolCalls: [{ id: 'ga-tool-call', name: 'read', arguments: '{}' }],
    });
    await store.sync(messages);
    await store.recordToolPlanned({
      t: 'tool',
      phase: 'planned',
      executionId: 'ga-tool-execution',
      requestId: 'ga-tool-request',
      runId: 'ga-run',
      turn: 100,
      callIndex: 0,
      call: { id: 'ga-tool-call', name: 'read', arguments: '{}' },
    });
    await store.recordToolCommitted({
      t: 'tool',
      phase: 'committed',
      executionId: 'ga-tool-execution',
      requestId: 'ga-tool-request',
      runId: 'ga-run',
      turn: 100,
      callIndex: 0,
      result: { callId: 'ga-tool-call', contentLength: 2, contentHash: 'sha256.ga-fixture' },
    });
    messages.push({
      role: 'tool',
      toolCallId: 'ga-tool-call',
      executionId: 'ga-tool-execution',
      content: 'ok',
    });
    await store.sync(messages);
    previousRaw = await expectMonotonicSession(sessionPath, messages, previousRaw);

    for (let batch = 5; batch < 8; batch++) {
      appendTurns(messages, batch * 20, 20);
      await store.sync(messages);
      previousRaw = await expectMonotonicSession(sessionPath, messages, previousRaw);
    }

    const resolution = await resolveSessionFilePath({ cwd, sessionId });
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') throw new Error(`session resolution failed: ${resolution.status}`);
    const resumed = await loadResumeSessionForCli(resolution, {
      requireHeader: true,
      expectedSessionId: sessionId,
      resume: {
        expectedComposition: composition('GA system'),
        resolveDynamicAddendum: resolveNoDynamicAddendum,
      },
    });
    expect(resumed.status).toBe('ok');
    if (resumed.status !== 'ok') throw new Error(`production resume failed: ${resumed.status}`);
    expect(resumed.loaded).toMatchObject({ format: 'v2', pendingTools: [] });
    expect(resumed.loaded.header).toMatchObject({ model: 'ga-fixture-model', cwd });
    const resumedMessages = structuredClone(resumed.loaded.messages);
    const resumedStore = new FileSessionStore(sessionPath, resumedMessages.length, {
      format: 'v2',
      initialSequence: resumed.loaded.lastSequence,
    });
    appendTurns(resumedMessages, 160, 20);
    await resumedStore.sync(resumedMessages);
    const sourceAfterResume = await expectMonotonicSession(sessionPath, resumedMessages, previousRaw);
    const sourceAfterResumeLog = await loadSessionLog(sessionPath, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: sessionId,
    });

    const forked = await forkSession({
      cwd,
      sourceSessionId: sessionId,
      targetSessionId: 'ga-full-fork',
    });
    expect(forked).toMatchObject({ status: 'created', recordCount: sourceAfterResumeLog.records.length });
    expect(await readFile(sessionPath, 'utf8')).toBe(sourceAfterResume);
    const forkLog = await loadSessionLog(join(cwd, 'data', 'sessions', 'ga-full-fork.jsonl'), {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: 'ga-full-fork',
    });
    expect(forkLog.loaded.messages).toEqual(resumedMessages);
    expect(forkLog.loaded.header).toMatchObject({ id: 'ga-full-fork', forkedFrom: sessionId });
    expect(forkLog.records.map((record) => record.t)).toEqual(sourceAfterResumeLog.records.map((record) => record.t));
    expect(forkLog.loaded.requests.map(withoutV2Envelope))
      .toEqual(sourceAfterResumeLog.loaded.requests.map(withoutV2Envelope));
    expect(forkLog.loaded.toolReceipts.map(withoutV2Envelope))
      .toEqual(sourceAfterResumeLog.loaded.toolReceipts.map(withoutV2Envelope));
    expect(forkLog.records.filter((record) => record.t === 'compaction').map((record) => record.messages))
      .toEqual(sourceAfterResumeLog.records.filter((record) => record.t === 'compaction').map((record) => record.messages));
    expect(forkLog.loaded.pendingTools).toEqual([]);
    expectContinuousSequence(forkLog.records);

    const archived = await moveSession({ cwd, sessionId, direction: 'archive' });
    expect(archived).toMatchObject({ status: 'moved' });
    const archivedPath = join(cwd, 'data', 'sessions', 'archived', `${sessionId}.jsonl`);
    expect(await readFile(archivedPath, 'utf8')).toBe(sourceAfterResume);
    const restored = await moveSession({ cwd, sessionId, direction: 'unarchive' });
    expect(restored).toMatchObject({ status: 'moved' });
    expect(await readFile(sessionPath, 'utf8')).toBe(sourceAfterResume);

    const rewindPlan = await prepareConversationRewind({
      cwd,
      sourceSessionId: sessionId,
      checkpointId: checkpoint.checkpointId,
      forkSessionId: 'ga-rewind-fork',
      createRewindId: () => 'ga-rewind',
    });
    const rewound = await applyConversationRewind(rewindPlan);
    expect(rewound).toMatchObject({ status: 'created', messageCount: checkpointMessages.length });
    expect(await readFile(sessionPath, 'utf8')).toBe(sourceAfterResume);
    const sourceFinal = await loadSessionLog(sessionPath, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: sessionId,
    });
    expect(sourceFinal.loaded.messages).toEqual(resumedMessages);
    expectContinuousSequence(sourceFinal.records);
    const rewindFork = await loadSessionLog(rewound.path, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: 'ga-rewind-fork',
    });
    expect(rewindFork.loaded.messages).toEqual(receiptFreeMessages(checkpointMessages));
    expect(rewindFork.loaded.requests).toEqual([]);
    expect(rewindFork.loaded.toolReceipts).toEqual([]);
    expectContinuousSequence(rewindFork.records);

    const mutationLog = parseSessionMutationLog(
      await readFile(join(cwd, 'data', 'session-mutations.jsonl'), 'utf8'),
    );
    expect(mutationLog.records.map((record) => record.seq))
      .toEqual(mutationLog.records.map((_, index) => index + 1));
  });
});

describe('GA-2 abnormal stream zero-duplication fault injection', () => {
  it.each([
    { label: 'missing', rawFinishReason: undefined, expectedRaw: '' },
    { label: 'unknown', rawFinishReason: 'future_reason', expectedRaw: 'future_reason' },
  ])('halts one $label finish without retrying, duplicating the reply, or dispatching its tool', async ({ rawFinishReason, expectedRaw }) => {
    const fixture = await agentFixture(`ga-${expectedRaw || 'missing'}`);
    const scripted = abnormalFinishProvider(rawFinishReason);

    const outcome = await runAgent({
      model: scripted.provider,
      tools: fixture.tools,
      bus: fixture.bus,
      store: fixture.store,
      sessionId: fixture.sessionId,
      messages: fixture.messages,
      toolCtx: { cwd: fixture.cwd },
      budget: { maxTurns: 4 },
    });

    expect(outcome).toEqual({ halted: 'unknown', turns: 1, rawFinishReason: expectedRaw });
    expect(scripted.calls()).toBe(1);
    expect(fixture.toolRuns()).toBe(0);
    expect(fixture.events.filter((event) => event.type === 'halt')).toEqual([
      { type: 'halt', reason: 'unknown', rawFinishReason: expectedRaw },
    ]);
    expect(fixture.events.some((event) => event.type === 'final' || event.type === 'tool_call' || event.type === 'tool_result')).toBe(false);
    expect(fixture.events.filter((event) => event.type === 'model_finished')).toHaveLength(1);
    expect(fixture.events.find((event) => event.type === 'model_finished')).toMatchObject({ status: 'halted' });

    const persisted = await loadSessionLog(fixture.sessionPath, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: fixture.sessionId,
    });
    const assistantMessages = persisted.loaded.messages.filter((message) => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({ role: 'assistant', content: 'partial reply' });
    expect(assistantMessages[0]).toHaveProperty('requestId', expect.any(String));
    expect(persisted.loaded.toolReceipts).toEqual([]);
    expect(persisted.loaded.pendingTools).toEqual([]);
    expectContinuousSequence(persisted.records);
  });

  it('records one failed model lifecycle and no reply or orphan effect when the stream breaks after text', async () => {
    const fixture = await agentFixture('ga-stream-break');
    const scripted = interruptedProvider();

    await expect(runAgent({
      model: scripted.provider,
      tools: fixture.tools,
      bus: fixture.bus,
      store: fixture.store,
      sessionId: fixture.sessionId,
      messages: fixture.messages,
      toolCtx: { cwd: fixture.cwd },
      budget: { maxTurns: 4 },
    })).rejects.toThrow('injected stream interruption');

    expect(scripted.calls()).toBe(1);
    expect(fixture.toolRuns()).toBe(0);
    expect(fixture.events.filter((event) => event.type === 'model_finished')).toEqual([
      expect.objectContaining({ type: 'model_finished', status: 'failed' }),
    ]);
    expect(fixture.events.some((event) => event.type === 'final' || event.type === 'halt' || event.type === 'tool_call' || event.type === 'tool_result')).toBe(false);

    const persisted = await loadSessionLog(fixture.sessionPath, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: fixture.sessionId,
    });
    expect(persisted.loaded.messages.filter((message) => message.role === 'assistant')).toEqual([]);
    expect(persisted.loaded.requests).toHaveLength(1);
    expect(persisted.loaded.toolReceipts).toEqual([]);
    expect(persisted.loaded.pendingTools).toEqual([]);
    expectContinuousSequence(persisted.records);
  });
});

async function workspace(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `${prefix} `));
  tempDirs.push(cwd);
  await mkdir(join(cwd, 'data', 'sessions'), { recursive: true });
  return cwd;
}

function composition(systemPrompt: string) {
  return createSessionComposition({
    root: 'repl',
    runtimeVersion: '0.1.0',
    permissionMode: 'interactive',
    toolSchemas: [],
    systemPrompt,
    dynamicAddendum: NO_DYNAMIC_ADDENDUM,
  });
}

function appendTurns(messages: Message[], start: number, count: number): void {
  for (let index = start; index < start + count; index++) {
    messages.push({ role: 'user', content: `prompt-${index.toString().padStart(4, '0')}` });
    messages.push({ role: 'assistant', content: `reply-${index.toString().padStart(4, '0')}` });
  }
}

async function expectMonotonicSession(path: string, messages: Message[], previousRaw: string): Promise<string> {
  const raw = await readFile(path, 'utf8');
  expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(Buffer.byteLength(previousRaw, 'utf8'));
  expect(raw.startsWith(previousRaw)).toBe(true);
  const log = await loadSessionLog(path, { requireHeader: true, validateIntegrity: true });
  expect(log.loaded.messages).toEqual(messages);
  expectContinuousSequence(log.records);
  return raw;
}

function expectContinuousSequence(records: Awaited<ReturnType<typeof loadSessionLog>>['records']): void {
  expect(records.map((record) => 'seq' in record ? record.seq : undefined))
    .toEqual(records.map((_, index) => index + 1));
}

async function agentFixture(prefix: string) {
  const cwd = await workspace(prefix);
  const sessionId = `${prefix}-session`;
  const sessionPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
  const store = new FileSessionStore(sessionPath);
  await store.writeHeader({
    id: sessionId,
    model: 'ga-fixture-model',
    cwd,
    startedAt: '2026-08-23T00:00:00.000Z',
    composition: composition('GA system'),
  });
  const bus = new InMemoryEventBus();
  const events: Event[] = [];
  bus.subscribe((event) => events.push(event));
  let runs = 0;
  const tools = new InMemoryToolRegistry();
  tools.register({
    name: 'orphan_probe',
    description: 'must stay uncalled for abnormal streams',
    capability: 'read-only',
    inputSchema: z.object({}),
    run: async () => {
      runs++;
      return { content: 'unexpected side effect' };
    },
  });
  return {
    cwd,
    sessionId,
    sessionPath,
    store,
    bus,
    events,
    tools,
    messages: [{ role: 'system', content: 'GA system' }, { role: 'user', content: 'start' }] as Message[],
    toolRuns: () => runs,
  };
}

function abnormalFinishProvider(rawFinishReason: string | undefined) {
  let count = 0;
  const provider = providerFrom(async function* (): AsyncGenerator<ModelDelta, ModelResult> {
    count++;
    const state = emptyStreamState();
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: 'partial reply' } }] },
      {
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'orphan-call', function: { name: 'orphan_probe', arguments: '{}' } }] },
          ...(rawFinishReason === undefined ? {} : { finish_reason: rawFinishReason }),
        }],
      },
    ];
    for (const chunk of chunks) {
      for (const delta of foldChunk(state, chunk)) yield delta;
    }
    return finalizeResult(state);
  });
  return { provider, calls: () => count };
}

function interruptedProvider() {
  let count = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'partial reply' } }] };
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'orphan-stream-call',
              function: { name: 'orphan_probe', arguments: '{}' },
            }],
          },
        }],
      };
      throw new Error('injected stream interruption');
    },
  };
  const client = {
    chat: {
      completions: {
        create: async () => {
          count++;
          return stream;
        },
      },
    },
  } as unknown as OpenAI;
  const provider = new DoubaoProvider({
    provider: 'doubao',
    apiKey: 'fixture-key',
    model: 'ga-fixture-model',
  }, client);
  return { provider, calls: () => count };
}

function withoutV2Envelope<T extends { schemaVersion: number; seq: number; at: string }>(record: T) {
  const copy = { ...record } as Partial<T>;
  delete copy.schemaVersion;
  delete copy.seq;
  delete copy.at;
  return copy;
}

function receiptFreeMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || message.requestId === undefined) return { ...message };
    const projected = { ...message };
    delete projected.requestId;
    return projected;
  });
}

function providerFrom(call: ModelProvider['call']): ModelProvider {
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    call,
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}
