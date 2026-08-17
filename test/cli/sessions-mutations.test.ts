import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];

// This file intentionally launches several real CLI subprocesses per test. Full-suite worker
// contention can exceed Vitest's 5 s unit-test default even though each child has its own 20 s cap.
vi.setConfig({ testTimeout: 15_000 });
afterAll(() => vi.resetConfig());
const KEY_SENTINEL = 'ark-sentinel-key-value-never-print';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis sessions mutations (fork/rename/archive/unarchive)', () => {
  it('discovers the mutation commands from group help without a provider key', async () => {
    const groupHelp = await runJarvis(['sessions', '--help']);

    expect(groupHelp).toMatchObject({ code: 0 });
    for (const command of ['fork', 'rename', 'archive', 'unarchive']) {
      expect(groupHelp.stdout).toContain(command);
      const help = await runJarvis(['sessions', command, '--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('jarvis sessions');
      expect(help.stderr).not.toContain(KEY_SENTINEL);
      expect(help.stderr).not.toContain('ARK_API_KEY');
    }
  }, 20_000);

  it('forks a v2 session end to end: new id resolvable, lineage shown, mutation JSON contract', async () => {
    const workspace = await tempWorkspace('fork ');
    await writeCleanV2(workspace, 'v2-source');

    const fork = await runJarvis(['--cwd', workspace, 'sessions', 'fork', 'v2-source', '--new-id', 'v2-copy', '--json']);

    expect(fork.code).toBe(0);
    const report = JSON.parse(fork.stdout) as {
      schemaVersion: number;
      authority: { mode: string; canCompleteGoals: boolean; canCompleteLoops: boolean };
      kind: string;
      result: { status: string; forkSessionId: string; recordCount: number; format: string };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.authority).toEqual({ mode: 'mutation', canCompleteGoals: false, canCompleteLoops: false });
    expect(report.kind).toBe('fork');
    expect(report.result).toMatchObject({ status: 'created', forkSessionId: 'v2-copy', recordCount: 3, format: 'v2' });
    expect(fork.stdout.includes(String.fromCharCode(27))).toBe(false);

    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'v2-copy']);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('forkedFrom: v2-source');
    expect(show.stdout).toContain('ready-for-resume-check');

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    expect(list.stdout).toContain('v2-copy');
    expect(list.stdout).toContain('v2-source');
  });

  it('renames: new id active, original archived and inspectable, audit trail complete', async () => {
    const workspace = await tempWorkspace('rename ');
    await writeCleanV2(workspace, 'before-name');
    await mkdir(join(workspace, 'data', 'checkpoints'), { recursive: true });
    await writeFile(join(workspace, 'data', 'checkpoints', 'before-name.jsonl'), '{"audit":true}\n', 'utf8');

    const rename = await runJarvis(['--cwd', workspace, 'sessions', 'rename', 'before-name', 'after-name']);

    expect(rename.code).toBe(0);
    expect(rename.stdout).toContain('renamed: before-name -> after-name');

    const active = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    expect(active.stdout).toContain('after-name');
    expect(active.stdout).not.toContain('before-name');

    const archivedList = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--archived']);
    expect(archivedList.code).toBe(0);
    expect(archivedList.stdout).toContain('before-name');
    expect(archivedList.stdout).toContain('[archived]');
    expect(archivedList.stdout).not.toContain('after-name');

    const showOld = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'before-name']);
    expect(showOld.code).toBe(0);
    expect(showOld.stdout).toContain('archived: yes');

    const resumeOld = await runJarvis(['--cwd', workspace, 'resume', 'before-name'], null);
    expect(resumeOld.code).toBe(CLI_EXIT.USAGE);

    const checkpointAudit = await readFile(join(workspace, 'data', 'checkpoints', 'archived', 'before-name.jsonl'), 'utf8');
    expect(checkpointAudit).toBe('{"audit":true}\n');

    const mutations = (await readFile(join(workspace, 'data', 'session-mutations.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { kind: string; outcome: string; seq: number });
    expect(mutations.map((record) => `${record.kind}:${record.outcome}`)).toEqual([
      'fork:planned',
      'fork:created',
      'archive:planned',
      'archive:created',
      'rename:created',
    ]);
    expect(mutations.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('archives a pending session with a warning and rejects repeated or inverted moves with exit 2', async () => {
    const workspace = await tempWorkspace('pending ');
    await writeFile(
      join(workspace, 'data', 'sessions', 'pending-1.jsonl'),
      '{"t":"session","id":"pending-1","model":"m","cwd":"c","startedAt":"t0"}\n'
        + '{"t":"message","message":{"role":"user","content":"q"}}\n'
        + '{"t":"message","message":{"role":"assistant","toolCalls":[{"id":"c1","name":"write","arguments":"{}"}]}}\n',
      'utf8',
    );

    const archive = await runJarvis(['--cwd', workspace, 'sessions', 'archive', 'pending-1']);
    expect(archive.code).toBe(0);
    expect(archive.stdout).toContain('Sessions archive: moved');
    expect(archive.stdout).toContain('warning: 1 pending tool effect(s)');

    const again = await runJarvis(['--cwd', workspace, 'sessions', 'archive', 'pending-1']);
    expect(again.code).toBe(CLI_EXIT.USAGE);
    expect(again.stdout).toContain('already archived');

    const unarchive = await runJarvis(['--cwd', workspace, 'sessions', 'unarchive', 'pending-1']);
    expect(unarchive.code).toBe(0);
    const activeAgain = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    expect(activeAgain.stdout).toContain('pending-1');

    const missing = await runJarvis(['--cwd', workspace, 'sessions', 'archive', 'missing-id']);
    expect(missing.code).toBe(CLI_EXIT.USAGE);
  });

  it('refuses rename and fork with exit 3 when the source has pending tool effects', async () => {
    const workspace = await tempWorkspace('refuse ');
    await writeFile(
      join(workspace, 'data', 'sessions', 'pending-1.jsonl'),
      '{"t":"session","id":"pending-1","model":"m","cwd":"c","startedAt":"t0"}\n'
        + '{"t":"message","message":{"role":"user","content":"q"}}\n'
        + '{"t":"message","message":{"role":"assistant","toolCalls":[{"id":"c1","name":"write","arguments":"{}"}]}}\n',
      'utf8',
    );

    const fork = await runJarvis(['--cwd', workspace, 'sessions', 'fork', 'pending-1', '--new-id', 'copy-1']);
    expect(fork.code).toBe(CLI_EXIT.NEEDS_HUMAN);
    expect(fork.stdout).toContain('refused');
    expect(fork.stdout).toContain('pending tool effect');

    const rename = await runJarvis(['--cwd', workspace, 'sessions', 'rename', 'pending-1', 'copy-2']);
    expect(rename.code).toBe(CLI_EXIT.NEEDS_HUMAN);

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    expect(list.stdout).toContain('pending-1');
    expect(list.stdout).not.toContain('copy-');
  });

  it('rejects unsafe ids and an archived-directory junction escape before any write', async () => {
    const workspace = await tempWorkspace('safety ');
    const outside = await tempWorkspace('safety target ');
    await writeCleanV2(workspace, 'safe-1');
    await writeCleanV2(outside, 'escaped');

    for (const evil of ['../evil', 'a/b', 'CON']) {
      const fork = await runJarvis(['--cwd', workspace, 'sessions', 'fork', 'safe-1', '--new-id', evil]);
      expect(fork.code).toBe(CLI_EXIT.USAGE);
      const archive = await runJarvis(['--cwd', workspace, 'sessions', 'archive', evil]);
      expect(archive.code).toBe(CLI_EXIT.USAGE);
    }

    await rm(join(workspace, 'data', 'sessions'), { recursive: true, force: true });
    await mkdir(join(workspace, 'data', 'sessions'), { recursive: true });
    await symlink(join(outside, 'data', 'sessions'), join(workspace, 'data', 'sessions', 'archived'), 'junction');
    await writeCleanV2(workspace, 'safe-1');

    const archive = await runJarvis(['--cwd', workspace, 'sessions', 'archive', 'safe-1']);
    expect(archive.code).toBe(CLI_EXIT.STATE_CORRUPT);
    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    expect(list.stdout).toContain('safe-1');
    expect(list.stdout).not.toContain('escaped');
  });

  it('never loads a provider or echoes the credential value', async () => {
    const source = await readFile(join(repo, 'src', 'runtime', 'session', 'mutations.ts'), 'utf8');
    expect(source).not.toMatch(/createProvider|loadDoubaoConfig|loadEnvFile|ARK_API_KEY/u);
    const cliSource = await readFile(join(repo, 'src', 'surfaces', 'cli', 'sessions-mutations.ts'), 'utf8');
    expect(cliSource).not.toMatch(/createProvider|loadDoubaoConfig|loadEnvFile|ARK_API_KEY/u);

    const workspace = await tempWorkspace('nokey ');
    await writeCleanV2(workspace, 'key-1');

    const fork = await runJarvis(['--cwd', workspace, 'sessions', 'fork', 'key-1', '--new-id', 'key-2'], KEY_SENTINEL);
    expect(fork).toMatchObject({ code: 0 });
    expect(fork.stdout).not.toContain(KEY_SENTINEL);
    expect(fork.stderr).not.toContain(KEY_SENTINEL);
  });
});

async function tempWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `jarvis sessions mutation e2e ${prefix}`));
  tempDirs.push(workspace);
  await mkdir(join(workspace, 'data', 'sessions'), { recursive: true });
  return workspace;
}

function writeCleanV2(workspace: string, id: string): Promise<void> {
  const composition = {
    root: 'repl',
    runtimeVersion: 'test-runtime',
    permissionMode: 'interactive',
    coverage: 'full',
    toolsetHash: 'sha256.tools',
    systemPromptHash: 'sha256.prompt',
    dynamicAddendumSource: 'none-v1',
    dynamicAddendumManifestHash: 'sha256.dynamic-none',
  };
  const header = { schemaVersion: 2, seq: 1, at: 't1', t: 'session', id, model: 'doubao-v2', cwd: workspace, startedAt: 't0', composition };
  const userMessage = { schemaVersion: 2, seq: 2, at: 't2', t: 'message', message: { role: 'user', content: 'q' } };
  const assistantMessage = { schemaVersion: 2, seq: 3, at: 't3', t: 'message', message: { role: 'assistant', content: 'a' } };
  return writeFile(
    join(workspace, 'data', 'sessions', `${id}.jsonl`),
    [header, userMessage, assistantMessage].map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
}

function runJarvis(
  args: string[],
  apiKey: string | null = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: 'sessions-mutation-test-model' };
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
