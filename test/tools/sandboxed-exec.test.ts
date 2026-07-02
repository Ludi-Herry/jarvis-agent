import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildDefaultRegistry,
  createSandboxedExecTool,
  type SandboxedExecToolOptions,
} from '../../src/core/index.js';
import {
  createUnavailableSandboxRunner,
  sandboxUnavailable,
  type SandboxRunRequest,
  type SandboxRunner,
} from '../../src/runtime/index.js';

describe('sandboxed_exec tool factory', () => {
  it('is not part of the default registry', () => {
    const registry = buildDefaultRegistry();

    expect(registry.capabilityOf('sandboxed_exec')).toBeUndefined();
    expect(registry.schemasForModel().map((schema) => schema.name)).not.toContain('sandboxed_exec');
  });

  it('declares executes-code and routes through the injected sandbox runner', async () => {
    let captured: SandboxRunRequest | undefined;
    const runner: SandboxRunner = {
      backend: 'unavailable',
      async run(request) {
        captured = request;
        return sandboxUnavailable(request, 'disabled for test');
      },
    };
    const tool = createSandboxedExecTool({ runner, sandboxCwd: '/sandbox/project', limits: { timeoutMs: 5_000 } });

    const result = await tool.run({ command: 'git status --short', reason: 'inspect changes' }, { cwd: '/host/project' });

    expect(tool.capability).toBe('executes-code');
    expect(captured).toEqual({
      command: ['bash', '--noprofile', '--norc', '-c', 'git status --short'],
      cwd: '/sandbox/project',
      mounts: [{ hostPath: '/host/project', sandboxPath: '/sandbox/project', access: 'read-only' }],
      networkMode: 'none',
      limits: { timeoutMs: 5_000, outputBytes: 32_768 },
      reason: 'inspect changes',
    });
    expect(result.error).toBe('Sandbox unavailable: disabled for test');
  });

  it('does not execute the command when the sandbox is unavailable', async () => {
    const marker = join(tmpdir(), `jarvis-sandboxed-exec-${Date.now()}-${Math.random()}.txt`);
    const options: SandboxedExecToolOptions = {
      runner: createUnavailableSandboxRunner('no backend'),
      limits: { timeoutMs: 1_000, outputBytes: 4_096 },
    };
    const tool = createSandboxedExecTool(options);

    const result = await tool.run({ command: 'git status --short' }, { cwd: process.cwd() });

    expect(result.error).toBe('Sandbox unavailable: no backend');
    expect(result.content).toContain('"networkMode": "none"');
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects commands outside the inspection scope before calling the runner', async () => {
    let called = false;
    const tool = createSandboxedExecTool({
      runner: {
        backend: 'wsl2-unshare',
        async run(request) {
          called = true;
          return sandboxUnavailable(request, 'should not be called');
        },
      },
    });

    const result = await tool.run({ command: 'touch should-not-run' }, { cwd: process.cwd() });

    expect(called).toBe(false);
    expect(result.content).toBe('');
    expect(result.error).toMatch(/Sandboxed inspection command rejected/);
    expect(existsSync(join(process.cwd(), 'should-not-run'))).toBe(false);
  });
});
