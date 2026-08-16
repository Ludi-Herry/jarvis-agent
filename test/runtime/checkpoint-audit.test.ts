import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_SCHEMA_VERSION,
  FileCheckpointAuditStore,
  assertCheckpointAuditOperational,
  checkpointAuditPath,
  loadCheckpointAudit,
  parseCheckpointAudit,
  validateCheckpointId,
  type CheckpointCreatedRecord,
} from '../../src/runtime/checkpoint/checkpoint-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('checkpoint audit v1', () => {
  it('appends contiguous records in a workspace path containing spaces', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint audit '));
    tempDirs.push(cwd);
    const store = new FileCheckpointAuditStore({
      cwd,
      sessionId: 'session-a',
      now: sequenceNow('2026-08-15T12:00:00.000Z', '2026-08-15T12:00:01.000Z'),
      createId: sequenceId('cp-a', 'cp-b'),
    });

    const first = await store.appendCheckpoint(checkpointInput('before-user-prompt', 3, 2));
    const second = await store.appendCheckpoint(checkpointInput('before-model-wave', 4, 3));
    const loaded = await loadCheckpointAudit({ cwd, sessionId: 'session-a' });

    expect(first).toMatchObject({ schemaVersion: 1, seq: 1, checkpointId: 'cp-a' });
    expect(second).toMatchObject({ schemaVersion: 1, seq: 2, checkpointId: 'cp-b' });
    expect(loaded.records).toHaveLength(2);
    expect(loaded.issues).toEqual([]);
    expect(await readFile(checkpointAuditPath(cwd, 'session-a'), 'utf8')).toContain('"phase":"before-model-wave"');
  });

  it('retains a crash-truncated tail for observation but refuses to append through it', async () => {
    const record = fixtureRecord({ seq: 1, checkpointId: 'cp-a' });
    const parsed = parseCheckpointAudit(`${JSON.stringify(record)}\n{"schemaVersion":1`);

    expect(parsed.records).toEqual([record]);
    expect(parsed.issues).toEqual([{ kind: 'malformed-tail', line: 2 }]);
    expect(() => assertCheckpointAuditOperational(parsed, { requireAppendSafe: false })).not.toThrow();
    expect(() => assertCheckpointAuditOperational(parsed, { requireAppendSafe: true })).toThrow(/truncated tail/u);
  });

  it.each([
    `${JSON.stringify(fixtureRecord({ seq: 1, checkpointId: 'cp-a' }))}\n{bad}\n${JSON.stringify(fixtureRecord({ seq: 2, checkpointId: 'cp-b' }))}\n`,
    `${JSON.stringify(fixtureRecord({ seq: 1, checkpointId: 'cp-a' }))}\n${JSON.stringify(fixtureRecord({ seq: 3, checkpointId: 'cp-b' }))}\n`,
    `${JSON.stringify(fixtureRecord({ seq: 1, checkpointId: 'cp-a' }))}\n${JSON.stringify(fixtureRecord({ seq: 2, checkpointId: 'cp-a' }))}\n`,
    `${JSON.stringify({ ...fixtureRecord({ seq: 1, checkpointId: 'cp-a' }), injected: 'must not enter JSON reports' })}\n`,
  ])('fails closed for middle corruption, sequence gaps, or duplicate checkpoint ids', (text) => {
    const parsed = parseCheckpointAudit(text);
    expect(() => assertCheckpointAuditOperational(parsed, { requireAppendSafe: false })).toThrow(/checkpoint audit/u);
  });

  it.each(['', '..', '../escape', 'C:\\escape', '\\\\?\\C:\\escape', 'CON', 'nul.txt', 'name.', 'name '])(
    'rejects unsafe checkpoint ids: %s',
    (id) => expect(validateCheckpointId(id).ok).toBe(false),
  );

  it('preserves non-ENOENT read failures', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint unreadable '));
    tempDirs.push(cwd);
    const path = checkpointAuditPath(cwd, 'session-a');
    await mkdir(join(cwd, 'data', 'checkpoints'), { recursive: true });
    await writeFile(path, '', { encoding: 'utf8', flag: 'wx' });
    const failure = Object.assign(new Error('fixture denied'), { code: 'EACCES' });

    await expect(loadCheckpointAudit({
      cwd,
      sessionId: 'session-a',
      readText: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it('refuses a checkpoint-directory reparse escape before append', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint escape '));
    tempDirs.push(cwd);
    const outside = join(cwd, 'outside');
    await mkdir(join(cwd, 'data'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(cwd, 'data', 'checkpoints'), process.platform === 'win32' ? 'junction' : 'dir');
    const store = new FileCheckpointAuditStore({ cwd, sessionId: 'session-a' });

    await expect(store.appendCheckpoint(checkpointInput('before-user-prompt', 3, 2)))
      .rejects.toThrow(/regular directory|symbolic link|reparse/u);
    await expect(readFile(join(outside, 'session-a.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an existing hard-linked checkpoint audit before append', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis checkpoint hardlink '));
    tempDirs.push(cwd);
    const auditDir = join(cwd, 'data', 'checkpoints');
    const outside = join(cwd, 'outside.txt');
    await mkdir(auditDir, { recursive: true });
    await writeFile(outside, 'sentinel', 'utf8');
    await link(outside, join(auditDir, 'session-a.jsonl'));
    const store = new FileCheckpointAuditStore({ cwd, sessionId: 'session-a' });

    await expect(store.appendCheckpoint(checkpointInput('before-user-prompt', 3, 2)))
      .rejects.toThrow(/hard link/u);
    expect(await readFile(outside, 'utf8')).toBe('sentinel');
  });

  it('rejects a rewind audit record that references an unrecorded checkpoint', () => {
    const parsed = parseCheckpointAudit(`${JSON.stringify({
      schemaVersion: 1,
      seq: 1,
      at: '2026-08-15T12:00:00.000Z',
      t: 'rewind',
      rewindId: 'rewind-a',
      checkpointId: 'cp-missing',
      sourceSessionId: 'session-a',
      forkSessionId: 'fork-a',
      mode: 'conversation',
      outcome: 'blocked',
    })}\n`);

    expect(() => assertCheckpointAuditOperational(parsed, {
      requireAppendSafe: false,
      expectedSessionId: 'session-a',
    })).toThrow(/unrecorded checkpoint/u);
  });
});

function checkpointInput(phase: 'before-user-prompt' | 'before-model-wave', sessionSeq: number, messageCount: number) {
  return {
    phase,
    cursor: { sessionSeq, recordCount: sessionSeq, messageCount },
    shadow: { status: 'unavailable' as const, reason: 'disabled' },
    effects: {
      managedFileWrites: 0,
      external: 'none-observed' as const,
      canRewindConversation: true,
      canRewindFiles: false,
    },
  };
}

function fixtureRecord(overrides: Partial<CheckpointCreatedRecord> = {}): CheckpointCreatedRecord {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    seq: 1,
    at: '2026-08-15T12:00:00.000Z',
    t: 'checkpoint',
    checkpointId: 'cp-a',
    sessionId: 'session-a',
    cwd: 'H:\\workspace',
    ...checkpointInput('before-user-prompt', 3, 2),
    ...overrides,
  };
}

function sequenceNow(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? '2026-08-15T12:00:00.000Z';
}

function sequenceId(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `cp-${index}`;
}
