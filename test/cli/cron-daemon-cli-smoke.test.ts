import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

describe('cron daemon CLI smoke', () => {
  const signalIt = process.platform === 'win32' ? it.skip : it;

  signalIt('runs in the foreground, handles SIGINT, writes audit JSONL, and releases the daemon lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-cron-daemon-cwd-'));
    const configDir = await mkdtemp(join(tmpdir(), 'jarvis-cron-daemon-config-'));
    try {
      const cronMap = await writeCronMap(configDir, '2026-07-01T01:00:00.000Z');
      const child = spawnCronDaemon(['--cron-map', cronMap, '--poll-ms', '10000'], cwd);
      await waitForOutput(child, /Jarvis-Agent cron daemon/);
      child.proc.kill('SIGINT');
      const result = await child.result;

      expect(result.code).toBe(0);
      const daemonLog = await readFile(join(cwd, 'data', 'cron', 'loop-cron-daemon.jsonl'), 'utf8');
      expect(daemonLog).toContain('"t":"daemon-started"');
      expect(daemonLog).toContain('"t":"daemon-stopped"');
      await expect(stat(join(cwd, 'data', 'cron', 'loop-cron-daemon.lock'))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when another daemon holds a fresh daemon lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-cron-daemon-cwd-'));
    const configDir = await mkdtemp(join(tmpdir(), 'jarvis-cron-daemon-config-'));
    try {
      await mkdir(join(cwd, 'data', 'cron'), { recursive: true });
      await writeFile(
        join(cwd, 'data', 'cron', 'loop-cron-daemon.lock'),
        JSON.stringify({ token: 'held-token', pid: 123, acquiredAt: new Date().toISOString() }),
        'utf8',
      );
      const cronMap = await writeCronMap(configDir, '2026-07-01T01:00:00.000Z');

      const result = await runCronDaemonCli(['--cron-map', cronMap], cwd);

      expect(result.code).toBe(CLI_EXIT.NEEDS_HUMAN);
      expect(`${result.stdout}\n${result.stderr}`).toContain('daemon lock');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

async function writeCronMap(dir: string, nextRunAt: string): Promise<string> {
  const cronMap = join(dir, 'cron.json');
  await writeFile(
    cronMap,
    JSON.stringify({
      tasks: [
        {
          id: 'future',
          objectivesFile: join(dir, 'objectives.txt'),
          intervalMinutes: 30,
          nextRunAt,
          unattended: true,
        },
      ],
    }),
    'utf8',
  );
  return cronMap;
}

function runCronDaemonCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnCronDaemon(args, cwd);
  return child.result;
}

function spawnCronDaemon(
  args: string[],
  cwd: string,
): {
  proc: ReturnType<typeof spawn>;
  getOutput: () => string;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const env = { ...process.env };
  delete env.ARK_API_KEY;
  const proc = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli/cron-daemon-cli.ts'), ...args], {
    cwd,
    env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`cron daemon CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });

  return { proc, getOutput: () => `${stdout}\n${stderr}`, result };
}

function waitForOutput(child: ReturnType<typeof spawnCronDaemon>, pattern: RegExp): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${pattern}\n${child.getOutput()}`));
    }, 10_000);
    const poll = setInterval(() => {
      if (pattern.test(child.getOutput())) {
        clearTimeout(timer);
        clearInterval(poll);
        resolvePromise();
      }
    }, 50);
    child.result.then((result) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`process exited before ${pattern}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`));
    }).catch((err) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(err);
    });
  });
}
