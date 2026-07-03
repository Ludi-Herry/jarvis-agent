import type { EventBus } from '../../runtime/event-bus.js';
import type { ApprovalAuditStore, Approver } from '../../runtime/permission/index.js';
import { detailOf } from './approval.js';

export {
  FileApprovalAuditStore,
  parseApprovalAuditLog,
  type ApprovalAuditDecision,
  type ApprovalAuditRecord,
  type ApprovalAuditStore,
} from '../../runtime/permission/index.js';

export interface ApprovalEventApproverOptions {
  approver: Approver;
  bus: EventBus;
  store?: ApprovalAuditStore;
  sessionId?: string;
  idFactory?: () => string;
  now?: () => Date;
}

export function createApprovalEventApprover(options: ApprovalEventApproverOptions): Approver {
  const idFactory = options.idFactory ?? defaultApprovalId;
  const now = options.now ?? (() => new Date());
  return async (req) => {
    const requestId = idFactory();
    const requestAt = now().toISOString();
    const request = {
      requestId,
      ...optional('sessionId', options.sessionId),
      toolName: req.toolName,
      capability: req.capability,
      reason: req.reason,
      detail: detailOf(req),
      at: requestAt,
    };

    options.bus.emit({ type: 'approval_request', ...request });
    await options.store?.append({ t: 'approval-request', ...request });

    try {
      const decision = await options.approver(req);
      const resultAt = now().toISOString();
      const result = {
        requestId,
        ...optional('sessionId', options.sessionId),
        toolName: req.toolName,
        decision,
        at: resultAt,
      };
      options.bus.emit({ type: 'approval_result', ...result });
      await options.store?.append({ t: 'approval-result', ...result });
      return decision;
    } catch (err) {
      const resultAt = now().toISOString();
      const result = {
        requestId,
        ...optional('sessionId', options.sessionId),
        toolName: req.toolName,
        decision: 'error' as const,
        error: message(err),
        at: resultAt,
      };
      options.bus.emit({ type: 'approval_result', ...result });
      await options.store?.append({ t: 'approval-result', ...result });
      throw err;
    }
  };
}

function defaultApprovalId(): string {
  return `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function optional<K extends string, T>(key: K, value: T | undefined): { [P in K]: T } | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as { [P in K]: T };
}
