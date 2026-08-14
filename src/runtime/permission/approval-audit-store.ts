import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hasStringFields, isJsonObject, parseJsonlWithDiagnostics } from '../jsonl-integrity.js';
import type { Approval, ApprovalRequest } from './permission-gate.js';

export type ApprovalAuditDecision = Approval | 'error';

export type ApprovalAuditRecord =
  | {
      t: 'approval-request';
      requestId: string;
      sessionId?: string;
      toolName: string;
      capability: ApprovalRequest['capability'];
      reason: string;
      detail: string;
      at: string;
    }
  | {
      t: 'approval-result';
      requestId: string;
      sessionId?: string;
      toolName: string;
      decision: ApprovalAuditDecision;
      error?: string;
      at: string;
    };

export interface ApprovalAuditStore {
  append(record: ApprovalAuditRecord): Promise<void>;
}

export function isApprovalAuditRecord(value: unknown): value is ApprovalAuditRecord {
  if (!isJsonObject(value) || typeof value.t !== 'string') return false;
  if (value.t === 'approval-request') {
    return hasStringFields(value, 'requestId', 'toolName', 'reason', 'detail', 'at')
      && (value.capability === 'read-only'
        || value.capability === 'writes-files'
        || value.capability === 'executes-code'
        || value.capability === 'network');
  }
  if (value.t === 'approval-result') {
    return hasStringFields(value, 'requestId', 'toolName', 'at')
      && (value.decision === 'allow-once'
        || value.decision === 'allow-session'
        || value.decision === 'deny'
        || value.decision === 'error')
      && (value.error === undefined || typeof value.error === 'string');
  }
  return false;
}

export class FileApprovalAuditStore implements ApprovalAuditStore {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  async append(record: ApprovalAuditRecord): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

export function parseApprovalAuditLog(text: string): ApprovalAuditRecord[] {
  return parseJsonlWithDiagnostics(text, isApprovalAuditRecord).records;
}
