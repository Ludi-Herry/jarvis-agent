import { execFile } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runA0Evaluation, type A0VerifierCall } from '../../src/capabilities/eval/a0-runner.js';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';
import type { Message } from '../../src/core/types.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];

// This file launches several real CLI subprocesses per test; keep the per-file
// budget above Vitest's 5 s default while each child keeps its own 20 s cap.
vi.setConfig({ testTimeout: 15_000 });
afterAll(() => vi.resetConfig());

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis a0 cli '));
  tempDirs.push(cwd);
  await cp(join(repo, 'eval/a0'), join(cwd, 'eval', 'a0'), { recursive: true });
  return cwd;
}

/** A perfect verifier over the fixture corpus (harness-side expected labels). */
const perfectVerifier: A0VerifierCall = async (messages: Message[]) => {
  const cases = (await readFile(join(repo, 'eval/a0/eval-cases.jsonl'), 'utf8'))
    .split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { caseId: string; expectedLeg3: string });
  const user = messages.find((message) => message.role === 'user');
  const caseId = user === undefined ? '' : /"caseId":"([^"]+)"/u.exec(user.content)?.[1] ?? '';
  const expected = cases.find((item) => item.caseId === caseId)?.expectedLeg3 ?? 'cannotVerify';
  return { text: `{"leg3":"${expected}","reason":"fake"}`, inputTokens: 10, outputTokens: 5 };
};

