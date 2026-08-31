import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryEventBus, type Event } from '../../src/runtime/index.js';
import type { Approver } from '../../src/runtime/permission/index.js';
import {
  createApprovalEventApprover,
  FileApprovalAuditStore,
  parseApprovalAuditLog,
} from '../../src/surfaces/cli/approval-events.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-approval-events-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createApprovalEventApprover', () => {
  it('emits approval request/result events and persists the audit records', async () => {
    const bus = new InMemoryEventBus();
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    const auditPath = join(dir, 'goal-1.jsonl');
    const base: Approver = async () => 'allow-session';

    const approver = createApprovalEventApprover({
      approver: base,
      bus,
      store: new FileApprovalAuditStore(auditPath),
      sessionId: 'goal-1',
      idFactory: () => 'approval-1',
      now: () => new Date('2026-07-03T06:00:00.000Z'),
    });

    const decision = await approver({
      toolName: 'bash',
      capability: 'executes-code',
      args: { command: 'git status --short' },
      reason: 'executes code',
    });

    expect(decision).toBe('allow-session');
    expect(events).toEqual([
      {
        type: 'approval_request',
        requestId: 'approval-1',
        sessionId: 'goal-1',
        toolName: 'bash',
        capability: 'executes-code',
        reason: 'executes code',
        detail: 'git status --short',
        at: '2026-07-03T06:00:00.000Z',
      },
      {
        type: 'approval_result',
        requestId: 'approval-1',
        sessionId: 'goal-1',
        toolName: 'bash',
        decision: 'allow-session',
        at: '2026-07-03T06:00:00.000Z',
      },
    ]);

    expect(parseApprovalAuditLog(await readFile(auditPath, 'utf8'))).toEqual([
      {
        t: 'approval-request',
        requestId: 'approval-1',
        sessionId: 'goal-1',
        toolName: 'bash',
        capability: 'executes-code',
        reason: 'executes code',
        detail: 'git status --short',
        at: '2026-07-03T06:00:00.000Z',
      },
      {
        t: 'approval-result',
        requestId: 'approval-1',
        sessionId: 'goal-1',
        toolName: 'bash',
        decision: 'allow-session',
        at: '2026-07-03T06:00:00.000Z',
      },
    ]);
  });

  it('records safe approval details without leaking write content into events or audit logs', async () => {
    const bus = new InMemoryEventBus();
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    const auditPath = join(dir, 'goal-2.jsonl');

    const approver = createApprovalEventApprover({
      approver: async () => ({ decision: 'deny', reason: 'use the existing section' }),
      bus,
      store: new FileApprovalAuditStore(auditPath),
      sessionId: 'goal-2',
      idFactory: () => 'approval-2',
      now: () => new Date('2026-07-03T06:01:00.000Z'),
    });

    await approver({
      toolName: 'write',
      capability: 'writes-files',
      args: { path: 'src/app.ts', content: 'super-secret-value' },
      reason: 'writes files',
    });

    const auditText = await readFile(auditPath, 'utf8');
    expect(JSON.stringify(events)).not.toContain('super-secret-value');
    expect(auditText).not.toContain('super-secret-value');
    expect(events.find((event) => event.type === 'approval_request')).toMatchObject({
      detail: '路径: src/app.ts',
    });
    expect(events.find((event) => event.type === 'approval_result')).toMatchObject({
      decision: 'deny',
      reason: 'use the existing section',
    });
    expect(parseApprovalAuditLog(auditText)).toContainEqual(expect.objectContaining({
      t: 'approval-result',
      decision: 'deny',
      reason: 'use the existing section',
    }));
  });
});
