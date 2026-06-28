import { describe, expect, it, vi } from 'vitest';
import {
  DefaultPermissionGate,
  type Approval,
  type Approver,
} from '../../../src/runtime/permission/permission-gate.js';
import type { ToolCall } from '../../../src/core/types.js';

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) };
}

/** An approver that always returns the same verdict and counts how many times it was asked. */
function fixedApprover(verdict: Approval): { approver: Approver; asks: () => number } {
  let asks = 0;
  return {
    approver: async () => {
      asks++;
      return verdict;
    },
    asks: () => asks,
  };
}

describe('PermissionGate — allow / deny pass-through', () => {
  it('allows a read-only call without ever consulting the approver', async () => {
    const a = fixedApprover('deny');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const out = await gate.check(call('read', { path: 'src/x.ts' }), 'read-only');
    expect(out.allowed).toBe(true);
    expect(a.asks()).toBe(0); // allow never asks
  });

  it('denies a secret path and NEVER asks the approver (deny is absolute)', async () => {
    const a = fixedApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const out = await gate.check(call('read', { path: '.env' }), 'read-only');
    expect(out).toMatchObject({ allowed: false, source: 'sensitive-path' });
    expect(a.asks()).toBe(0); // an approver cannot unlock a hard deny
  });
});

describe('PermissionGate — the ask lane', () => {
  it('asks the approver for a write and allows on allow-once', async () => {
    const a = fixedApprover('allow-once');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const out = await gate.check(call('write', { path: 'src/a.ts', content: 'x' }), 'writes-files');
    expect(out.allowed).toBe(true);
    expect(a.asks()).toBe(1);
  });

  it('denies when the user says deny', async () => {
    const a = fixedApprover('deny');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const out = await gate.check(call('write', { path: 'src/a.ts' }), 'writes-files');
    expect(out).toMatchObject({ allowed: false, source: 'user' });
  });

  it('allow-once does NOT persist — the next same-tool call asks again', async () => {
    const a = fixedApprover('allow-once');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    await gate.check(call('write', { path: 'a.ts' }), 'writes-files');
    await gate.check(call('write', { path: 'b.ts' }), 'writes-files');
    expect(a.asks()).toBe(2); // asked both times
  });

  it('allow-session remembers the tool — the next same-tool call is silent', async () => {
    const a = fixedApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const first = await gate.check(call('write', { path: 'a.ts' }), 'writes-files');
    const second = await gate.check(call('write', { path: 'b.ts' }), 'writes-files');
    expect(first.allowed && second.allowed).toBe(true);
    expect(a.asks()).toBe(1); // asked once, the session grant covered the second
  });

  it('a session grant for one tool does NOT cover a different tool', async () => {
    const a = fixedApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    await gate.check(call('write', { path: 'a.ts' }), 'writes-files');
    await gate.check(call('shell', { command: 'ls' }), 'executes-code');
    expect(a.asks()).toBe(2); // grant is keyed per tool name
  });

  it('executes-code is NEVER session-grantable — every command is approved per-invocation', async () => {
    const a = fixedApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    await gate.check(call('bash', { command: 'echo a' }), 'executes-code');
    await gate.check(call('bash', { command: 'echo b' }), 'executes-code'); // allow-session did NOT stick
    expect(a.asks()).toBe(2);
  });
});

describe('PermissionGate — a session grant can never override a deny (the key safety property)', () => {
  it('write is session-allowed, yet writing .env is still denied', async () => {
    const a = fixedApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    await gate.check(call('write', { path: 'a.ts' }), 'writes-files'); // grants write for the session
    const secret = await gate.check(call('write', { path: '.env', content: 'X=1' }), 'writes-files');
    expect(secret).toMatchObject({ allowed: false, source: 'sensitive-path' });
  });
});

describe('PermissionGate — fail-closed guardrails (each trigger path exercised)', () => {
  it('no approver → an ask fails closed (non-interactive default is deny)', async () => {
    const gate = new DefaultPermissionGate(); // no approver injected
    const out = await gate.check(call('write', { path: 'a.ts' }), 'writes-files');
    expect(out).toMatchObject({ allowed: false, source: 'fail-closed' });
  });

  it('an approver that throws → fails closed (a non-answer is a no)', async () => {
    const approver: Approver = async () => {
      throw new Error('terminal disconnected');
    };
    const gate = new DefaultPermissionGate({ approver });
    const out = await gate.check(call('write', { path: 'a.ts' }), 'writes-files');
    expect(out).toMatchObject({ allowed: false, source: 'fail-closed' });
    expect(out.reason).toContain('terminal disconnected');
  });

  it('an unknown tool (undefined capability) → fails closed', async () => {
    const approver = vi.fn<Approver>(async () => 'allow-once');
    const gate = new DefaultPermissionGate({ approver });
    const out = await gate.check(call('definitely_not_a_tool'), undefined);
    expect(out).toMatchObject({ allowed: false, source: 'fail-closed' });
    expect(approver).not.toHaveBeenCalled(); // never even reaches the ask lane
  });

  it('a read-only call still allows with no approver (only ask needs one)', async () => {
    const gate = new DefaultPermissionGate();
    expect((await gate.check(call('read', { path: 'x.ts' }), 'read-only')).allowed).toBe(true);
  });
});
