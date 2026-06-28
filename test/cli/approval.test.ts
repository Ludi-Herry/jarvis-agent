import { describe, expect, it } from 'vitest';
import { renderApprovalRequest, parseApprovalChoice } from '../../src/surfaces/cli/approval.js';
import type { ApprovalRequest } from '../../src/runtime/permission/index.js';

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  toolName: 'bash',
  capability: 'executes-code',
  args: { command: 'npm test' },
  reason: 'runs a shell command',
  ...over,
});

describe('renderApprovalRequest', () => {
  it('shows the tool, capability, detail, reason, and the options', () => {
    const text = renderApprovalRequest(req());
    expect(text).toContain('bash');
    expect(text).toContain('executes-code');
    expect(text).toContain('npm test');
    expect(text).toContain('runs a shell command');
    expect(text).toContain('[a]');
    expect(text).toContain('[d]');
  });

  it('shows a file path for a file tool', () => {
    expect(renderApprovalRequest(req({ toolName: 'write', capability: 'writes-files', args: { path: 'src/a.ts' } }))).toContain('src/a.ts');
  });

  it('truncates a huge command so it cannot flood the prompt', () => {
    const text = renderApprovalRequest(req({ args: { command: 'x'.repeat(500) } }));
    expect(text).toContain('…');
  });
});

describe('parseApprovalChoice', () => {
  it('maps allow-once forms', () => {
    for (const s of ['a', 'A', ' allow ', 'o', 'once', 'y', 'yes']) {
      expect(parseApprovalChoice(s)).toBe('allow-once');
    }
  });

  it('maps allow-session forms', () => {
    for (const s of ['s', 'session', 'allow-session']) expect(parseApprovalChoice(s)).toBe('allow-session');
  });

  it('maps deny forms', () => {
    for (const s of ['d', 'n', 'no', 'deny', 'DENY']) expect(parseApprovalChoice(s)).toBe('deny');
  });

  it('returns undefined (re-ask) for blank or unrecognized — never a silent allow/deny', () => {
    for (const s of ['', '   ', 'maybe', 'q']) expect(parseApprovalChoice(s)).toBeUndefined();
  });
});
