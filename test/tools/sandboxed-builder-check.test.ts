import { describe, expect, it } from 'vitest';
import { buildDefaultRegistry, createSandboxedBuilderCheckTool, InMemoryToolRegistry } from '../../src/core/index.js';
import { sandboxUnavailable, type SandboxRunRequest, type SandboxRunner } from '../../src/runtime/index.js';

describe('sandboxed builder check tool factory', () => {
  it('is not part of the default registry', () => {
    const registry = buildDefaultRegistry();

    expect(registry.capabilityOf('sandboxed_check')).toBeUndefined();
    expect(registry.schemasForModel().map((schema) => schema.name)).not.toContain('sandboxed_check');
  });

  it('declares read-only and runs an allow-listed project check in a sandbox copy', async () => {
    let captured: SandboxRunRequest | undefined;
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        captured = request;
        return sandboxUnavailable(request, 'disabled for test');
      },
    };
    const tool = createSandboxedBuilderCheckTool({
      runner,
      sandboxSourceDir: '/sandbox/source',
      sandboxWorkDir: '/sandbox/work',
      limits: { timeoutMs: 5_000 },
    });

    const result = await tool.run({ check: 'typecheck', reason: 'confirm the fix' }, { cwd: '/host/project' });

    expect(tool.capability).toBe('read-only');
    expect(captured).toMatchObject({
      command: [
        'bash',
        '--noprofile',
        '--norc',
        '-c',
        expect.any(String),
      ],
      cwd: '/sandbox/source',
      mounts: [{ hostPath: '/host/project', sandboxPath: '/sandbox/source', access: 'read-only' }],
      networkMode: 'none',
      limits: { timeoutMs: 5_000, outputBytes: 131_072 },
      reason: 'builder check typecheck: confirm the fix',
    });
    const script = captured?.command[4] ?? '';
    expect(script).toContain("rm -rf '/sandbox/work'");
    expect(script).toContain("mkdir -p '/sandbox/work'");
    expect(script).toContain("--exclude='.env'");
    expect(script).toContain("--exclude='.ssh'");
    expect(script).toContain("--exclude='*.pem'");
    expect(script).toContain("-cf - -C '/sandbox/source' . | tar -xf - -C '/sandbox/work'");
    expect(script).toContain("cd '/sandbox/work'");
    expect(script).toContain('npm run typecheck');
    expect(result.error).toBe('Sandbox unavailable: disabled for test');
  });

  it('returns non-zero check output as builder feedback, not a tool failure', async () => {
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        return {
          status: 'completed',
          backend: 'wsl2-unshare',
          audit: {
            backend: 'wsl2-unshare',
            command: request.command,
            cwd: request.cwd,
            mounts: request.mounts,
            networkMode: request.networkMode,
            limits: request.limits,
          },
          exitCode: 1,
          stdout: 'src/app.ts(1,1): error TS2304: Cannot find name.',
          stderr: 'npm ERR! code 1',
          durationMs: 123,
        };
      },
    };
    const tool = createSandboxedBuilderCheckTool({ runner });

    const result = await tool.run({ check: 'test' }, { cwd: '/host/project' });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain('src/app.ts(1,1): error TS2304');
    expect(result.content).toContain('npm ERR! code 1');
    expect(result.content).toContain('[sandboxed check: test]');
    expect(result.content).toContain('[command: npm test]');
    expect(result.content).toContain('[exit code: 1]');
  });

  it('rejects arbitrary commands at schema validation before any runner call', async () => {
    let called = false;
    const registry = new InMemoryToolRegistry();
    registry.register(
      createSandboxedBuilderCheckTool({
        runner: {
          backend: 'wsl2-unshare',
          async run(request) {
            called = true;
            return sandboxUnavailable(request, 'should not be called');
          },
        },
      }),
    );

    const result = await registry.run(
      { id: 'call-1', name: 'sandboxed_check', arguments: JSON.stringify({ command: 'rm -rf .' }) },
      { cwd: '/host/project' },
    );

    expect(called).toBe(false);
    expect(result.error).toMatch(/Invalid arguments for sandboxed_check/);
  });
});
