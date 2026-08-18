import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];

// This file intentionally launches several real CLI subprocesses per test. Full-suite worker
// contention can exceed Vitest's 5 s unit-test default even though each child has its own 20 s cap.
vi.setConfig({ testTimeout: 20_000 });
afterAll(() => vi.resetConfig());
const ESC = String.fromCharCode(27);
const KEY_SENTINEL = 'ark-sentinel-key-value-never-print';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis stop (workspace emergency stop)', () => {
  it('discovers stop from root help and works without a provider key', async () => {
    const [rootHelp, stopHelp] = await Promise.all([
      runJarvis(['--help']),
      runJarvis(['stop', '--help']),
    ]);

    expect(rootHelp.code).toBe(0);
    expect(rootHelp.stdout).toContain('stop');
    expect(stopHelp).toMatchObject({ code: 0 });
    expect(stopHelp.stdout).toContain('jarvis stop');
    expect(stopHelp.stdout).toContain('--clear');
    for (const result of [rootHelp, stopHelp]) {
      expect(result.stderr).not.toContain(KEY_SENTINEL);
      expect(result.stderr).not.toContain('ARK_API_KEY');
    }
  }, 10_000);

  it('writes the stop record, appends the audit, and reports it in JSON', async () => {
    const workspace = await tempWorkspace('basic ');

    const stop = await runJarvis(['--cwd', workspace, 'stop', '--reason', 'maintenance window', '--json']);

    expect(stop.code).toBe(0);
    const report = JSON.parse(stop.stdout) as {
      schemaVersion: number;
      authority: { mode: string; canCompleteGoals: boolean; canCompleteLoops: boolean };
      action: string;
      requested: boolean;
      record: { source: string; reason: string; pid: number; cwd: string; requestedAt: string };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.authority).toEqual({ mode: 'control', canCompleteGoals: false, canCompleteLoops: false });
    expect(report.action).toBe('stop');
    expect(report.requested).toBe(true);
    expect(report.record).toMatchObject({ source: 'cli', reason: 'maintenance window' });
    expect(report.record.cwd).toBe(resolve(workspace));
    expect(stop.stdout.includes(ESC)).toBe(false);

    const stopFile = await readFile(join(workspace, 'data', 'control', 'emergency-stop.json'), 'utf8');
    expect(stopFile).toContain('"source": "cli"');
    const audit = await readFile(join(workspace, 'data', 'control', 'emergency-stop.jsonl'), 'utf8');
    expect(audit.trim().split('\n')).toHaveLength(1);
    expect(audit).toContain('maintenance window');

    const text = await runJarvis(['--cwd', workspace, 'stop']);
    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('Emergency stop requested (workspace-wide)');
    expect(text.stdout).toContain('completion authority: none (control action only)');
  });

  it('clears the stop and reports no-stop-in-effect on a repeat clear', async () => {
    const workspace = await tempWorkspace('clear ');
    await runJarvis(['--cwd', workspace, 'stop']);

    const clear = await runJarvis(['--cwd', workspace, 'stop', '--clear']);
    expect(clear).toMatchObject({ code: 0 });
    expect(clear.stdout).toContain('Emergency stop cleared');
    await expect(readFile(join(workspace, 'data', 'control', 'emergency-stop.json'), 'utf8')).rejects.toThrow();

    const again = await runJarvis(['--cwd', workspace, 'stop', '--clear']);
    expect(again).toMatchObject({ code: 0 });
    expect(again.stdout).toContain('No emergency stop in effect');

    // clear never appends to the stop audit
    const audit = await readFile(join(workspace, 'data', 'control', 'emergency-stop.jsonl'), 'utf8');
    expect(audit.trim().split('\n')).toHaveLength(1);
  });

  it('rejects a positional id and --reason combined with --clear with exit 2', async () => {
    const workspace = await tempWorkspace('usage ');

    const withId = await runJarvis(['--cwd', workspace, 'stop', 'some-goal-id']);
    expect(withId.code).toBe(CLI_EXIT.USAGE);
    expect(withId.stderr).toContain('does not take an id');

    const conflict = await runJarvis(['--cwd', workspace, 'stop', '--reason', 'x', '--clear']);
    expect(conflict.code).toBe(CLI_EXIT.USAGE);
    expect(conflict.stderr).toContain('--reason does not apply to --clear');

    await expect(readFile(join(workspace, 'data', 'control', 'emergency-stop.json'), 'utf8')).rejects.toThrow();
  });

  it('sanitizes the reason in text output and keeps standard escaping in JSON and audit', async () => {
    const workspace = await tempWorkspace('injection ');
    const hostile = `stop now${ESC}[31m\r\nFORGED-LINE`;

    const text = await runJarvis(['--cwd', workspace, 'stop', '--reason', hostile]);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).not.toContain(ESC);
    expect(text.stdout).not.toContain('\r');
    expect(text.stdout).not.toContain('\nFORGED-LINE');

    const json = await runJarvis(['--cwd', workspace, 'stop', '--reason', hostile, '--json']);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as { record: { reason: string } };
    expect(report.record.reason).toBe(hostile); // JSON keeps the verbatim value, standard escaping
    expect(json.stdout.includes(ESC)).toBe(false); // JSON.stringify escapes the control chars
  });

  it('halts a running cron daemon after a CLI stop request (real end to end)', async () => {
    const workspace = await tempWorkspace('daemon ');
    const configDir = await tempWorkspace('daemon config ');
    await writeFile(join(workspace, 'objectives.txt'), 'inspect the workspace\n', 'utf8');
    const cronMap = join(configDir, 'cron.json');
    await writeFile(
      cronMap,
      JSON.stringify({
        tasks: [{
          id: 'future',
          objectivesFile: join(workspace, 'objectives.txt'),
          intervalMinutes: 30,
          nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
          unattended: true,
        }],
      }),
      'utf8',
    );

    const daemon = spawnJarvis(['--cwd', workspace, 'cron', 'daemon', '--cron-map', cronMap]);
    try {
      await waitForOutput(daemon, /cron daemon - 1 tasks/u);
      const stop = await runJarvis(['--cwd', workspace, 'stop', '--reason', 'e2e stop']);
      expect(stop.code).toBe(0);
      const result = await daemon.result;
      expect(result.stderr).toContain('[emergency-stop] e2e stop');
      expect(result.code).not.toBeNull();
    } finally {
      daemon.proc.kill();
    }
  }, 30_000);

  it('does not affect runs started after the stop request (time gating)', async () => {
    const workspace = await tempWorkspace('gating ');
    const stop = await runJarvis(['--cwd', workspace, 'stop']);
    expect(stop.code).toBe(0);

    // A run that starts now must ignore the stale stop file: a fresh daemon
    // keeps polling instead of halting at startup.
    const configDir = await tempWorkspace('gating config ');
    await writeFile(join(workspace, 'objectives.txt'), 'inspect\n', 'utf8');
    const cronMap = join(configDir, 'cron.json');
    await writeFile(
      cronMap,
      JSON.stringify({
        tasks: [{
          id: 'future',
          objectivesFile: join(workspace, 'objectives.txt'),
          intervalMinutes: 30,
          nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
          unattended: true,
        }],
      }),
      'utf8',
    );
    const daemon = spawnJarvis(['--cwd', workspace, 'cron', 'daemon', '--cron-map', cronMap]);
    try {
      await waitForOutput(daemon, /sleeping until/u);
      expect(daemon.getOutput()).not.toContain('[emergency-stop]');
    } finally {
      daemon.proc.kill();
      await daemon.result.catch(() => undefined);
    }
  }, 30_000);

  it('never loads a provider or echoes the credential value', async () => {
    const source = await readFile(join(repo, 'src', 'surfaces', 'cli', 'stop.ts'), 'utf8');
    expect(source).not.toMatch(/createProvider|loadDoubaoConfig|loadEnvFile|ARK_API_KEY/u);

    const workspace = await tempWorkspace('nokey ');
    const stop = await runJarvis(['--cwd', workspace, 'stop'], KEY_SENTINEL);
    expect(stop).toMatchObject({ code: 0 });
    expect(stop.stdout).not.toContain(KEY_SENTINEL);
    expect(stop.stderr).not.toContain(KEY_SENTINEL);
  });
});

