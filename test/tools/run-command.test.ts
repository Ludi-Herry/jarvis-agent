import { describe, expect, it } from 'vitest';
import { defaultShellPath, isSecretEnvName, runCommand } from '../../src/core/tools/run-command.js';

const shellPath = defaultShellPath();

describe('isSecretEnvName — credential-shaped env var names', () => {
  it('flags secrets (provider config/key, tokens, *_KEY, passwords, PAT, DSN, connection strings)', () => {
    for (const n of [
      'ARK_API_KEY',
      'ARK_MODEL', // app provider prefix — model shell never needs it
      'GITHUB_TOKEN',
      'GITHUB_PAT',
      'NPM_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'OPENAI_API_KEY',
      'MY_PASSWORD',
      'DB_PASSWD',
      'SERVICE_CREDENTIAL',
      'X_APIKEY',
      'AUTHORIZATION',
      'SENTRY_DSN',
      'DATABASE_URL',
      'DB_URL',
      'MONGODB_URI',
      'REDIS_URL',
      'POSTGRES_URL',
      'CONNECTION_STRING',
    ]) {
      expect(isSecretEnvName(n), n).toBe(true);
    }
  });

  it('keeps innocuous names (no false positives that would break the shell)', () => {
    for (const n of [
      'PATH',
      'HOME',
      'LANG',
      'TMPDIR',
      'PWD',
      'SHELL',
      'USERPROFILE',
      'MONKEY',
      'TURNKEY_CONFIG',
      'API_URL', // a plain URL, not a connection string
      'BASE_URL',
      'CONNECTIONS_COUNT',
    ]) {
      expect(isSecretEnvName(n), n).toBe(false);
    }
  });
});

describe('runCommand — secret env scrubbing (model-facing vs harness)', () => {
  const VAR = 'JARVIS_TEST_SECRET_TOKEN';

  async function withEnv(value: string, fn: () => Promise<void>): Promise<void> {
    const prev = process.env[VAR];
    process.env[VAR] = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env[VAR];
      else process.env[VAR] = prev;
    }
  }

  it('harness mode (no scrub) keeps the full env — a config-sourced check may legitimately need it', async () => {
    await withEnv('HARNESS-OK', async () => {
      const r = await runCommand(shellPath, `echo "[$${VAR}]"`, process.cwd(), 10_000, 1_000);
      expect(r.output).toContain('HARNESS-OK');
    });
  });

  it('model-facing mode (scrubSecretEnv) removes the credential-shaped var', async () => {
    await withEnv('LEAKME-DO-NOT-EXFIL', async () => {
      const r = await runCommand(shellPath, `echo "[$${VAR}]"`, process.cwd(), 10_000, 1_000, undefined, {
        scrubSecretEnv: true,
      });
      expect(r.output).toContain('[]'); // the var is gone from the child env
      expect(r.output).not.toContain('LEAKME-DO-NOT-EXFIL');
    });
  });

  it('scrubbing keeps PATH so the shell still works', async () => {
    const r = await runCommand(shellPath, 'echo "[${PATH:+set}]"', process.cwd(), 10_000, 1_000, undefined, {
      scrubSecretEnv: true,
    });
    expect(r.output).toContain('[set]');
  });

  it('scrubGitEnv removes inherited GIT_* values before applying trusted overrides', async () => {
    const prev = process.env.GIT_EXTERNAL_DIFF;
    process.env.GIT_EXTERNAL_DIFF = 'evil-diff';
    try {
      const r = await runCommand(shellPath, 'echo "[$GIT_EXTERNAL_DIFF][$GIT_OPTIONAL_LOCKS]"', process.cwd(), 10_000, 1_000, undefined, {
        scrubGitEnv: true,
        extraEnv: { GIT_OPTIONAL_LOCKS: '0' },
      });

      expect(r.output).toContain('[][0]');
      expect(r.output).not.toContain('evil-diff');
    } finally {
      if (prev === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = prev;
    }
  });
});
