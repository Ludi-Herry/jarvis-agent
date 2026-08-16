import { isDeepStrictEqual } from 'node:util';
import type { Message } from '../../core/types.js';
import {
  loadSessionLog,
  type LoadedSessionLog,
  type SessionRecord,
} from '../session/session-store.js';
import type {
  CheckpointAppendInput,
  CheckpointCreatedRecord,
  CheckpointEffects,
  CheckpointPhase,
  CheckpointShadow,
} from './checkpoint-store.js';

export interface CheckpointAuditAppender {
  appendCheckpoint(input: CheckpointAppendInput): Promise<CheckpointCreatedRecord>;
}

export interface CheckpointShadowCapture {
  snapshot(label: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
}

export interface SessionCheckpointRecorderOptions {
  cwd: string;
  sessionId: string;
  sessionPath: string;
  auditStore: CheckpointAuditAppender;
  shadow?: CheckpointShadowCapture;
  loadSession?: (path: string) => Promise<LoadedSessionLog>;
}

/**
 * Binds a checkpoint to one already-durable Session prefix. The caller must
 * sync the in-memory messages before capture; a mismatch fails before ShadowGit
 * or audit writes so a stale cursor can never be recorded.
 */
export class SessionCheckpointRecorder {
  private readonly loadSession: (path: string) => Promise<LoadedSessionLog>;

  constructor(private readonly options: SessionCheckpointRecorderOptions) {
    this.loadSession = options.loadSession ?? ((path) => loadSessionLog(path, {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: options.sessionId,
    }));
  }

  async capture(phase: CheckpointPhase, messages: readonly Message[]): Promise<CheckpointCreatedRecord> {
    const log = await this.loadSession(this.options.sessionPath);
    const { loaded, records } = log;
    if (loaded.format !== 'v2' || loaded.header === undefined || !('schemaVersion' in loaded.header)) {
      throw new Error('checkpoint requires a fully recorded v2 session');
    }
    if (loaded.header.composition.coverage !== 'full'
      || loaded.header.composition.dynamicAddendumSource === undefined
      || loaded.header.composition.dynamicAddendumManifestHash === undefined) {
      throw new Error('checkpoint requires a fully recorded v2 session composition');
    }
    if (loaded.header.cwd !== this.options.cwd) {
      throw new Error('checkpoint session cwd does not match the recorder workspace');
    }
    if (loaded.pendingTools.length > 0) {
      throw new Error('checkpoint refuses a session with unresolved tool execution');
    }
    if (!isDeepStrictEqual(loaded.messages, messages)) {
      throw new Error('checkpoint memory does not match durable session state');
    }

    const shadow = await captureShadow(this.options.shadow, phase, loaded.lastSequence);
    const summarized = summarizeSessionEffects(records);
    const canRewindConversation = isReceiptFreeRewindProjection(messages);
    const effects: CheckpointEffects = {
      ...summarized,
      canRewindConversation,
      canRewindFiles: canRewindConversation && shadow.status === 'captured',
    };
    return this.options.auditStore.appendCheckpoint({
      phase,
      cursor: {
        sessionSeq: loaded.lastSequence,
        recordCount: records.length,
        messageCount: loaded.messages.length,
      },
      shadow,
      effects,
    });
  }
}

/** A fresh v2 fork may retain plain assistant text after dropping requestId,
 * but tool-bearing assistant/tool messages require receipts. Copying or
 * fabricating those receipts would misstate execution provenance. */
export function isReceiptFreeRewindProjection(messages: readonly Message[]): boolean {
  return messages.every((message) => message.role !== 'tool'
    && (message.role !== 'assistant' || (message.toolCalls?.length ?? 0) === 0));
}

async function captureShadow(
  shadow: CheckpointShadowCapture | undefined,
  phase: CheckpointPhase,
  sessionSeq: number,
): Promise<CheckpointShadow> {
  if (shadow === undefined) return { status: 'unavailable', reason: 'disabled' };
  try {
    const result = await shadow.snapshot(`checkpoint ${phase} session-seq ${sessionSeq}`);
    return result.ok
      ? { status: 'captured', ref: result.sha }
      : { status: 'unavailable', reason: result.reason };
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function summarizeSessionEffects(
  records: readonly SessionRecord[],
): Pick<CheckpointEffects, 'managedFileWrites' | 'external'> {
  const toolNames = new Map<string, string>();
  let managedFileWrites = 0;
  let external: CheckpointEffects['external'] = 'none-observed';
  for (const record of records) {
    if (record.t !== 'tool' || !('schemaVersion' in record)) continue;
    if (record.phase === 'planned') {
      toolNames.set(record.executionId, record.call.name);
      continue;
    }
    if (record.phase === 'unknown') {
      external = 'unknown';
      continue;
    }
    const name = toolNames.get(record.executionId);
    const receipt = record.result.fileReceipt;
    if (receipt?.kind === 'write' && receipt.outcome === 'applied') managedFileWrites++;
    if (external === 'unknown') continue;
    if (name === 'read' || name === 'history_search' || name === 'history_turn') continue;
    if (name === 'write' && receipt?.kind === 'write') continue;
    external = 'possible';
  }
  return { managedFileWrites, external };
}
