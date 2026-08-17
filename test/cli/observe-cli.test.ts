import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This file launches real CLI subprocesses; full-suite worker contention can
// exceed Vitest's 5 s default even though each child has its own cap.
vi.setConfig({ testTimeout: 20_000 });
afterAll(() => vi.resetConfig());
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

let cwd: string;
let dataDir: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'jarvis-observe-cli-'));
  dataDir = join(cwd, 'data');
  await mkdir(join(dataDir, 'sessions'), { recursive: true });
  await writeFile(
    join(dataDir, 'sessions', 's1.jsonl'),
    '{"t":"session","id":"s1","model":"builder","cwd":"cwd","startedAt":"t0"}\n' +
      '{"t":"mess',
    'utf8',
  );
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('observe CLI state-integrity exit contract', () => {
  it('reserves state-corrupt for a completed partial report and runtime for unexpected failures', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(resolve('src/surfaces/cli/observe-cli.ts'), 'utf8'),
    );

    expect(source).toContain("if (report.integrity.status === 'partial') process.exitCode = CLI_EXIT.STATE_CORRUPT");
    expect(source.match(/process\.exitCode = CLI_EXIT\.RUNTIME/g)).toHaveLength(2);
  });

  it('prints a partial text report before returning the state-corrupt exit code', async () => {
    const result = await runObserveCli(['--data-dir', dataDir], cwd);

    expect(result.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(result.stdout).toContain('integrity: partial corruptLines=1 unreadableFiles=0');
    expect(result.stdout).toContain('integrity affected:');
    expect(result.stdout).toContain('- malformed-tail sessions/s1.jsonl:2');
    expect(result.stdout).toContain(`source: ${dataDir}`);
  });

  it('returns the same structured integrity report for JSON output', async () => {
    const result = await runObserveCli(['--json', '--data-dir', dataDir], cwd);

    expect(result.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(JSON.parse(result.stdout)).toMatchObject({
      meta: { schemaVersion: 1 },
      integrity: {
        status: 'partial',
        corruptLineCount: 1,
        unreadableFileCount: 0,
        affected: [{ kind: 'malformed-tail', path: 'sessions/s1.jsonl', line: 2 }],
        omittedAffectedCount: 0,
      },
    });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['empty object', {}],
    ['unknown discriminator', { t: 'future-record' }],
    ['known discriminator missing required fields', { t: 'message' }],
  ])('reports %s as structural corruption with exit 7', async (_label, invalid) => {
    await writeFile(
      join(dataDir, 'sessions', 's1.jsonl'),
      '{"t":"session","id":"s1","model":"builder","cwd":"cwd","startedAt":"t0"}\n'
        + `${JSON.stringify(invalid)}\n`,
      'utf8',
    );

    const result = await runObserveCli(['--json', '--data-dir', dataDir], cwd);
    expect(result.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(JSON.parse(result.stdout)).toMatchObject({
      integrity: {
        status: 'partial',
        corruptLineCount: 1,
        affected: [{ kind: 'invalid-record', path: 'sessions/s1.jsonl', line: 2 }],
      },
    });
  });

  it('reports a receiptless v2 tool intent as semantic corruption with exit 7', async () => {
    const header = {
      t: 'session', id: 's1', model: 'builder', cwd: 'cwd', startedAt: 't0',
      composition: {
        root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', coverage: 'full',
        toolsetHash: 'sha256.tools', systemPromptHash: 'sha256.prompt',
      },
      schemaVersion: 2, seq: 1, at: 't0',
    };
    const receiptlessIntent = {
      t: 'message',
      message: { role: 'assistant', toolCalls: [{ id: 'c1', name: 'write', arguments: '{}' }] },
      schemaVersion: 2, seq: 2, at: 't1',
    };
    await writeFile(
      join(dataDir, 'sessions', 's1.jsonl'),
      `${JSON.stringify(header)}\n${JSON.stringify(receiptlessIntent)}\n`,
      'utf8',
    );

    const result = await runObserveCli(['--json', '--data-dir', dataDir], cwd);
    expect(result.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(JSON.parse(result.stdout)).toMatchObject({
      integrity: {
        status: 'partial',
        corruptLineCount: 1,
        affected: [{ kind: 'session-receipt', path: 'sessions/s1.jsonl', line: 2 }],
      },
    });
  });
});

function runObserveCli(args: string[], commandCwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli/observe-cli.ts'), ...args], {
    cwd: commandCwd,
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
      reject(new Error(`observe CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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
