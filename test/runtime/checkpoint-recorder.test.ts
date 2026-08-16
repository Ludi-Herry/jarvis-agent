import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/core/types.js';
import {
  FileCheckpointAuditStore,
  SessionCheckpointRecorder,
} from '../../src/runtime/checkpoint/index.js';
import {
  FileSessionStore,
  NO_DYNAMIC_ADDENDUM,
  createSessionComposition,
} from '../../src/runtime/session/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SessionCheckpointRecorder', () => {
  it('captures a validated v2 cursor and ShadowGit ref without changing Session bytes', async () => {
    const fixture = await sessionFixture();
    const snapshot = vi.fn(async () => ({ ok: true as const, sha: 'a'.repeat(40) }));
    const recorder = new SessionCheckpointRecorder({
      cwd: fixture.cwd,
      sessionId: fixture.sessionId,
      sessionPath: fixture.sessionPath,
      auditStore: new FileCheckpointAuditStore({
        cwd: fixture.cwd,
        sessionId: fixture.sessionId,
        createId: () => 'cp-model-wave',
      }),
      shadow: { snapshot },
    });

    const before = await fixture.readSession();
    const checkpoint = await recorder.capture('before-model-wave', fixture.messages);

    expect(checkpoint).toMatchObject({
      checkpointId: 'cp-model-wave',
      phase: 'before-model-wave',
      cursor: { sessionSeq: 3, recordCount: 3, messageCount: 2 },
      shadow: { status: 'captured', ref: 'a'.repeat(40) },
      effects: {
        managedFileWrites: 0,
        external: 'none-observed',
        canRewindConversation: true,
        canRewindFiles: true,
      },
    });
    expect(await fixture.readSession()).toBe(before);
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it('fails closed when memory does not match the durable Session cursor', async () => {
    const fixture = await sessionFixture();
    const snapshot = vi.fn(async () => ({ ok: true as const, sha: 'b'.repeat(40) }));
    const appendCheckpoint = vi.fn();
    const recorder = new SessionCheckpointRecorder({
      cwd: fixture.cwd,
      sessionId: fixture.sessionId,
      sessionPath: fixture.sessionPath,
      auditStore: { appendCheckpoint },
      shadow: { snapshot },
    });
    const drifted: Message[] = [...fixture.messages, { role: 'user', content: 'not durable' }];

    await expect(recorder.capture('manual', drifted)).rejects.toThrow(/does not match durable session/u);
    expect(snapshot).not.toHaveBeenCalled();
    expect(appendCheckpoint).not.toHaveBeenCalled();
  });

  it('records a bounded unavailable ShadowGit status while preserving conversation rewind', async () => {
    const fixture = await sessionFixture();
    const recorder = new SessionCheckpointRecorder({
      cwd: fixture.cwd,
      sessionId: fixture.sessionId,
      sessionPath: fixture.sessionPath,
      auditStore: new FileCheckpointAuditStore({
        cwd: fixture.cwd,
        sessionId: fixture.sessionId,
        createId: () => 'cp-no-shadow',
      }),
      shadow: {
        snapshot: async () => ({ ok: false, reason: `failed\n${'x'.repeat(2_000)}` }),
      },
    });

    const checkpoint = await recorder.capture('before-user-prompt', fixture.messages);

    expect(checkpoint.shadow).toMatchObject({ status: 'unavailable' });
    expect(checkpoint.shadow.status === 'unavailable' && checkpoint.shadow.reason.length).toBeLessThanOrEqual(512);
    expect(checkpoint.shadow.status === 'unavailable' && checkpoint.shadow.reason).not.toContain('\n');
    expect(checkpoint.effects).toMatchObject({ canRewindConversation: true, canRewindFiles: false });
  });

  it('refuses partial composition and header/workspace identity drift before ShadowGit capture', async () => {
    const partial = await sessionFixture({ partial: true, sessionId: 'session-partial' });
    const wrongCwd = await sessionFixture({ headerCwd: 'H:/different-workspace', sessionId: 'session-wrong-cwd' });
    const snapshot = vi.fn(async () => ({ ok: true as const, sha: 'c'.repeat(40) }));

    for (const fixture of [partial, wrongCwd]) {
      const recorder = new SessionCheckpointRecorder({
        cwd: fixture.cwd,
        sessionId: fixture.sessionId,
        sessionPath: fixture.sessionPath,
        auditStore: { appendCheckpoint: vi.fn() },
        shadow: { snapshot },
      });
      await expect(recorder.capture('manual', fixture.messages)).rejects.toThrow(/composition|cwd/u);
    }
    expect(snapshot).not.toHaveBeenCalled();
  });
});

async function sessionFixture(options: {
  partial?: boolean;
  headerCwd?: string;
  sessionId?: string;
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint recorder '));
  tempDirs.push(cwd);
  const sessionId = options.sessionId ?? 'session-a';
  const sessionPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
  const store = new FileSessionStore(sessionPath);
  const messages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ];
  await store.writeHeader({
    id: sessionId,
    model: 'fixture-model',
    cwd: options.headerCwd ?? cwd,
    startedAt: '2026-08-15T12:00:00.000Z',
    composition: createSessionComposition({
      root: 'repl',
      runtimeVersion: '0.1.0',
      permissionMode: 'interactive',
      ...(options.partial
        ? {}
        : {
            toolSchemas: [],
            systemPrompt: 'system',
            dynamicAddendum: NO_DYNAMIC_ADDENDUM,
          }),
    }),
  });
  await store.sync(messages);
  const { readFile } = await import('node:fs/promises');
  return {
    cwd,
    sessionId,
    sessionPath,
    messages,
    readSession: () => readFile(sessionPath, 'utf8'),
  };
}
