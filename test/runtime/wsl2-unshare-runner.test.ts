import { describe, expect, it } from 'vitest';
import { createWsl2UnshareSandboxRunner, type SandboxRunRequest } from '../../src/runtime/index.js';

describe('Wsl2UnshareSandboxRunner', () => {
  it('runs through wsl.exe and parses the structured sandbox result', async () => {
    const calls: { command: string; args: readonly string[]; input: string; env: NodeJS.ProcessEnv; timeout: number }[] = [];
    const runner = createWsl2UnshareSandboxRunner({
      distro: 'TestDistro',
      spawnSync(command, args, options) {
        calls.push({ command, args, input: options.input, env: options.env, timeout: options.timeout });
        return {
          status: 0,
          signal: null,
          stdout:
            'noise before\n' +
            'JARVIS_SANDBOX_RESULT\t{"status":"completed","exitCode":0,"stdout":"ok","stderr":"","durationMs":12}\n',
          stderr: '',
        };
      },
    });

    const result = await runner.run(sampleRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'wsl.exe',
      args: ['-d', 'TestDistro', '--', 'python3', '-'],
      timeout: 6_000,
    });
    expect(calls[0].input).toContain('PAYLOAD_B64 = "');
    expect(calls[0].input).toContain('env=SAFE_ENV');
    expect(result).toMatchObject({
      status: 'completed',
      backend: 'wsl2-unshare',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 12,
    });
    expect(result.audit).toMatchObject({
      backend: 'wsl2-unshare',
      command: ['bash', '--noprofile', '--norc', '-c', 'printf ok'],
      networkMode: 'none',
    });
  });

  it('scrubs shell startup hooks and credential-shaped env before launching WSL', async () => {
    let env: NodeJS.ProcessEnv | undefined;
    const prevBashEnv = process.env.BASH_ENV;
    const prevEnv = process.env.ENV;
    const prevSecret = process.env.JARVIS_TEST_SECRET_TOKEN;
    const prevGitExternalDiff = process.env.GIT_EXTERNAL_DIFF;
    process.env.BASH_ENV = '/tmp/evil-startup.sh';
    process.env.ENV = '/tmp/evil-posix-startup.sh';
    process.env.JARVIS_TEST_SECRET_TOKEN = 'LEAKME-DO-NOT-EXFIL';
    process.env.GIT_EXTERNAL_DIFF = '/tmp/evil-diff.sh';
    try {
      const runner = createWsl2UnshareSandboxRunner({
        spawnSync(_command, _args, options) {
          env = options.env;
          return {
            status: 0,
            signal: null,
            stdout: 'JARVIS_SANDBOX_RESULT\t{"status":"completed","exitCode":0,"stdout":"ok","stderr":"","durationMs":1}\n',
            stderr: '',
          };
        },
      });

      await runner.run(sampleRequest());

      expect(env?.BASH_ENV).toBeUndefined();
      expect(env?.ENV).toBeUndefined();
      expect(env?.JARVIS_TEST_SECRET_TOKEN).toBeUndefined();
      expect(env?.GIT_EXTERNAL_DIFF).toBeUndefined();
      expect(env?.PATH ?? env?.Path).toBeTruthy();
      expect(env?.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env?.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env?.GIT_CONFIG_KEY_1).toBe('diff.external');
      expect(env?.GIT_CONFIG_VALUE_1).toBe('');
      expect(env?.GIT_CONFIG_KEY_2).toBe('core.fsmonitor');
      expect(env?.GIT_CONFIG_VALUE_2).toBe('false');
    } finally {
      if (prevBashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = prevBashEnv;
      if (prevEnv === undefined) delete process.env.ENV;
      else process.env.ENV = prevEnv;
      if (prevSecret === undefined) delete process.env.JARVIS_TEST_SECRET_TOKEN;
      else process.env.JARVIS_TEST_SECRET_TOKEN = prevSecret;
      if (prevGitExternalDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = prevGitExternalDiff;
    }
  });

  it('cleans WSL temp roots by default and can retain them for smoke debugging', async () => {
    let defaultInput = '';
    const defaultRunner = createWsl2UnshareSandboxRunner({
      spawnSync(_command, _args, options) {
        defaultInput = options.input;
        return {
          status: 0,
          signal: null,
          stdout: 'JARVIS_SANDBOX_RESULT\t{"status":"completed","exitCode":0,"stdout":"ok","stderr":"","durationMs":1}\n',
          stderr: '',
        };
      },
    });
    await defaultRunner.run(sampleRequest());

    let retainedInput = '';
    const retainedRunner = createWsl2UnshareSandboxRunner({
      retainTempDirs: true,
      spawnSync(_command, _args, options) {
        retainedInput = options.input;
        return {
          status: 0,
          signal: null,
          stdout: 'JARVIS_SANDBOX_RESULT\t{"status":"completed","exitCode":0,"stdout":"ok","stderr":"","durationMs":1}\n',
          stderr: '',
        };
      },
    });
    await retainedRunner.run(sampleRequest());

    expect(defaultInput).toContain('RETAIN_TEMP_DIR = False');
    expect(defaultInput).toContain('shutil.rmtree(root, ignore_errors=True)');
    expect(retainedInput).toContain('RETAIN_TEMP_DIR = True');
  });

  it('fails closed when WSL returns no result marker', async () => {
    const runner = createWsl2UnshareSandboxRunner({
      spawnSync() {
        return { status: 1, signal: null, stdout: 'plain output', stderr: 'plain error' };
      },
    });

    const result = await runner.run(sampleRequest());

    expect(result.status).toBe('failed-to-start');
    if (result.status !== 'failed-to-start') throw new Error(`Expected failed-to-start, got ${result.status}`);
    expect(result.reason).toContain('did not return a sandbox result');
    expect(result.reason).toContain('plain output');
    expect(result.reason).toContain('plain error');
  });

  it('maps spawn timeout errors to timed-out', async () => {
    const calls: string[] = [];
    const runner = createWsl2UnshareSandboxRunner({
      spawnSync(_command, _args, options) {
        calls.push(options.input);
        if (calls.length === 1) {
          return {
            status: null,
            signal: null,
            stdout: '',
            stderr: '',
            error: new Error('ETIMEDOUT'),
          };
        }
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    });

    const result = await runner.run(sampleRequest());

    expect(result.status).toBe('timed-out');
    if (result.status !== 'timed-out') throw new Error(`Expected timed-out, got ${result.status}`);
    expect(result.reason).toBe('ETIMEDOUT');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('"/tmp/jarvis-wsl2-unshare-');
    expect(calls[1]).toContain('shutil.rmtree(root, ignore_errors=True)');
  });

  it('retains WSL temp roots after host timeout when retainTempDirs is enabled', async () => {
    let calls = 0;
    const runner = createWsl2UnshareSandboxRunner({
      retainTempDirs: true,
      spawnSync() {
        calls += 1;
        return {
          status: null,
          signal: null,
          stdout: '',
          stderr: '',
          error: new Error('ETIMEDOUT'),
        };
      },
    });

    const result = await runner.run(sampleRequest());

    expect(result.status).toBe('timed-out');
    expect(calls).toBe(1);
  });

  it('rejects unsupported network modes before spawning WSL', async () => {
    let spawned = false;
    const runner = createWsl2UnshareSandboxRunner({
      spawnSync() {
        spawned = true;
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    });

    const result = await runner.run({ ...sampleRequest(), networkMode: 'explicit' });

    expect(result.status).toBe('failed-to-start');
    if (result.status !== 'failed-to-start') throw new Error(`Expected failed-to-start, got ${result.status}`);
    expect(result.reason).toBe('Only networkMode "none" is supported.');
    expect(spawned).toBe(false);
  });

  it('rejects unsupported resource limits before spawning WSL', async () => {
    let spawned = false;
    const runner = createWsl2UnshareSandboxRunner({
      spawnSync() {
        spawned = true;
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    });

    const result = await runner.run({
      ...sampleRequest(),
      limits: { timeoutMs: 1_000, outputBytes: 4_096, maxProcesses: 16, memoryBytes: 1024, cpuMillis: 500 },
    });

    expect(result.status).toBe('failed-to-start');
    if (result.status !== 'failed-to-start') throw new Error(`Expected failed-to-start, got ${result.status}`);
    expect(result.reason).toContain('maxProcesses');
    expect(result.reason).toContain('memoryBytes');
    expect(result.reason).toContain('cpuMillis');
    expect(spawned).toBe(false);
  });
});

function sampleRequest(): SandboxRunRequest {
  return {
    command: ['bash', '--noprofile', '--norc', '-c', 'printf ok'],
    cwd: '/work/project',
    mounts: [{ hostPath: 'H:\\jarvis-agent', sandboxPath: '/work/project', access: 'read-only' }],
    networkMode: 'none',
    limits: { timeoutMs: 1_000, outputBytes: 4_096 },
    reason: 'test',
  };
}
