import { describe, expect, it, vi } from 'vitest';
import {
  appendConfigPermissionBoundary,
  buildConfigInspectionReport,
  formatConfigInspectionReport,
  loadCliConfig,
  reportConfigWarnings,
} from '../../src/surfaces/cli/config.js';

describe('typed config CLI projection', () => {
  it('loads through the injected boundary and never exposes provider credentials', async () => {
    const config = await loadCliConfig({
      cwd: 'workspace',
      userHome: 'home',
      env: {
        ARK_API_KEY: 'must-not-appear',
        ARK_MODEL: 'environment-model',
      },
      options: { strict: false, ignoreUser: true, preset: 'inspect' },
      readText: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });
    const report = buildConfigInspectionReport(config, true);

    expect(report).toMatchObject({
      schemaVersion: 1,
      authority: {
        mode: 'observation-only',
        canCompleteGoals: false,
        canCompleteLoops: false,
      },
      effective: {
        provider: 'doubao',
        model: 'environment-model',
        preset: 'inspect',
        permissions: {
          readOnly: 'allow',
          writesFiles: 'deny',
          executesCode: 'deny',
          network: 'deny',
        },
      },
    });
    expect(JSON.stringify(report)).not.toContain('must-not-appear');
    expect(report).toHaveProperty('sources');
  });

  it('omits provenance when --sources is absent and renders untrusted fields inertly', async () => {
    const config = await loadCliConfig({
      cwd: 'workspace',
      userHome: `home${String.fromCharCode(27)}[2J`,
      env: {},
      options: { strict: false, ignoreUser: true, model: 'line\r\nforged' },
      readText: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });
    const report = buildConfigInspectionReport(config, false);
    const human = formatConfigInspectionReport(report);

    expect(report).not.toHaveProperty('sources');
    expect(human).not.toContain(String.fromCharCode(27));
    expect(human).not.toContain('line\r\nforged');
    expect(human).toContain('line forged');
  });

  it('reports warning key paths through the same single-line terminal boundary', async () => {
    const stderr = vi.fn();
    const config = await loadCliConfig({
      cwd: 'workspace',
      userHome: 'home',
      env: {},
      options: { strict: false, ignoreUser: false },
      readText: async (path) => path.includes('home')
        ? `schemaVersion = 1\n"unknown${String.fromCodePoint(0x202e)}field" = true`
        : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    });

    reportConfigWarnings(config, stderr);

    expect(stderr).toHaveBeenCalledOnce();
    const rendered = String(stderr.mock.calls[0]?.[0]);
    expect(rendered).not.toContain(String.fromCodePoint(0x202e));
    expect(rendered.trim().split('\n')).toHaveLength(1);
  });

  it('keeps the legacy prompt byte-identical by default and binds explicit policy changes', async () => {
    const base = 'legacy prompt';
    const defaults = await loadCliConfig({
      cwd: 'workspace',
      userHome: 'home',
      env: {},
      options: { strict: false, ignoreUser: true },
      readText: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });
    const inspect = await loadCliConfig({
      cwd: 'workspace',
      userHome: 'home',
      env: {},
      options: { strict: false, ignoreUser: true, preset: 'inspect' },
      readText: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });

    expect(appendConfigPermissionBoundary(base, defaults)).toBe(base);
    expect(appendConfigPermissionBoundary(base, inspect)).toContain(
      '[jarvis-config-v1] preset=inspect; read-only=allow; writes-files=deny; executes-code=deny; network=deny',
    );
  });

  it('binds explicit model endpoints by digest without injecting their raw text', async () => {
    const base = 'legacy prompt';
    const explicit = await loadCliConfig({
      cwd: 'workspace',
      userHome: 'home',
      env: {},
      options: {
        strict: false,
        ignoreUser: true,
        model: 'explicit-model',
        baseURL: 'https://provider.example/v1',
      },
      readText: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });

    const bounded = appendConfigPermissionBoundary(base, explicit);
    expect(bounded).toMatch(/\[jarvis-config-v1\] identity-sha256=[a-f0-9]{64}$/u);
    expect(bounded).not.toContain('explicit-model');
    expect(bounded).not.toContain('provider.example');
  });

  it('binds nonblank environment endpoints while leaving built-in defaults byte-identical', async () => {
    const base = 'legacy prompt';
    const load = (baseURL?: string) => loadCliConfig({
      cwd: 'workspace',
      userHome: 'home',
      env: baseURL === undefined ? {} : { ARK_MODEL: 'same-model', ARK_BASE_URL: baseURL },
      options: { strict: false, ignoreUser: true },
      readText: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });
    const defaults = await load();
    const endpointA = await load('https://provider-a.example/v1');
    const endpointB = await load('https://provider-b.example/v1');

    const promptA = appendConfigPermissionBoundary(base, endpointA);
    const promptB = appendConfigPermissionBoundary(base, endpointB);
    expect(appendConfigPermissionBoundary(base, defaults)).toBe(base);
    expect(promptA).toMatch(/identity-sha256=[a-f0-9]{64}$/u);
    expect(promptB).toMatch(/identity-sha256=[a-f0-9]{64}$/u);
    expect(promptA).not.toBe(promptB);
    expect(promptA).not.toContain('provider-a.example');
    expect(promptB).not.toContain('provider-b.example');
  });
});