async function tempWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `jarvis stop e2e ${prefix}`));
  tempDirs.push(workspace);
  await mkdir(join(workspace, 'data'), { recursive: true });
  return workspace;
}

function runJarvis(
  args: string[],
  apiKey: string | null = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: 'stop-cli-test-model' };
    delete env.JARVIS_HOOKS;
    delete env.ARK_VISION_MODEL;
    if (apiKey === null) delete env.ARK_API_KEY;
    else env.ARK_API_KEY = apiKey;
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      { cwd: repo, env, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        const code = typeof rawCode === 'number' ? rawCode : null;
        done({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

function spawnJarvis(args: string[]): {
  proc: ReturnType<typeof spawn>;
  getOutput: () => string;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: 'stop-cli-test-model' };
  delete env.JARVIS_HOOKS;
  delete env.ARK_VISION_MODEL;
  delete env.ARK_API_KEY;
  const proc = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: repo,
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
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
    proc.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
  return { proc, getOutput: () => `${stdout}\n${stderr}`, result };
}

function waitForOutput(
  child: ReturnType<typeof spawnJarvis>,
  pattern: RegExp,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${pattern}\n${child.getOutput()}`));
    }, 20_000);
    const poll = setInterval(() => {
      if (pattern.test(child.getOutput())) {
        clearTimeout(timer);
        clearInterval(poll);
        resolvePromise();
      }
    }, 100);
  });
}
