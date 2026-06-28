import { describe, expect, it } from 'vitest';
import { decide, defaultPolicy } from '../../../src/runtime/permission/decide.js';
import type { PermissionRequest } from '../../../src/runtime/permission/decide.js';
import type { ToolCapability } from '../../../src/core/tools/types.js';

const policy = defaultPolicy();

function req(capability: ToolCapability, args: Record<string, unknown> = {}): PermissionRequest {
  return { toolName: 't', capability, args };
}

describe('decide — capability defaults', () => {
  it('allows a read-only call on a normal path', () => {
    const d = decide(req('read-only', { path: 'src/index.ts' }), policy);
    expect(d).toMatchObject({ action: 'allow', source: 'capability' });
    expect(d.reason).toMatch(/read-only/);
  });

  it('asks for a writes-files call on a normal path', () => {
    const d = decide(req('writes-files', { path: 'src/app.ts', content: 'x' }), policy);
    expect(d).toMatchObject({ action: 'ask', source: 'capability' });
    expect(d.reason).toMatch(/writes files/);
  });

  it('asks for an executes-code call (the B2 parser is not here yet)', () => {
    expect(decide(req('executes-code', { command: 'npm test' }), policy)).toMatchObject({
      action: 'ask',
      source: 'capability',
    });
  });

  it('asks for a network call', () => {
    expect(decide(req('network', { url: 'https://x' }), policy).action).toBe('ask');
  });
});

describe('decide — sensitive paths deny READ as well as write (deepcode hole)', () => {
  it('denies READING .env even though read is otherwise allow', () => {
    const d = decide(req('read-only', { path: '.env' }), policy);
    expect(d).toMatchObject({ action: 'deny', source: 'sensitive-path' });
    expect(d.reason).toContain('.env'); // explainable: names the offending path
  });

  it('denies WRITING .env', () => {
    expect(decide(req('writes-files', { path: '.env', content: 'X=1' }), policy).action).toBe('deny');
  });

  it.each([
    '.env.local',
    'config/.env.production',
    'server.pem',
    'certs/private.key',
    'service-account/auth.json',
    '.npmrc',
    'deploy/.git-credentials',
    'home/.ssh/known_hosts',
    '.ssh/id_ed25519',
    'keys/id_rsa',
  ])('denies sensitive path %s (read)', (path) => {
    expect(decide(req('read-only', { path }), policy).action).toBe('deny');
  });

  it('matches case- and separator-insensitively (Windows paths/casing cannot slip past)', () => {
    expect(decide(req('read-only', { path: 'CONF\\.ENV' }), policy).action).toBe('deny');
  });

  it('checks every path in an array-valued path arg', () => {
    expect(decide(req('read-only', { paths: ['ok.ts', 'secrets/.env'] }), policy).action).toBe('deny');
  });

  it('sensitive-path deny BEATS the capability default (deny is evaluated first)', () => {
    // read-only would be allow; the secret path must override it to deny.
    expect(decide(req('read-only', { path: '.env' }), policy)).toMatchObject({
      action: 'deny',
      source: 'sensitive-path',
    });
  });
});

describe('decide — only path-like keys are scanned (no false positives)', () => {
  it('does NOT deny a write whose CONTENT merely mentions .env', () => {
    // content is not a path key — a doc that talks about .env must still be writable.
    const d = decide(req('writes-files', { path: 'README.md', content: 'set vars in .env first' }), policy);
    expect(d.action).toBe('ask'); // gated as a normal write, NOT denied
  });

  it('does not treat an arbitrary non-path string field as a path', () => {
    expect(decide(req('read-only', { query: 'grep for .env usage' }), policy).action).toBe('allow');
  });
});
