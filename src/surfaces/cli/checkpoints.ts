import {
  CheckpointNotFoundError,
  loadCheckpointAudit,
  validateCheckpointId,
  type CheckpointAuditRecord,
  type CheckpointCreatedRecord,
} from '../../runtime/checkpoint/index.js';
import { validateSessionId } from '../../runtime/session/index.js';
import { safeInline } from './approval.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';

export const CHECKPOINT_AUTHORITY = Object.freeze({
  mode: 'observation-only' as const,
  canCompleteGoals: false as const,
  canCompleteLoops: false as const,
});

export class CheckpointCommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointCommandInputError';
  }
}

export function assertCheckpointCommandIds(sessionId: string, checkpointId?: string): void {
  const session = validateSessionId(sessionId);
  if (!session.ok) throw new CheckpointCommandInputError(session.reason);
  if (checkpointId === undefined) return;
  const checkpoint = validateCheckpointId(checkpointId);
  if (!checkpoint.ok) throw new CheckpointCommandInputError(checkpoint.reason);
}

export interface CheckpointsListReport {
  schemaVersion: 1;
  authority: typeof CHECKPOINT_AUTHORITY;
  sessionId: string;
  integrity: { status: 'complete' | 'partial'; issueCount: number };
  checkpoints: CheckpointCreatedRecord[];
  rewinds: Exclude<CheckpointAuditRecord, CheckpointCreatedRecord>[];
}

export interface CheckpointsShowReport {
  schemaVersion: 1;
  authority: typeof CHECKPOINT_AUTHORITY;
  sessionId: string;
  integrity: { status: 'complete' | 'partial'; issueCount: number };
  checkpoint: CheckpointCreatedRecord;
}

export async function buildCheckpointsListReport(input: {
  cwd: string;
  sessionId: string;
}): Promise<{ report: CheckpointsListReport; exitCode: CliExitCode }> {
  assertCheckpointCommandIds(input.sessionId);
  const audit = await loadCheckpointAudit(input);
  const issueCount = audit.issues.length;
  return {
    report: {
      schemaVersion: 1,
      authority: CHECKPOINT_AUTHORITY,
      sessionId: input.sessionId,
      integrity: { status: issueCount === 0 ? 'complete' : 'partial', issueCount },
      checkpoints: audit.records.filter(
        (record): record is CheckpointCreatedRecord => record.t === 'checkpoint',
      ),
      rewinds: audit.records.filter(
        (record): record is Exclude<CheckpointAuditRecord, CheckpointCreatedRecord> => record.t === 'rewind',
      ),
    },
    exitCode: issueCount === 0 ? CLI_EXIT.SUCCESS : CLI_EXIT.STATE_CORRUPT,
  };
}

export async function buildCheckpointsShowReport(input: {
  cwd: string;
  sessionId: string;
  checkpointId: string;
}): Promise<
  | { status: 'ok'; report: CheckpointsShowReport; exitCode: CliExitCode }
  | { status: 'not-found'; sessionId: string; checkpointId: string }
> {
  assertCheckpointCommandIds(input.sessionId, input.checkpointId);
  const { report, exitCode } = await buildCheckpointsListReport(input);
  const checkpoint = report.checkpoints.find((record) => record.checkpointId === input.checkpointId);
  if (checkpoint === undefined) {
    if (exitCode !== CLI_EXIT.SUCCESS) {
      throw new Error('checkpoint audit is partial; refusing to claim the checkpoint is absent');
    }
    return {
      status: 'not-found',
      sessionId: input.sessionId,
      checkpointId: input.checkpointId,
    };
  }
  return {
    status: 'ok',
    exitCode,
    report: {
      schemaVersion: 1,
      authority: CHECKPOINT_AUTHORITY,
      sessionId: input.sessionId,
      integrity: report.integrity,
      checkpoint,
    },
  };
}

export function formatCheckpointsListReport(report: CheckpointsListReport): string {
  const lines = [
    `Checkpoints (observation-only): ${report.checkpoints.length}`,
    `session: ${boundedInline(report.sessionId)}`,
    `integrity: ${report.integrity.status} (${report.integrity.issueCount} issue(s))`,
  ];
  for (const checkpoint of report.checkpoints) {
    lines.push(
      `- ${boundedInline(checkpoint.checkpointId)} | ${boundedInline(checkpoint.at)} | ${checkpoint.phase}`
        + ` | messages=${checkpoint.cursor.messageCount} | files=${checkpoint.shadow.status}`
        + ` | external=${checkpoint.effects.external}`,
    );
  }
  if (report.checkpoints.length === 0) lines.push('no checkpoints recorded');
  if (report.rewinds.length > 0) lines.push(`rewind audit records: ${report.rewinds.length}`);
  return `${lines.join('\n')}\n`;
}

export function formatCheckpointsShowReport(report: CheckpointsShowReport): string {
  const checkpoint = report.checkpoint;
  const shadow = checkpoint.shadow.status === 'captured'
    ? checkpoint.shadow.ref
    : `${checkpoint.shadow.status}: ${checkpoint.shadow.reason}`;
  return [
    'Checkpoint (observation-only)',
    `session: ${boundedInline(report.sessionId)}`,
    `checkpoint: ${boundedInline(checkpoint.checkpointId)}`,
    `at: ${boundedInline(checkpoint.at)}`,
    `cwd: ${boundedInline(checkpoint.cwd)}`,
    `phase: ${checkpoint.phase}`,
    `cursor: seq=${checkpoint.cursor.sessionSeq} records=${checkpoint.cursor.recordCount} messages=${checkpoint.cursor.messageCount}`,
    `shadow: ${boundedInline(shadow)}`,
    `effects: managed-writes=${checkpoint.effects.managedFileWrites} external=${checkpoint.effects.external}`,
    `rewind: conversation=${String(checkpoint.effects.canRewindConversation)} files=${String(checkpoint.effects.canRewindFiles)}`,
    `integrity: ${report.integrity.status} (${report.integrity.issueCount} issue(s))`,
    'completion authority: none',
    '',
  ].join('\n');
}

export function checkpointCommandErrorExitCode(err: unknown): CliExitCode {
  if (err instanceof CheckpointCommandInputError) return CLI_EXIT.USAGE;
  if (err instanceof CheckpointNotFoundError || isNotFoundError(err)) return CLI_EXIT.USAGE;
  if (/\b(?:requires|refuses|changed|not eligible|must differ)\b/iu.test(errorMessage(err))) {
    return CLI_EXIT.NEEDS_HUMAN;
  }
  return CLI_EXIT.STATE_CORRUPT;
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function boundedInline(value: string): string {
  return safeInline(value).slice(0, 512);
}
