import { appendFile, link, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listGuiApprovalHistory } from '../../../src/surfaces/gui/approval-history.js';

let dir: string;
let dataDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-g4-approval-history-'));
  dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('G4 approval history', () => {
  it('returns a clean teaching empty state when no approval directory exists', async () => {
    await expect(listGuiApprovalHistory(dataDir)).resolves.toEqual({
      records: [],
      total: 0,
      truncated: false,
      coverage: 'complete',
      warnings: [],
    });
  });

  it('pairs request and result facts while preserving pending and orphan records', async () => {
    const approvalsDir = join(dataDir, 'approvals');
    await mkdir(approvalsDir, { recursive: true });
    const bidi = String.fromCodePoint(0x202e);
    await writeFile(
      join(approvalsDir, 'goal-1.jsonl'),
      [
        approvalRequest('a1', 'write', '2026-08-24T09:00:00.000Z', `token=secretvalue ${bidi}\nREADME.md`),
        approvalResult('a1', 'write', 'allow-once', '2026-08-24T09:00:01.000Z'),
        approvalRequest('a2', 'bash', '2026-08-24T09:01:00.000Z', 'npm test'),
        approvalResult('a3', 'write', 'deny', '2026-08-24T09:02:00.000Z'),
      ].map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );

    const history = await listGuiApprovalHistory(dataDir);

    expect(history).toMatchObject({ total: 3, truncated: false, coverage: 'complete', warnings: [] });
    expect(history.records.map((record) => record.status)).toEqual(['orphan-result', 'pending', 'allowed']);
    const allowed = history.records.find((record) => record.requestId === 'a1');
    expect(allowed).toMatchObject({
      sessionId: 'goal-1',
      toolName: 'write',
      decision: 'allow-once',
      source: 'approvals/goal-1.jsonl',
      persistedRecords: { request: true, result: true },
    });
    expect(allowed?.detail).toContain('token=***');
    expect(allowed?.detail).not.toContain(bidi);
    expect(allowed?.detail).not.toContain('\n');
  });

  it('pairs persisted identities before applying the display sanitization projection', async () => {
    const approvalsDir = join(dataDir, 'approvals');
    await mkdir(approvalsDir, { recursive: true });
    const bidi = String.fromCodePoint(0x202e);
    await writeFile(
      join(approvalsDir, 'identity.jsonl'),
      [
        approvalRequest(`same${bidi}`, 'read', '2026-08-24T09:00:00.000Z', 'first'),
        approvalRequest('same', 'read', '2026-08-24T09:00:01.000Z', 'second'),
      ].map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );

    const history = await listGuiApprovalHistory(dataDir);

    expect(history.total).toBe(2);
    expect(history.records.map((record) => record.requestId)).toEqual(['same', 'same']);
    expect(history.records.map((record) => record.detail)).toEqual(['second', 'first']);
    expect(JSON.stringify(history)).not.toContain(bidi);
  });

  it('marks an invalid optional session id partial without failing the history endpoint', async () => {
    const approvalsDir = join(dataDir, 'approvals');
    await mkdir(approvalsDir, { recursive: true });
    await writeFile(
      join(approvalsDir, 'mixed.jsonl'),
      [
        approvalRequest('valid', 'read', '2026-08-24T09:00:00.000Z', 'visible'),
        { ...approvalRequest('invalid', 'read', '2026-08-24T09:00:01.000Z', 'hidden'), sessionId: null },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );

    const history = await listGuiApprovalHistory(dataDir);

    expect(history).toMatchObject({ total: 1, coverage: 'partial' });
    expect(history.records).toEqual([expect.objectContaining({ requestId: 'valid' })]);
    expect(history.warnings).toEqual(['有一份审批历史包含无法解析的记录']);
  });

  it('skips oversized and hard-linked files before parsing', async () => {
    const approvalsDir = join(dataDir, 'approvals');
    await mkdir(approvalsDir, { recursive: true });
    await writeFile(join(approvalsDir, 'oversized.jsonl'), 'x'.repeat(300 * 1024), 'utf8');
    const linked = join(approvalsDir, 'linked.jsonl');
    await writeFile(linked, '{}\n', 'utf8');
    await link(linked, join(approvalsDir, 'linked-copy.jsonl'));

    const history = await listGuiApprovalHistory(dataDir);

    expect(history).toMatchObject({ records: [], total: 0, coverage: 'partial' });
    expect(history.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('262144'),
      '有一份审批历史不是安全文件',
    ]));
  });

  it('caps opened-file growth and rejects a validation-to-open path replacement', async () => {
    const approvalsDir = join(dataDir, 'approvals');
    await mkdir(approvalsDir, { recursive: true });
    const growing = join(approvalsDir, 'growing.jsonl');
    await writeFile(growing, `${JSON.stringify(approvalRequest('a1', 'write', 't1', 'README.md'))}\n`, 'utf8');

    const grown = await listGuiApprovalHistory(dataDir, 100, {
      afterOpen: async (path) => {
        if (path === growing) await appendFile(path, 'x'.repeat(300 * 1024), 'utf8');
      },
    });
    expect(grown).toMatchObject({ records: [], total: 0, coverage: 'partial' });
    expect(grown.warnings).toEqual([expect.stringContaining('读取期间发生变化')]);

    await rm(approvalsDir, { recursive: true, force: true });
    await mkdir(approvalsDir, { recursive: true });
    const swapped = join(approvalsDir, 'swapped.jsonl');
    await writeFile(swapped, `${JSON.stringify(approvalRequest('a2', 'write', 't2', 'original'))}\n`, 'utf8');
    const rejected = await listGuiApprovalHistory(dataDir, 100, {
      afterPathValidation: async (path) => {
        await rename(path, `${path}.original`);
        await writeFile(path, `${JSON.stringify(approvalRequest('a2', 'write', 't2', 'replacement'))}\n`, 'utf8');
      },
    });
    expect(rejected).toMatchObject({ records: [], total: 0, coverage: 'partial' });
    expect(rejected.warnings).toEqual(['有一份审批历史不是安全文件']);
  });

  it('stops a compact file before storing record 1001', async () => {
    const approvalsDir = join(dataDir, 'approvals');
    await mkdir(approvalsDir, { recursive: true });
    const text = Array.from({ length: 1001 }, (_, index) => (
      JSON.stringify(approvalRequest(`a${index}`, 'read', `t${index}`, 'x'))
    )).join('\n') + '\n';
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(256 * 1024);
    await writeFile(join(approvalsDir, 'many.jsonl'), text, 'utf8');

    const history = await listGuiApprovalHistory(dataDir);

    expect(history).toMatchObject({ total: 1000, truncated: true, coverage: 'partial' });
    expect(history.records).toHaveLength(100);
    expect(history.warnings).toEqual([expect.stringContaining('1000')]);
  });
});

function approvalRequest(requestId: string, toolName: string, at: string, detail: string) {
  return {
    t: 'approval-request' as const,
    requestId,
    sessionId: 'goal-1',
    toolName,
    capability: toolName === 'read' ? 'read-only' as const : toolName === 'bash' ? 'executes-code' as const : 'writes-files' as const,
    reason: 'approval required',
    detail,
    at,
  };
}

function approvalResult(
  requestId: string,
  toolName: string,
  decision: 'allow-once' | 'allow-session' | 'deny' | 'error',
  at: string,
) {
  return {
    t: 'approval-result' as const,
    requestId,
    sessionId: 'goal-1',
    toolName,
    decision,
    at,
  };
}
