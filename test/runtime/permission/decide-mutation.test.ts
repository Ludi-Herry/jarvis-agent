/**
 * 变异测试补强（2026-10）：Stryker 发现这些"改坏 decide.ts"的方式原测试抓不住。
 * 主要是"放行方向"：规则匹配、规则匹配的对象（subject）、路径参数识别——
 * 任何一处被改坏，都可能让 ask 变 allow、deny 变 ask。
 */
import { describe, expect, it } from 'vitest';
import { decide, defaultPolicy } from '../../../src/runtime/permission/decide.js';
import type { PermissionPolicy, PermissionRequest, PermissionRule } from '../../../src/runtime/permission/decide.js';

function policy(rules: PermissionRule[] = []): PermissionPolicy {
  return { ...defaultPolicy(), rules };
}

function req(toolName: string, capability: PermissionRequest['capability'], args: Record<string, unknown>): PermissionRequest {
  return { toolName, capability, args };
}

describe('decide — 路径参数名大小写不敏感（密钥不能换个大小写就读出来）', () => {
  it.each(['Path', 'FILE_PATH', 'File', 'TARGET', 'Dirs'])('%s: .env → deny', (key) => {
    expect(decide(req('read_file', 'read-only', { [key]: '.env' }), policy()).action).toBe('deny');
  });

  it('只扫路径类参数：文件内容里提到 .env 不拦', () => {
    expect(decide(req('write_file', 'writes-files', { path: 'notes.md', content: 'see .env' }), policy()).action).toBe('ask');
  });
});

describe('decide — 规则只对"指定的工具 + 匹配的路径"生效', () => {
  const allowDocsForWrite: PermissionRule = { action: 'allow', tool: 'write_file', pattern: 'docs/*' };

  it('允许规则不会放行别的工具', () => {
    expect(decide(req('write_file', 'writes-files', { path: 'docs/a.md' }), policy([allowDocsForWrite])).action).toBe('allow');
    expect(decide(req('other_tool', 'writes-files', { path: 'docs/a.md' }), policy([allowDocsForWrite])).action).toBe('ask');
  });

  it('允许规则不会放行不匹配的路径（工具对了也不行）', () => {
    expect(decide(req('write_file', 'writes-files', { path: 'src/a.ts' }), policy([allowDocsForWrite])).action).toBe('ask');
  });

  it('tool 为 * 的拒绝规则对所有工具生效', () => {
    const denyProd: PermissionRule = { action: 'deny', tool: '*', pattern: 'config/prod.json' };
    expect(decide(req('write_file', 'writes-files', { path: 'config/prod.json' }), policy([denyProd]))).toMatchObject({
      action: 'deny',
      source: 'rule',
      reason: 'matches a configured deny rule',
    });
  });

  it('规则里的 . 等字符按字面匹配（既不能漏拦，也不能多放）', () => {
    const denyExact: PermissionRule = { action: 'deny', tool: '*', pattern: 'config/prod.json' };
    expect(decide(req('write_file', 'writes-files', { path: 'config/prodxjson' }), policy([denyExact])).action).toBe('ask');
    const allowExact: PermissionRule = { action: 'allow', tool: '*', pattern: 'docs/a.md' };
    expect(decide(req('write_file', 'writes-files', { path: 'docs/aXmd' }), policy([allowExact])).action).toBe('ask');
    expect(decide(req('write_file', 'writes-files', { path: 'docs/a.md' }), policy([allowExact])).action).toBe('allow');
  });

  it('非 bash 工具带 command 参数时，规则匹配的是 command，而不是路径', () => {
    const denyPublish: PermissionRule = { action: 'deny', tool: '*', pattern: 'npm publish*' };
    const r = req('remote_run', 'network', { command: 'npm publish', path: 'pkg' });
    expect(decide(r, policy([denyPublish])).action).toBe('deny');
  });

  it('规则匹配的路径只取"路径类参数里的字符串"，不会拿内容或数组去匹配', () => {
    const allowDocs: PermissionRule = { action: 'allow', tool: '*', pattern: 'docs/*' };
    expect(decide(req('write_file', 'writes-files', { content: 'docs/a.md', path: 'src/x.ts' }), policy([allowDocs])).action).toBe(
      'ask',
    );
    expect(decide(req('write_file', 'writes-files', { file: ['docs/a.md'], path: 'src/x.ts' }), policy([allowDocs])).action).toBe(
      'ask',
    );
  });
});

describe('decide — 奇怪的参数类型不崩溃、不放松', () => {
  it('路径参数是数字 → 忽略，按能力默认', () => {
    expect(() => decide(req('write_file', 'writes-files', { path: 42 }), policy())).not.toThrow();
    expect(decide(req('write_file', 'writes-files', { path: 42 }), policy()).action).toBe('ask');
  });

  it('路径数组里混了非字符串 → 仍然能认出其中的密钥', () => {
    expect(decide(req('read_many', 'read-only', { paths: [5, '.env'] }), policy()).action).toBe('deny');
  });

  it('bash 的 command 不是字符串 → 当作空命令，仍需审批', () => {
    expect(decide(req('bash', 'executes-code', { command: 42 }), policy())).toMatchObject({ action: 'ask', source: 'command' });
  });
});

describe('decide — 给人看的理由', () => {
  it('bash 审批理由、各能力默认理由、配置禁用理由', () => {
    expect(decide(req('bash', 'executes-code', { command: 'ls' }), policy()).reason).toBe('runs a shell command — approve to execute');
    expect(decide(req('fetch', 'network', { url: 'https://x' }), policy()).reason).toBe('accesses the network');
    expect(decide(req('read', 'read-only', { path: 'a.md' }), policy()).reason).toBe('read-only operation');
    const off: PermissionPolicy = { ...policy(), capabilityDefault: { ...defaultPolicy().capabilityDefault, network: 'deny' } };
    expect(decide(req('fetch', 'network', { url: 'https://x' }), off)).toMatchObject({
      action: 'deny',
      reason: 'network capability is disabled by the effective configuration',
    });
  });
});
