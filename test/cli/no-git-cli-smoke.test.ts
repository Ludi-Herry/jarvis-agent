import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('autonomous CLI no-Git guardrail wiring', () => {
  it('goal refuses before creating runtime logs or contacting the provider', async () => {
    const cwd = await fixture();
    const result = await runCli('goal-cli.ts', ['inspect this directory'], cwd);

    expect(result.code).toBe(CLI_EXIT.USAGE);
    expect(result.stderr).toContain('No usable Git baseline was found');
    expect(result.stderr).toContain('--allow-no-git');
    await expect(stat(join(cwd, 'data'))).rejects.toThrow();
  });

  it('loop refuses before creating its loop log or contacting the provider', async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, 'objectives.txt'), 'inspect this directory\n', 'utf8');
    const result = await runCli('loop-cli.ts', ['objectives.txt'], cwd);

    expect(result.code).toBe(CLI_EXIT.USAGE);
    expect(result.stderr).toContain('No usable Git baseline was found');
    expect(result.stderr).toContain('--allow-no-git');
    await expect(stat(join(cwd, 'data'))).rejects.toThrow();
  });
});

async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'jarvis-no-git-'));
  tempDirs.push(path);
  await writeFile(join(path, '.env'), 'ARK_API_KEY=dummy-test-key\n', 'utf8');
  return path;
}

function runCli(file: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.ARK_API_KEY;
  const child = spawn(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli', file), ...args],
    { cwd, env, windowsHide: true },
  );
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
      reject(new Error(`${file} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);
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
