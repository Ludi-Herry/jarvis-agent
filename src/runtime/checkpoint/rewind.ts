import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Message } from '../../core/types.js';
import {
  SESSION_SCHEMA_VERSION,
  loadSessionLog,
  replaySession,
  resolveSessionFilePath,
  serializeRecord,
  validateSessionId,
  type SessionComposition,
  type SessionRecord,
} from '../session/session-store.js';
import { summarizeSessionEffects } from './checkpoint-recorder.js';
import {
  FileCheckpointAuditStore,
  loadCheckpointAudit,
  validateCheckpointId,
  type CheckpointCreatedRecord,
  type CheckpointRewindRecord,
  type RewindAuditInput,
} from './checkpoint-store.js';

export interface RewindAuditAppender {
  appendRewind(input: RewindAuditInput): Promise<CheckpointRewindRecord>;
}

export interface PrepareConversationRewindInput {
  cwd: string;
  sourceSessionId: string;
  checkpointId: string;
  forkSessionId?: string;
  createForkSessionId?: () => string;
  createRewindId?: () => string;
  now?: () => string;
  auditStore?: RewindAuditAppender;
}

export interface ConversationRewindPlan {
  cwd: string;
  sourceSessionId: string;
  checkpointId: string;
  rewindId: string;
  forkSessionId: string;
  sourcePath: string;
  forkPath: string;
  sourceFingerprint: string;
  sourceHeader: {
    model: string;
    cwd: string;
    composition: SessionComposition;
  };
  checkpoint: CheckpointCreatedRecord;
  targetMessages: Message[];
  targetMessageCount: number;
  afterCheckpoint: ReturnType<typeof summarizeSessionEffects>;
  createdAt: string;
  auditStore: RewindAuditAppender;
}

export interface ConversationRewindResult {
  status: 'created';
  forkSessionId: string;
  path: string;
  messageCount: number;
}

export interface ApplyConversationRewindOptions {
  mode?: 'conversation' | 'conversation-and-files';
  plannedAlready?: boolean;
}

export class CheckpointNotFoundError extends Error {
  constructor(checkpointId: string) {
    super(`checkpoint not found: ${checkpointId}`);
    this.name = 'CheckpointNotFoundError';
  }
}

export async function prepareConversationRewind(
  input: PrepareConversationRewindInput,
): Promise<ConversationRewindPlan> {
  assertSafeId(input.sourceSessionId, 'source session');
  assertSafeId(input.checkpointId, 'checkpoint');
  const resolution = await resolveSessionFilePath({
    cwd: input.cwd,
    sessionId: input.sourceSessionId,
  });
  if (resolution.status !== 'ok') {
    const reason = 'reason' in resolution ? resolution.reason : `source session ${resolution.status}`;
    throw new Error(reason);
  }

  const rawBefore = await readFile(resolution.path, 'utf8');
  const source = await loadSessionLog(resolution.path, {
    requireHeader: true,
    validateIntegrity: true,
    expectedSessionId: input.sourceSessionId,
  });
  const rawAfter = await readFile(resolution.path, 'utf8');
  if (rawBefore !== rawAfter) throw new Error('source session changed during rewind preview');

  const header = source.loaded.header;
  if (source.loaded.format !== 'v2' || header === undefined || !('schemaVersion' in header)) {
    throw new Error('rewind requires a fully recorded v2 session');
  }
  if (header.composition.coverage !== 'full'
    || header.composition.dynamicAddendumSource === undefined
    || header.composition.dynamicAddendumManifestHash === undefined) {
    throw new Error('rewind requires a fully recorded v2 session composition');
  }
  if (header.cwd !== input.cwd) {
    throw new Error('source session cwd does not match the rewind workspace');
  }
  if (source.loaded.pendingTools.length > 0) {
    throw new Error('rewind refuses a source with unresolved tool execution');
  }

  const audit = await loadCheckpointAudit({ cwd: input.cwd, sessionId: input.sourceSessionId });
  const checkpoint = audit.records.find(
    (record): record is CheckpointCreatedRecord => record.t === 'checkpoint'
      && record.checkpointId === input.checkpointId,
  );
  if (checkpoint === undefined) throw new CheckpointNotFoundError(input.checkpointId);
  if (checkpoint.sessionId !== input.sourceSessionId || checkpoint.cwd !== input.cwd) {
    throw new Error('checkpoint identity does not match the source session');
  }
  if (!checkpoint.effects.canRewindConversation) {
    throw new Error('checkpoint is not eligible for conversation rewind');
  }

  const { recordCount, sessionSeq, messageCount } = checkpoint.cursor;
  if (recordCount < 1 || recordCount > source.records.length) {
    throw new Error('checkpoint cursor is outside the source session');
  }
  const prefix = source.records.slice(0, recordCount);
  const lastRecord = prefix.at(-1);
  if (lastRecord === undefined || !('schemaVersion' in lastRecord) || lastRecord.seq !== sessionSeq) {
    throw new Error('checkpoint cursor does not match the durable session sequence');
  }
  const replayed = replaySession(prefix);
  if (replayed.pendingTools.length > 0) {
    throw new Error('checkpoint contains unresolved tool execution');
  }
  if (replayed.messages.length !== messageCount) {
    throw new Error('checkpoint cursor message count does not match the session prefix');
  }
  const targetMessages = receiptFreeProjection(replayed.messages);

  const forkSessionId = input.forkSessionId
    ?? input.createForkSessionId?.()
    ?? `rewind-${Date.now()}-${randomUUID().slice(0, 8)}`;
  assertSafeId(forkSessionId, 'fork session');
  if (forkSessionId === input.sourceSessionId) {
    throw new Error('rewind fork session id must differ from the source session id');
  }
  const rewindId = input.createRewindId?.() ?? `rewind-${randomUUID()}`;
  assertSafeId(rewindId, 'rewind');
  const createdAt = input.now?.() ?? new Date().toISOString();
  const auditStore = input.auditStore ?? new FileCheckpointAuditStore({
    cwd: input.cwd,
    sessionId: input.sourceSessionId,
  });

  return {
    cwd: input.cwd,
    sourceSessionId: input.sourceSessionId,
    checkpointId: input.checkpointId,
    rewindId,
    forkSessionId,
    sourcePath: resolution.path,
    forkPath: join(dirname(resolution.path), `${forkSessionId}.jsonl`),
    sourceFingerprint: fingerprint(rawAfter),
    sourceHeader: {
      model: header.model,
      cwd: header.cwd,
      composition: { ...header.composition },
    },
    checkpoint,
    targetMessages,
    targetMessageCount: targetMessages.length,
    afterCheckpoint: summarizeSessionEffects(source.records.slice(recordCount)),
    createdAt,
    auditStore,
  };
}

