import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cron CLI process boundary', () => {
  it('does not load .env before spawning loop-cli children', async () => {
    const source = await readFile('src/surfaces/cli/cron-cli.ts', 'utf8');
    expect(source).not.toContain('process.loadEnvFile');
  });

  it('checks launch-env ARK_API_KEY before spawning npm run loop', async () => {
    const source = await readFile('src/surfaces/cli/cron-cli.ts', 'utf8');
    expect(source).toContain('assertKeyNotInLaunchEnv');
    expect(source).toContain('ARK_KEY_IN_LAUNCH_ENV');
  });

  it('takes a cron lock before scanning due tasks', async () => {
    const source = await readFile('src/surfaces/cli/cron-cli.ts', 'utf8');
    expect(source).toContain('FileLoopCronLock');
    expect(source).toContain('tryAcquire');
    expect(source).toContain('LOOP_CRON_LOCK_STALE_MS');
    expect(source).toContain('beforeRunTask');
    expect(source).toContain('lock.renew()');
  });

  it('fails the cron process when the scan lock cannot be acquired', async () => {
    const source = await readFile('src/surfaces/cli/cron-cli.ts', 'utf8');
    expect(source).toContain('if (lock === null)');
    expect(source).toContain('process.exitCode = 1');
  });

  it('exits non-zero without writing a cron attempt when a fresh scan lock exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-cron-cli-cwd-'));
    const configDir = await mkdtemp(join(tmpdir(), 'jarvis-cron-cli-config-'));
    try {
      await mkdir(join(cwd, 'data', 'cron'), { recursive: true });
      await writeFile(
        join(cwd, 'data', 'cron', 'loop-cron.lock'),
        JSON.stringify({ token: 'held-token', pid: process.pid, acquiredAt: new Date().toISOString() }),
      );
      const cronMap = join(configDir, 'cron.json');
      await writeFile(
        cronMap,
        JSON.stringify({
          tasks: [
            {
              id: 'task-a',
              objectivesFile: join(configDir, 'objectives.txt'),
              intervalMinutes: 1,
              nextRunAt: '2026-07-01T00:00:00.000Z',
              unattended: true,
            },
          ],
        }),
      );

      const result = await runCronCli(['--cron-map', cronMap], cwd);

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('cron scan lock');
      await expect(readFile(join(cwd, 'data', 'cron', 'loop-cron.jsonl'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

function runCronCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.ARK_API_KEY;
  const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli/cron-cli.ts'), ...args], {
    cwd,
    env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('cron CLI timed out'));
    }, 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}
