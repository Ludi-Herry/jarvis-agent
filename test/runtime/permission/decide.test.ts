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

  it('routes an executes-code call through the command parser (asks for a safe command)', () => {
    // B2: executes-code is parsed, not statically defaulted — a safe command resolves to ask
    // with source "command". Dangerous/secret commands are covered in command.test.ts.
    expect(decide(req('executes-code', { command: 'npm test' }), policy)).toMatchObject({
      action: 'ask',
      source: 'command',
    });
  });

  it('asks for a network call', () => {
    expect(decide(req('network', { url: 'https://x' }), policy).action).toBe('ask');
  });
});

describe('decide — configured rules (B5)', () => {
  const withRules = (rules: Parameters<typeof decide>[1]['rules']) => ({ ...defaultPolicy(), rules });

  it('an allow rule downgrades a non-exec tool from ask to allow', () => {
    const p = withRules([{ action: 'allow', tool: 'write', pattern: 'src/*' }]);
    expect(decide({ toolName: 'write', capability: 'writes-files', args: { path: 'src/a.ts' } }, p)).toMatchObject({
      action: 'allow',
      source: 'rule',
    });
  });

  it('a rule can NEVER auto-allow an executes-code command — it stays ask (must be approved)', () => {
    const p = withRules([{ action: 'allow', tool: 'bash', pattern: 'npm test*' }]);
    expect(decide({ toolName: 'bash', capability: 'executes-code', args: { command: 'npm test' } }, p).action).toBe('ask');
  });

  it('a rule CAN still deny an executes-code command', () => {
    const p = withRules([{ action: 'deny', tool: 'bash', pattern: 'npm *' }]);
    expect(decide({ toolName: 'bash', capability: 'executes-code', args: { command: 'npm run x' } }, p)).toMatchObject({
      action: 'deny',
      source: 'rule',
    });
  });

  it('a deny rule blocks a tool that would otherwise ask', () => {
    const p = withRules([{ action: 'deny', tool: 'write', pattern: '*' }]);
    expect(decide({ toolName: 'write', capability: 'writes-files', args: { path: 'a.ts' } }, p)).toMatchObject({
      action: 'deny',
      source: 'rule',
    });
  });

  it('nearest-first: the first matching rule wins (deny listed before allow)', () => {
    const p = withRules([
      { action: 'deny', tool: 'bash', pattern: 'npm *' },
      { action: 'allow', tool: 'bash', pattern: 'npm test' },
    ]);
    expect(decide({ toolName: 'bash', capability: 'executes-code', args: { command: 'npm test' } }, p).action).toBe('deny');
  });

  it('a rule allow CANNOT override the hard secret-path deny (.env)', () => {
    const p = withRules([{ action: 'allow', tool: 'read', pattern: '*' }]);
    expect(decide({ toolName: 'read', capability: 'read-only', args: { path: '.env' } }, p)).toMatchObject({
      action: 'deny',
      source: 'sensitive-path',
    });
  });

  it('a rule allow CANNOT override a dangerous-command deny', () => {
    const p = withRules([{ action: 'allow', tool: 'bash', pattern: '*' }]);
    expect(decide({ toolName: 'bash', capability: 'executes-code', args: { command: 'git push --force' } }, p)).toMatchObject({
      action: 'deny',
      source: 'command',
    });
  });

  it('a rule allow CANNOT override a secret read via bash', () => {
    const p = withRules([{ action: 'allow', tool: 'bash', pattern: '*' }]);
    expect(decide({ toolName: 'bash', capability: 'executes-code', args: { command: 'cat .env' } }, p).action).toBe('deny');
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
