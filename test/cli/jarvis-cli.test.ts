import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardChildProcess } from '../../src/surfaces/cli/jarvis.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis root CLI', () => {
  it('shows the unified command tree and version without a provider key', async () => {
    const help = await runJarvis(['--help']);
    const version = await runJarvis(['--version']);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: jarvis');
    expect(help.stdout).toContain('goal [args...]');
    expect(help.stdout).toContain('doctor [options]');
    expect(help.stderr).not.toContain('ARK_API_KEY');
    expect(version).toMatchObject({ code: 0, stdout: '0.1.0\n' });
  });

  it('shows subcommand help without launching the model-facing entry point', async () => {
    const result = await runJarvis(['goal', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: jarvis goal');
    expect(result.stdout).toContain('jarvis goal --allow-no-git');
    expect(result.stderr).not.toContain('ARK_API_KEY');
  });

  it('applies --cwd before forwarding status, including when the flag follows the command', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis cwd with spaces '));
    tempDirs.push(workspace);

    const result = await runJarvis(['status', '--cwd', workspace, '--json']);
    const report = JSON.parse(result.stdout) as { meta: { source: { dataDir: string } } };

    expect(result.code).toBe(0);
    expect(report.meta.source.dataDir).toBe(resolve(workspace, 'data'));
  });

  it('uses exit 2 for an invalid global cwd', async () => {
    const result = await runJarvis(['--cwd', join(repo, 'definitely-missing-cwd'), 'status']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--cwd');
  });

  it.each([2, 3, 4, 5, 6, 7])('forwards child exit code %i unchanged', async (exitCode) => {
    const result = await forwardChildProcess(fixtureArgs('exit', String(exitCode)), repo, new EventEmitter());

    expect(result).toBe(exitCode);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('relays %s to the active child and exits 130 without leaving it running', async (signal) => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-signal-relay-'));
    tempDirs.push(workspace);
    const auditPath = join(workspace, 'signal-audit.txt');
    await writeFile(auditPath, '', 'utf8');

    const signals = new EventEmitter();
    const resultPromise = forwardChildProcess(fixtureArgs('wait', auditPath), repo, signals);
    await waitForText(auditPath, 'started:');
    signals.emit(signal);
    const result = await resultPromise;
    const audit = await readFile(auditPath, 'utf8');
    const pid = Number(/^started:(\d+)/u.exec(audit)?.[1]);

    expect(result).toBe(130);
    expect(Number.isFinite(pid)).toBe(true);
    expect(isProcessAlive(pid)).toBe(false);
    if (process.platform !== 'win32') expect(audit).toContain(`signal:${signal}`);
  });

  it('declares an included source bootstrap whose loader is a runtime dependency', async () => {
    const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.bin).toEqual({ jarvis: 'bin/jarvis.js' });
    await expect(readFile(join(repo, 'bin', 'jarvis.js'), 'utf8')).resolves.toContain("import 'tsx/esm'");
    expect(pkg.dependencies?.tsx).toBe('4.22.4');
    expect(pkg.devDependencies?.tsx).toBeUndefined();
  });
});

function runJarvis(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env = { ...process.env, ARK_API_KEY: '' };
    execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      { cwd: repo, env, encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        const code = typeof rawCode === 'number' ? rawCode : null;
        done({ code, stdout, stderr });
      },
    );
  });
}

function fixtureArgs(...args: string[]): string[] {
  return ['--import', import.meta.resolve('tsx'), join(repo, 'test', 'fixtures', 'cli-child.ts'), ...args];
}

async function waitForText(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.includes(expected)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${expected}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