export async function applyConversationRewind(
  plan: ConversationRewindPlan,
  options: ApplyConversationRewindOptions = {},
): Promise<ConversationRewindResult> {
  assertSafeId(plan.sourceSessionId, 'source session');
  assertSafeId(plan.checkpointId, 'checkpoint');
  assertSafeId(plan.forkSessionId, 'fork session');
  assertSafeId(plan.rewindId, 'rewind');
  const mode = options.mode ?? 'conversation';
  await assertConversationRewindSourceUnchanged(plan, 'changed after rewind preview', mode);
  if (options.plannedAlready !== true) {
    await plan.auditStore.appendRewind(rewindAudit(plan, 'planned', mode));
  }
  try {
    await assertConversationRewindSourceUnchanged(plan, 'changed after rewind preview', mode);
    await writeFile(plan.forkPath, serializeFork(plan), { encoding: 'utf8', flag: 'wx' });
    await assertConversationRewindSourceUnchanged(plan, 'changed while creating rewind fork', mode);
  } catch (err) {
    await appendFailureBestEffort(plan, err, mode);
    throw err;
  }

  await plan.auditStore.appendRewind(rewindAudit(plan, 'created', mode));
  return {
    status: 'created',
    forkSessionId: plan.forkSessionId,
    path: plan.forkPath,
    messageCount: plan.targetMessageCount,
  };
}

function serializeFork(plan: ConversationRewindPlan): string {
  const records: SessionRecord[] = [
    {
      schemaVersion: SESSION_SCHEMA_VERSION,
      seq: 1,
      at: plan.createdAt,
      t: 'session',
      id: plan.forkSessionId,
      model: plan.sourceHeader.model,
      cwd: plan.sourceHeader.cwd,
      startedAt: plan.createdAt,
      composition: { ...plan.sourceHeader.composition },
    },
    ...plan.targetMessages.map((message, index): SessionRecord => ({
      schemaVersion: SESSION_SCHEMA_VERSION,
      seq: index + 2,
      at: plan.createdAt,
      t: 'message',
      message,
    })),
  ];
  return records.map(serializeRecord).join('');
}

function receiptFreeProjection(messages: readonly Message[]): Message[] {
  return messages.map((message): Message => {
    if (message.role === 'tool' || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)) {
      throw new Error('checkpoint contains receipt-bound tool history that cannot be copied into a fresh v2 fork');
    }
    if (message.role !== 'assistant' || message.requestId === undefined) return { ...message };
    const projected = { ...message };
    delete projected.requestId;
    return projected;
  });
}

export async function assertConversationRewindSourceUnchanged(
  plan: ConversationRewindPlan,
  reason: string,
  mode: RewindAuditInput['mode'] = 'conversation',
): Promise<void> {
  const raw = await readFile(plan.sourcePath, 'utf8');
  if (fingerprint(raw) === plan.sourceFingerprint) return;
  const error = new Error(`source session ${reason}`);
  await appendBlockedBestEffort(plan, error, mode);
  throw error;
}

function rewindAudit(
  plan: ConversationRewindPlan,
  outcome: RewindAuditInput['outcome'],
  mode: RewindAuditInput['mode'] = 'conversation',
  reason?: string,
): RewindAuditInput {
  return {
    rewindId: plan.rewindId,
    checkpointId: plan.checkpointId,
    sourceSessionId: plan.sourceSessionId,
    forkSessionId: plan.forkSessionId,
    mode,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  };
}

async function appendBlockedBestEffort(
  plan: ConversationRewindPlan,
  err: unknown,
  mode: RewindAuditInput['mode'],
): Promise<void> {
  try {
    await plan.auditStore.appendRewind(rewindAudit(plan, 'blocked', mode, describeError(err)));
  } catch {
    // Preserve the source-drift failure; audit append must never hide it.
  }
}

async function appendFailureBestEffort(
  plan: ConversationRewindPlan,
  err: unknown,
  mode: RewindAuditInput['mode'],
): Promise<void> {
  try {
    await plan.auditStore.appendRewind(rewindAudit(plan, 'failed', mode, describeError(err)));
  } catch {
    // Preserve the fork creation failure; audit append must never hide it.
  }
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assertSafeId(value: string, label: string): void {
  const check = label === 'checkpoint' || label === 'rewind'
    ? validateCheckpointId(value)
    : validateSessionId(value);
  if (!check.ok) throw new Error(`${label} id is invalid: ${check.reason}`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
