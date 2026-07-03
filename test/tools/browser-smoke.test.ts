import { describe, expect, it } from 'vitest';
import {
  buildDefaultRegistry,
  createBrowserSmokeTool,
  InMemoryToolRegistry,
} from '../../src/core/index.js';
import { buildVerifierRegistry } from '../../src/capabilities/goal/verifier.js';
import { sandboxUnavailable, type SandboxRunRequest, type SandboxRunner } from '../../src/runtime/index.js';

describe('browser smoke tool factory', () => {
  it('is absent from default and verifier registries', () => {
    const defaults = buildDefaultRegistry();
    const verifier = buildVerifierRegistry();

    expect(defaults.capabilityOf('browser_smoke')).toBeUndefined();
    expect(defaults.schemasForModel().map((schema) => schema.name)).not.toContain('browser_smoke');
    expect(verifier.capabilityOf('browser_smoke')).toBeUndefined();
    expect(verifier.schemasForModel().map((schema) => schema.name)).not.toContain('browser_smoke');
  });

  it('declares read-only and runs the fixed static-dist profile in a no-network sandbox copy', async () => {
    let captured: SandboxRunRequest | undefined;
    const runner: SandboxRunner = {
      backend: 'wsl2-unshare',
      async run(request) {
        captured = request;
        return sandboxUnavailable(request, 'disabled for test');
      },
    };
    const tool = createBrowserSmokeTool({
      runner,
      sandboxSourceDir: '/sandbox/source',
      sandboxWorkDir: '/sandbox/work',
      limits: { timeoutMs: 7_000, outputBytes: 8_000 },
    });

    const result = await tool.run({ profile: 'static-dist', reason: 'check the built page' }, { cwd: '/host/project' });

    expect(tool.capability).toBe('read-only');
    expect(captured).toMatchObject({
      command: ['bash', '--noprofile', '--norc', '-c', expect.any(String)],
      cwd: '/sandbox/source',
      mounts: [{ hostPath: '/host/project', sandboxPath: '/sandbox/source', access: 'read-only' }],
      networkMode: 'none',
      limits: { timeoutMs: 7_000, outputBytes: 8_000 },
      reason: 'browser smoke static-dist: check the built page',
    });
    const script = captured?.command[4] ?? '';
    expect(script).toContain("rm -rf '/sandbox/work'");
    expect(script).toContain("mkdir -p '/sandbox/work'");
    expect(script).toContain("--exclude='.env'");
    expect(script).toContain("--exclude='.ssh'");
    expect(script).toContain("-cf - -C '/sandbox/source' . | tar -xf - -C '/sandbox/work'");
    expect(script).toContain("cd '/sandbox/work'");
    expect(script).toContain("export HOME='/sandbox/work/.jarvis-browser-home'");
    expect(script).toContain("export XDG_CACHE_HOME='/sandbox/work/.jarvis-browser-cache'");
    expect(script).toContain('dist/index.html');
    expect(script).toContain('JARVIS_BROWSER_SMOKE_RESULT');
    expect(result.error).toBe('Browser smoke sandbox unavailable: disabled for test');
    expect(result.content).toContain('"networkMode": "none"');
  });

  it('rejects arbitrary commands, URLs, host, port, and browser paths before any runner call', async () => {
    let called = false;
    const registry = new InMemoryToolRegistry();
    registry.register(
      createBrowserSmokeTool({
        runner: {
          backend: 'wsl2-unshare',
          async run(request) {
            called = true;
            return sandboxUnavailable(request, 'should not be called');
          },
        },
      }),
    );

    for (const args of [
      { profile: 'static-dist', command: 'npm run dev' },
      { profile: 'static-dist', url: 'https://example.com' },
      { profile: 'static-dist', host: '127.0.0.1' },
      { profile: 'static-dist', port: 5173 },
      { profile: 'static-dist', browserPath: '/usr/bin/chromium' },
      { profile: 'local-preview' },
    ]) {
      const result = await registry.run(
        { id: `call-${JSON.stringify(args)}`, name: 'browser_smoke', arguments: JSON.stringify(args) },
        { cwd: '/host/project' },
      );
      expect(result.error).toMatch(/Invalid arguments for browser_smoke/);
    }
    expect(called).toBe(false);
  });

  it('returns completed smoke output as builder feedback without granting completion authority', async () => {
    const tool = createBrowserSmokeTool({
      runner: {
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
            stdout:
              'JARVIS_BROWSER_SMOKE_RESULT\t' +
              JSON.stringify({
                profile: 'static-dist',
                status: 'failed',
                url: 'file:///sandbox/work/dist/index.html',
                title: 'Broken',
                nonBlankPixels: 0,
                consoleErrors: ['boom'],
                pageErrors: [],
                blockedRequests: ['https://example.com/app.js'],
                durationMs: 25,
              }) +
              '\n',
            stderr: '',
            durationMs: 30,
          };
        },
      },
    });

    const result = await tool.run({ profile: 'static-dist' }, { cwd: '/host/project' });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain('[browser smoke: static-dist]');
    expect(result.content).toContain('[status: failed]');
    expect(result.content).toContain('[exit code: 1]');
    expect(result.content).toContain('console errors: boom');
    expect(result.content).toContain('blocked requests: https://example.com/app.js');
    expect(result.content).toContain('completion authority: none');
  });
});
