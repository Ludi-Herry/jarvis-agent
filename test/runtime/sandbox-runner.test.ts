import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createUnavailableSandboxRunner,
  sandboxUnavailable,
  type SandboxRunRequest,
} from '../../src/runtime/index.js';

describe('SandboxRunner unavailable boundary', () => {
  it('returns unavailable with an audit trail instead of executing the request', async () => {
    const marker = join(tmpdir(), `jarvis-sandbox-unavailable-${Date.now()}-${Math.random()}.txt`);
    const request = sampleRequest(['bash', '-lc', `echo escaped > "${marker}"`]);
    const runner = createUnavailableSandboxRunner('wsl2 backend disabled');

    const result = await runner.run(request);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error(`Expected unavailable, got ${result.status}`);
    expect(result.backend).toBe('unavailable');
    expect(result.reason).toBe('wsl2 backend disabled');
    expect(result.audit).toMatchObject({
      backend: 'unavailable',
      command: request.command,
      cwd: request.cwd,
      networkMode: 'none',
      limits: request.limits,
    });
    expect(result.audit.mounts).toEqual(request.mounts);
    expect(existsSync(marker)).toBe(false);
  });

  it('copies request data into the audit record', () => {
    const command = ['python3', '-c', 'print("probe")'];
    const mounts = [
      { hostPath: '/host/project', sandboxPath: '/work/project', access: 'read-only' as const },
      { hostPath: '/host/out', sandboxPath: '/work/out', access: 'read-write' as const },
    ];
    const request: SandboxRunRequest = {
      command,
      cwd: '/work/project',
      mounts,
      networkMode: 'none',
      limits: { timeoutMs: 1_000, outputBytes: 4_096 },
      reason: 'verifier evidence probe',
    };
    const result = sandboxUnavailable(request, 'missing sandbox');

    command[0] = 'changed';
    mounts[0] = { hostPath: '/changed', sandboxPath: '/changed', access: 'read-only' };

    expect(result.audit.command).toEqual(['python3', '-c', 'print("probe")']);
    expect(result.audit.mounts).toEqual([
      { hostPath: '/host/project', sandboxPath: '/work/project', access: 'read-only' },
      { hostPath: '/host/out', sandboxPath: '/work/out', access: 'read-write' },
    ]);
  });
});

function sampleRequest(command: readonly string[]): SandboxRunRequest {
  return {
    command,
    cwd: '/work/project',
    mounts: [
      { hostPath: '/host/project', sandboxPath: '/work/project', access: 'read-only' },
      { hostPath: '/host/out', sandboxPath: '/work/out', access: 'read-write' },
    ],
    networkMode: 'none',
    limits: { timeoutMs: 1_000, outputBytes: 4_096, maxProcesses: 16, memoryBytes: 256 * 1024 * 1024 },
    reason: 'verifier evidence probe',
  };
}
