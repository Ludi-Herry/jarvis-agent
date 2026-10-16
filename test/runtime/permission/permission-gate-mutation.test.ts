/**
 * 变异测试补强（2026-10）：Stryker 发现这些"改坏 permission-gate.ts"的方式原测试抓不住。
 * 都是"放行方向"或"让人在不知情时批准"的问题。
 */
import { describe, expect, it } from 'vitest';
import { DefaultPermissionGate, type ApprovalRequest, type ApprovalResponse } from '../../../src/runtime/permission/permission-gate.js';
import type { ToolCall } from '../../../src/core/types.js';

function call(name: string, args: unknown): ToolCall {
  return { id: `c-${name}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

function recordingApprover(answer: ApprovalResponse): { approver: (r: ApprovalRequest) => Promise<ApprovalResponse>; seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  return {
    approver: async (r) => {
      seen.push(r);
      return answer;
    },
    seen,
  };
}

describe('PermissionGate — 会话授权不串到别的工具', () => {
  it('对 write_file 选"本会话允许"后，network 工具仍要再问', async () => {
    const a = recordingApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    expect((await gate.check(call('write_file', { path: 'a.md' }), 'writes-files')).allowed).toBe(true);
    expect((await gate.check(call('fetch_url', { url: 'https://example.com' }), 'network')).allowed).toBe(true);
    expect(a.seen.map((r) => r.toolName)).toEqual(['write_file', 'fetch_url']);
  });

  it('同一工具第二次直接放行，并说明来源是会话授权', async () => {
    const a = recordingApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    await gate.check(call('write_file', { path: 'a.md' }), 'writes-files');
    expect(await gate.check(call('write_file', { path: 'b.md' }), 'writes-files')).toEqual({
      allowed: true,
      reason: 'session-approved: write_file',
      source: 'user',
    });
    expect(a.seen).toHaveLength(1);
  });

  it('bash 的会话授权按"完整命令"记，说明里带上命令', async () => {
    const a = recordingApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    await gate.check(call('bash', { command: 'npm test' }), 'executes-code');
    expect(await gate.check(call('bash', { command: 'npm test' }), 'executes-code')).toEqual({
      allowed: true,
      reason: 'session-approved command: npm test',
      source: 'user',
    });
  });
});

describe('PermissionGate — 审批人看得到要批的是什么', () => {
  it('审批请求带上工具名、能力、参数和理由', async () => {
    const a = recordingApprover('allow-once');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const out = await gate.check(call('bash', { command: 'npm test' }), 'executes-code');
    expect(out).toEqual({ allowed: true, reason: 'approved by user (allow-once)', source: 'user' });
    expect(a.seen).toEqual([
      {
        toolName: 'bash',
        capability: 'executes-code',
        args: { command: 'npm test' },
        reason: 'runs a shell command — approve to execute',
      },
    ]);
  });
});

describe('PermissionGate — 审批人给出无效回答 → 拒绝（fail-closed）', () => {
  it.each(['yes', 'allow', '', 'ALLOW-ONCE'])('回答 %j → 不放行', async (answer) => {
    const a = recordingApprover(answer as never);
    const gate = new DefaultPermissionGate({ approver: a.approver });
    expect(await gate.check(call('write_file', { path: 'a.md' }), 'writes-files')).toEqual({
      allowed: false,
      reason: 'approver returned an invalid answer',
      source: 'fail-closed',
    });
  });

  it('用户拒绝时说明里带上原因（字符串回答没有附言）', async () => {
    const gate = new DefaultPermissionGate({ approver: recordingApprover('deny').approver });
    expect((await gate.check(call('write_file', { path: 'a.md' }), 'writes-files')).reason).toBe(
      'denied by user — writes files — review before applying',
    );
  });
});

describe('PermissionGate — 参数解析：非对象一律当空对象，不崩溃', () => {
  it.each(['null', '[".env"]', '"x"', '   ', 'not json'])('arguments=%j', async (raw) => {
    const a = recordingApprover('allow-once');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const out = await gate.check(call('write_file', raw), 'writes-files');
    expect(out.allowed).toBe(true);
    expect(a.seen[0]!.args).toEqual({});
  });

  it('未知工具（没有能力标签）→ 拒绝并说明', async () => {
    const gate = new DefaultPermissionGate({ approver: recordingApprover('allow-once').approver });
    expect(await gate.check(call('mystery', {}), undefined)).toEqual({
      allowed: false,
      reason: "unknown tool 'mystery' has no declared capability",
      source: 'fail-closed',
    });
  });

  it('没有审批人 → 拒绝并说明原因', async () => {
    const gate = new DefaultPermissionGate();
    expect(await gate.check(call('write_file', { path: 'a.md' }), 'writes-files')).toEqual({
      allowed: false,
      reason: 'approval required but no approver available — writes files — review before applying',
      source: 'fail-closed',
    });
  });
});
