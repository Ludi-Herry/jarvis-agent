import { execFile } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { spawnBudget } from './spawn-budget.js';
import {
  FileCheckpointAuditStore,
  SessionCheckpointRecorder,
} from '../../src/runtime/checkpoint/index.js';
import {
  FileSessionStore,
  NO_DYNAMIC_ADDENDUM,
  createSessionComposition,
  loadSessionLog,
} from '../../src/runtime/session/index.js';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';
import { checkpointCommandErrorExitCode } from '../../src/surfaces/cli/checkpoints.js';
import type { Message } from '../../src/core/types.js';
import { ShadowGit } from '../../src/capabilities/index.js';
import { defaultShellPath } from '../../src/core/index.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];
const ESC = String.fromCharCode(27);

// This file launches several real CLI subprocesses per test. Full-suite worker
// contention can exceed Vitest's 5 s default while every child keeps its 20 s cap.
vi.setConfig({ testTimeout: spawnBudget(15_000) });
afterAll(() => vi.resetConfig());

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis checkpoint surfaces', () => {
  it('exposes read-only list/show and the explicit rewind command in root help', async () => {
    const root = await runJarvis(['--help']);
    const group = await runJarvis(['checkpoints', '--help']);
    const rewind = await runJarvis(['rewind', '--help']);

    expect(root.code).toBe(0);
    expect(root.stdout).toContain('checkpoints');
    expect(root.stdout).toContain('rewind');
    expect(group.stdout).toContain('list');
    expect(group.stdout).toContain('show');
    expect(rewind.stdout).toContain('--files');
  });

  it('lists and shows checkpoint audit state without granting completion authority', async () => {
    const fixture = await createFixture();
    const text = await runJarvis(['--cwd', fixture.cwd, 'checkpoints', 'list', fixture.sessionId]);
    const json = await runJarvis(['--cwd', fixture.cwd, 'checkpoints', 'show', fixture.sessionId, fixture.checkpointId, '--json']);

    expect(text.code).toBe(CLI_EXIT.SUCCESS);
    expect(text.stdout).toContain(fixture.checkpointId);
    expect(text.stdout).toContain('observation-only');
    expect(text.stdout).not.toContain(ESC);
    const report = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(json.code).toBe(CLI_EXIT.SUCCESS);
    expect(report).toMatchObject({
      schemaVersion: 1,
      authority: { mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false },
      sessionId: fixture.sessionId,
      checkpoint: { checkpointId: fixture.checkpointId, phase: 'manual' },
    });
  });

  it('sanitizes hostile human fields while JSON remains normally escaped', async () => {
    const cwd = await tempWorkspace('checkpoint controls ');
    const sessionId = 'session-controls';
    const auditDir = join(cwd, 'data', 'checkpoints');
    await mkdir(auditDir, { recursive: true });
    const record = {
      schemaVersion: 1,
      seq: 1,
      at: `now${ESC}[31m`,
      t: 'checkpoint',
      checkpointId: 'cp-controls',
      sessionId,
      cwd: `cwd${ESC}[2J\r\nforged`,
      phase: 'manual',
      cursor: { sessionSeq: 1, recordCount: 1, messageCount: 0 },
      shadow: { status: 'unavailable', reason: `reason${ESC}[32m\r\nforged` },
      effects: {
        managedFileWrites: 0,
        external: 'unknown',
        canRewindConversation: false,
        canRewindFiles: false,
      },
    };
    await writeFile(join(auditDir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');

    const text = await runJarvis(['--cwd', cwd, 'checkpoints', 'show', sessionId, 'cp-controls']);
    const json = await runJarvis(['--cwd', cwd, 'checkpoints', 'show', sessionId, 'cp-controls', '--json']);

    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain(ESC);
    expect(text.stdout).not.toMatch(/\nforged/u);
    expect(json.code).toBe(0);
    expect(json.stdout).not.toContain(`${ESC}[2J`);
    expect(JSON.parse(json.stdout)).toMatchObject({ checkpoint: { cwd: expect.stringContaining('\nforged') } });
  });

  it('creates a new v2 conversation fork and leaves the source bytes unchanged', async () => {
    const fixture = await createFixture();
    const sourceBefore = await readFile(fixture.sessionPath, 'utf8');
    const result = await runJarvis(['--cwd', fixture.cwd, 'rewind', fixture.sessionId, fixture.checkpointId]);

    expect(result.code).toBe(CLI_EXIT.SUCCESS);
    const forkId = /jarvis resume ([A-Za-z0-9._-]+)/u.exec(result.stdout)?.[1];
    expect(forkId).toBeTruthy();
    expect(await readFile(fixture.sessionPath, 'utf8')).toBe(sourceBefore);
    const fork = await loadSessionLog(join(fixture.cwd, 'data', 'sessions', `${forkId}.jsonl`), {
      requireHeader: true,
      validateIntegrity: true,
      expectedSessionId: forkId,
    });
    expect(fork.loaded.messages).toEqual(fixture.checkpointMessages);
    expect(fork.loaded.requests).toEqual([]);
    expect(fork.loaded.toolReceipts).toEqual([]);
  });

  it('restores the exact previewed files only after allow-once and then exposes the fork', async () => {
    const fixture = await createFixture({ files: true });
    const result = await runJarvis(
      ['--cwd', fixture.cwd, 'rewind', fixture.sessionId, fixture.checkpointId, '--files'],
      {},
      'allow-once\n',
    );

    expect(result.code).toBe(CLI_EXIT.SUCCESS);
    expect(result.stdout).toContain('File rewind preview');
    expect(result.stdout).toContain('files restored');
    expect(await readFile(join(fixture.cwd, 'tracked.txt'), 'utf8')).toBe('checkpoint');
    await expect(readFile(join(fixture.cwd, 'later.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const forkId = /jarvis resume ([A-Za-z0-9._-]+)/u.exec(result.stdout)?.[1];
    expect(forkId).toBeTruthy();
    const audit = (await readFile(
      join(fixture.cwd, 'data', 'checkpoints', `${fixture.sessionId}.jsonl`),
      'utf8',
    )).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.slice(-2)).toEqual([
      expect.objectContaining({ t: 'rewind', mode: 'conversation-and-files', outcome: 'planned' }),
      expect.objectContaining({ t: 'rewind', mode: 'conversation-and-files', outcome: 'created' }),
    ]);
  }, spawnBudget(20_000));

  it('restores a project-ignored file through the real rewind --files path instead of reporting a false success', async () => {
    const fixture = await createFixture({ files: true, projectIgnored: 'ignored.log' });
    const result = await runJarvis(
      ['--cwd', fixture.cwd, 'rewind', fixture.sessionId, fixture.checkpointId, '--files'],
      {},
      'allow-once\n',
    );

    expect(result.code).toBe(CLI_EXIT.SUCCESS);
    expect(result.stdout).toContain('files restored');
    expect(await readFile(join(fixture.cwd, 'ignored.log'), 'utf8')).toBe('checkpoint');
  }, spawnBudget(20_000));

  it('keeps files and Session count unchanged when file rewind is not approved', async () => {
    const fixture = await createFixture({ files: true });
    const sessionsBefore = await readdir(join(fixture.cwd, 'data', 'sessions'));
    const result = await runJarvis(
      ['--cwd', fixture.cwd, 'rewind', fixture.sessionId, fixture.checkpointId, '--files'],
      {},
      'deny\n',
    );

    expect(result.code).toBe(CLI_EXIT.NEEDS_HUMAN);
    expect(await readFile(join(fixture.cwd, 'tracked.txt'), 'utf8')).toBe('later');
    expect(await readFile(join(fixture.cwd, 'later.txt'), 'utf8')).toBe('new');
    expect(await readdir(join(fixture.cwd, 'data', 'sessions'))).toEqual(sessionsBefore);
  }, spawnBudget(20_000));

  it('classifies explicit absence as exit 2 and corrupt checkpoint state as exit 7', async () => {
    const cwd = await tempWorkspace('checkpoint errors ');
    const missing = await runJarvis(['--cwd', cwd, 'checkpoints', 'show', 'missing', 'cp-missing']);
    await mkdir(join(cwd, 'data', 'checkpoints'), { recursive: true });
    await writeFile(join(cwd, 'data', 'checkpoints', 'corrupt.jsonl'), '{"bad":true}\n', 'utf8');
    const corrupt = await runJarvis(['--cwd', cwd, 'checkpoints', 'list', 'corrupt']);
    const partialRecord = {
      schemaVersion: 1,
      seq: 1,
      at: '2026-08-15T12:00:00.000Z',
      t: 'checkpoint',
      checkpointId: 'cp-recorded',
      sessionId: 'partial',
      cwd,
      phase: 'manual',
      cursor: { sessionSeq: 1, recordCount: 1, messageCount: 0 },
      shadow: { status: 'unavailable', reason: 'disabled' },
      effects: {
        managedFileWrites: 0,
        external: 'none-observed',
        canRewindConversation: true,
        canRewindFiles: false,
      },
    };
    await writeFile(
      join(cwd, 'data', 'checkpoints', 'partial.jsonl'),
      `${JSON.stringify(partialRecord)}\n{"schemaVersion":1`,
      'utf8',
    );
    const partialMissing = await runJarvis([
      '--cwd', cwd, 'checkpoints', 'show', 'partial', 'cp-missing',
    ]);
    const ioFailure = Object.assign(new Error('device not found'), { code: 'EIO' });

    expect(missing.code).toBe(CLI_EXIT.USAGE);
    expect(corrupt.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(partialMissing.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(checkpointCommandErrorExitCode(ioFailure)).toBe(CLI_EXIT.STATE_CORRUPT);
  });

  it('rejects unsafe and Windows-device ids as usage errors on every checkpoint command', async () => {
    const cwd = await tempWorkspace('checkpoint ids ');
    for (const id of ['CON', 'nul.txt', '../escape', 'C:/absolute']) {
      const list = await runJarvis(['--cwd', cwd, 'checkpoints', 'list', id]);
      const show = await runJarvis(['--cwd', cwd, 'checkpoints', 'show', id, 'cp-safe']);
      const rewind = await runJarvis(['--cwd', cwd, 'rewind', id, 'cp-safe']);
      expect([list.code, show.code, rewind.code]).toEqual([
        CLI_EXIT.USAGE,
        CLI_EXIT.USAGE,
        CLI_EXIT.USAGE,
      ]);
    }
  }, spawnBudget(20_000));

  it('records both automatic boundaries through the real root headless run path', async () => {
    const cwd = await tempWorkspace('checkpoint root run ');
    await writeFile(join(cwd, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    const endpoint = createServer((_request, response) => writeTextSse(response, 'done'));
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--headless', '--cwd', cwd, 'run', 'capture both boundaries'],
        {
          ARK_API_KEY: undefined,
          ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          HOME: cwd,
          USERPROFILE: cwd,
        },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => {
        if (err) rejectClose(err);
        else resolveClose();
      }));
    }

    expect(result.code).toBe(CLI_EXIT.SUCCESS);
    const auditFiles = await readdir(join(cwd, 'data', 'checkpoints'));
    expect(auditFiles).toHaveLength(1);
    const records = (await readFile(join(cwd, 'data', 'checkpoints', auditFiles[0]), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.phase)).toEqual(['before-user-prompt', 'before-model-wave']);
  }, spawnBudget(20_000));
});

async function createFixture(options: { files?: boolean; projectIgnored?: string } = {}) {
  const cwd = await tempWorkspace('checkpoint cli ');
  const sessionId = 'session-source';
  const sessionPath = join(cwd, 'data', 'sessions', `${sessionId}.jsonl`);
  const store = new FileSessionStore(sessionPath);
  if (options.files) await writeFile(join(cwd, 'tracked.txt'), 'checkpoint', 'utf8');
  if (options.projectIgnored !== undefined) {
    await writeFile(join(cwd, '.gitignore'), `${options.projectIgnored}\n`, 'utf8');
    await writeFile(join(cwd, options.projectIgnored), 'checkpoint', 'utf8');
  }
  const checkpointMessages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'checkpoint prompt' },
  ];
  await store.writeHeader({
    id: sessionId,
    model: 'fixture-model',
    cwd,
    startedAt: '2026-08-15T12:00:00.000Z',
    composition: createSessionComposition({
      root: 'repl',
      runtimeVersion: '0.1.0',
      permissionMode: 'interactive',
      toolSchemas: [],
      systemPrompt: 'system',
      dynamicAddendum: NO_DYNAMIC_ADDENDUM,
    }),
  });
  await store.sync(checkpointMessages);
  const recorder = new SessionCheckpointRecorder({
    cwd,
    sessionId,
    sessionPath,
    auditStore: new FileCheckpointAuditStore({ cwd, sessionId, createId: () => 'cp-target' }),
    ...(options.files
      ? {
          shadow: new ShadowGit({
            shellPath: defaultShellPath(),
            cwd,
            gitDir: join(cwd, 'data', 'checkpoint-shadow', sessionId),
          }),
        }
      : {}),
  });
  const checkpoint = await recorder.capture('manual', checkpointMessages);
  if (options.files) {
    await writeFile(join(cwd, 'tracked.txt'), 'later', 'utf8');
    await writeFile(join(cwd, 'later.txt'), 'new', 'utf8');
  }
  if (options.projectIgnored !== undefined) {
    await writeFile(join(cwd, options.projectIgnored), 'later', 'utf8');
  }
  await store.sync([...checkpointMessages, { role: 'assistant', content: 'later' }]);
  return { cwd, sessionId, sessionPath, checkpointId: checkpoint.checkpointId, checkpointMessages };
}

async function tempWorkspace(label: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `jarvis ${label}`));
  tempDirs.push(cwd);
  return cwd;
}

function runJarvis(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  stdin = '',
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
      { cwd: repo, env, encoding: 'utf8', timeout: spawnBudget(20_000), windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        done({ code: typeof rawCode === 'number' ? rawCode : null, stdout, stderr });
      },
    );
    child.stdin?.end(stdin);
  });
}

function writeTextSse(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    id: 'fixture-response',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: 'fixture-response',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}
