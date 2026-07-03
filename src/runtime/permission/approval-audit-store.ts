import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  const records: ApprovalAuditRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as ApprovalAuditRecord);
    } catch {
      // Keep crash-truncated tails from breaking audit replay.
    }
  }
  return records;
}