describe('jarvis a0 surfaces', () => {
  it('exposes the command group in root help with run and report', async () => {
    const root = await runJarvis(['--help']);
    const group = await runJarvis(['a0', '--help']);
    expect(root.code).toBe(0);
    expect(root.stdout).toContain('a0');
    expect(group.stdout).toContain('run');
    expect(group.stdout).toContain('report');
    expect(group.stdout).toContain('observation-only');
  });

  it('reports a finished run with verified provenance and no completion authority', async () => {
    const cwd = await fixtureWorkspace();
    const run = await runA0Evaluation({
      cwd,
      corpusPath: 'eval/a0/eval-cases.jsonl',
      promptPath: 'eval/a0/prompts/a0-leg3-v2.md',
      model: 'fake-verifier-model',
      call: perfectVerifier,
      outputDir: join(cwd, 'data', 'a0', 'run'),
    });

    const text = await runJarvis(['--cwd', cwd, 'a0', 'report', '--observations', run.observationsPath]);
    const json = await runJarvis(['--cwd', cwd, 'a0', 'report', '--observations', run.observationsPath, '--json']);

    expect(text.code).toBe(CLI_EXIT.SUCCESS);
    expect(text.stdout).toContain('verdict: GO');
    expect(text.stdout).toContain('observation-only');
    expect(text.stdout).toContain('completion authority: none');
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(json.code).toBe(CLI_EXIT.SUCCESS);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      authority: { mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false },
      provenanceIssues: [],
    });
  }, 20_000);

  it('classifies missing observations as exit 2 and tampered artifacts as exit 7', async () => {
    const cwd = await fixtureWorkspace();
    const run = await runA0Evaluation({
      cwd,
      corpusPath: 'eval/a0/eval-cases.jsonl',
      promptPath: 'eval/a0/prompts/a0-leg3-v2.md',
      model: 'fake-verifier-model',
      call: perfectVerifier,
      outputDir: join(cwd, 'data', 'a0', 'run'),
    });
    const missing = await runJarvis(['--cwd', cwd, 'a0', 'report', '--observations', 'data/a0/does-not-exist.jsonl']);
    await writeFile(run.observationsPath, (await readFile(run.observationsPath, 'utf8')).replace('"totalTokens":15', '"totalTokens":16'), 'utf8');
    const tampered = await runJarvis(['--cwd', cwd, 'a0', 'report', '--observations', run.observationsPath]);

    expect(missing.code).toBe(CLI_EXIT.USAGE);
    expect(tampered.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(tampered.stdout).toContain('do not match the run manifest');
  }, 20_000);

  it('classifies semantic artifact corruption (unknown case, duplicate observation) as exit 7', async () => {
    const cwd = await fixtureWorkspace();
    await mkdir(join(cwd, 'data', 'a0'), { recursive: true });
    const unknownCase = join(cwd, 'data', 'a0', 'unknown.jsonl');
    await writeFile(unknownCase, `${JSON.stringify({
      schemaVersion: 1, caseId: 'case-does-not-exist', attempt: 1, actualLeg3: 'proves',
      totalTokens: 1, latencyMs: 1, requestReconstructable: true,
      orphanSideEffects: 0, receiptlessAttempts: 0, staleRecallActions: 0,
    })}\n`, 'utf8');
    const run = await runA0Evaluation({
      cwd,
      corpusPath: 'eval/a0/eval-cases.jsonl',
      promptPath: 'eval/a0/prompts/a0-leg3-v2.md',
      model: 'fake-verifier-model',
      call: perfectVerifier,
      outputDir: join(cwd, 'data', 'a0', 'run'),
    });
    const duplicated = join(cwd, 'data', 'a0', 'duplicate.jsonl');
    const firstLine = (await readFile(run.observationsPath, 'utf8')).split('\n')[0] ?? '';
    await writeFile(duplicated, `${firstLine}\n${firstLine}\n`, 'utf8');

    const unknown = await runJarvis(['--cwd', cwd, 'a0', 'report', '--observations', unknownCase]);
    const duplicate = await runJarvis(['--cwd', cwd, 'a0', 'report', '--observations', duplicated]);

    expect(unknown.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(unknown.stderr).toContain('unknown case');
    expect(duplicate.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(duplicate.stderr).toContain('duplicate observation');
  }, 20_000);

  it('refuses a real run without a provider key', async () => {
    const cwd = await fixtureWorkspace();
    const result = await runJarvis(['--cwd', cwd, 'a0', 'run'], { ARK_API_KEY: undefined });
    expect(result.code).toBe(CLI_EXIT.USAGE);
    expect(result.stderr).toContain('ARK_API_KEY');
  });

  it('runs the corpus end-to-end through a fixture provider and writes immutable artifacts', async () => {
    const cwd = await fixtureWorkspace();
    await writeFile(join(cwd, '.env'), 'ARK_API_KEY=fixture-key\n', 'utf8');
    const endpoint = createServer((_request, response) => writeVerifierSse(response));
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--cwd', cwd, 'a0', 'run'],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => {
        if (err) rejectClose(err);
        else resolveClose();
      }));
    }

    // The fixture verifier always answers "proves": every tampered case becomes
    // a known-bad miss, so a healthy NO-GO (exit 3) proves the gate is wired.
    expect(result.code).toBe(CLI_EXIT.NEEDS_HUMAN);
    expect(result.stdout).toContain('verdict: NO-GO');
    expect(result.stdout).toContain('completion authority: none');
    const observations = await readFile(join(cwd, 'data', 'a0', 'run', 'observations.jsonl'), 'utf8');
    expect(observations.trim().split('\n')).toHaveLength(18);
    const manifest = JSON.parse(await readFile(join(cwd, 'data', 'a0', 'run', 'observations.manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ schemaVersion: 1, kind: 'a0-run-manifest' });
  }, 20_000);
});

async function runJarvis(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_API_KEY: '', ...envOverrides };
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
    }
    delete env.JARVIS_HOOKS;
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      { cwd: repo, env, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        done({ code: typeof rawCode === 'number' ? rawCode : null, stdout, stderr });
      },
    );
    child.stdin?.end('');
  });
}

function writeVerifierSse(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    id: 'a0-fixture-response',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: '{"leg3":"proves","reason":"fixture"}' }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: 'a0-fixture-response',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}
