import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];

// This file intentionally launches several real CLI subprocesses per test. Full-suite worker
// contention can exceed Vitest's 5 s unit-test default even though each child has its own 20 s cap.
vi.setConfig({ testTimeout: 15_000 });
afterAll(() => vi.resetConfig());
const ESC = String.fromCharCode(27);
const KEY_SENTINEL = 'ark-sentinel-key-value-never-print';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis sessions search (read-only product surface)', () => {
  it('discovers sessions search from group and command help without a provider key', async () => {
    const [rootHelp, groupHelp, searchHelp] = await Promise.all([
      runJarvis(['--help']),
      runJarvis(['sessions', '--help']),
      runJarvis(['sessions', 'search', '--help']),
    ]);

    expect(rootHelp.code).toBe(0);
    expect(rootHelp.stdout).toContain('sessions');
    expect(groupHelp).toMatchObject({ code: 0 });
    expect(groupHelp.stdout).toContain('search [options] <query>');
    expect(searchHelp).toMatchObject({ code: 0 });
    expect(searchHelp.stdout).toContain('jarvis sessions search');
    for (const result of [rootHelp, groupHelp, searchHelp]) {
      expect(result.stderr).not.toContain(KEY_SENTINEL);
      expect(result.stderr).not.toContain('ARK_API_KEY');
    }
  }, 20_000);

  it('returns exit 2 for missing, empty, and oversized queries', async () => {
    const workspace = await tempWorkspace('usage ');

    const missing = await runJarvis(['--cwd', workspace, 'sessions', 'search']);
    expect(missing.code).toBe(CLI_EXIT.USAGE);

    const empty = await runJarvis(['--cwd', workspace, 'sessions', 'search', '   ']);
    expect(empty.code).toBe(CLI_EXIT.USAGE);
    expect(empty.stderr).toContain('must not be empty');

    const oversized = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'x'.repeat(201)]);
    expect(oversized.code).toBe(CLI_EXIT.USAGE);
    expect(oversized.stderr).toContain('exceeds');
  });

  it('reports zero matches on an empty workspace with exit 0 and the versioned contract', async () => {
    const workspace = await tempWorkspace('empty ');

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--json']);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('0 match(es)');
    expect(text.stdout).toContain('no matches');
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as {
      schemaVersion: number;
      authority: { mode: string; canCompleteGoals: boolean; canCompleteLoops: boolean };
      query: string;
      matches: unknown[];
      skipped: unknown[];
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.authority).toEqual({ mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false });
    expect(report.query).toBe('needle');
    expect(report.matches).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it('matches v1/v2 message text, metadata, and case-insensitive and UTF-8 queries', async () => {
    const workspace = await tempWorkspace('mixed ');
    await writeSession(workspace, 'v1-search-main', [
      v1Header(workspace, 'v1-search-main'),
      { t: 'message', message: { role: 'user', content: 'please review the checkpoint-NEEDLE plan 中文关键词' } },
      { t: 'message', message: { role: 'assistant', content: 'done' } },
    ]);
    await writeSession(workspace, 'v2-search-main', [
      v2Header(workspace, 'v2-search-main', 1),
      v2Message(2, { role: 'user', content: 'q' }),
      v2Message(3, { role: 'assistant', content: 'a Needle reply' }),
    ]);

    const json = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--json']);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as {
      scannedSessions: number;
      matchedSessions: number;
      matches: Array<{
        sessionId: string;
        field: string;
        turn?: number;
        role?: string;
        recordOrdinal?: number;
        excerpt: string;
      }>;
    };
    expect(report.scannedSessions).toBe(2);
    expect(report.matchedSessions).toBe(2);
    const v1 = report.matches.find((match) => match.sessionId === 'v1-search-main' && match.field === 'message');
    const v2 = report.matches.find((match) => match.sessionId === 'v2-search-main' && match.field === 'message');
    expect(v1).toMatchObject({ field: 'message', turn: 1, role: 'user', recordOrdinal: 2 });
    expect(v1?.excerpt).toContain('checkpoint-NEEDLE');
    expect(v2).toMatchObject({ field: 'message', turn: 1, role: 'assistant' });
    expect(v2?.excerpt).toContain('Needle');

    const byModel = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'doubao-v2-search', '--json']);
    const modelReport = JSON.parse(byModel.stdout) as { matches: Array<{ sessionId: string; field: string; metadataField?: string }> };
    expect(byModel.code).toBe(0);
    expect(modelReport.matches).toEqual([
      expect.objectContaining({ sessionId: 'v2-search-main', field: 'metadata', metadataField: 'model' }),
    ]);

    const byId = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'v1-search', '--json']);
    const idReport = JSON.parse(byId.stdout) as { matches: Array<{ field: string; metadataField?: string }> };
    expect(idReport.matches.some((match) => match.field === 'metadata' && match.metadataField === 'id')).toBe(true);

    const utf8 = await runJarvis(['--cwd', workspace, 'sessions', 'search', '关键词', '--json']);
    const utf8Report = JSON.parse(utf8.stdout) as { matches: Array<{ sessionId: string }> };
    expect(utf8.code).toBe(0);
    expect(utf8Report.matches.map((match) => match.sessionId)).toContain('v1-search-main');
  });

  it('never searches tool outputs, tool arguments, or system text', async () => {
    const workspace = await tempWorkspace('projection ');
    await writeSession(workspace, 'projection-1', [
      v1Header(workspace, 'projection-1'),
      { t: 'message', message: { role: 'system', content: 'systemneedle instructions' } },
      { t: 'message', message: { role: 'user', content: 'q' } },
      { t: 'message', message: { role: 'assistant', toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"argneedle.txt"}' }] } },
      { t: 'message', message: { role: 'tool', toolCallId: 'c1', content: 'outputneedle secret payload' } },
    ]);

    for (const query of ['systemneedle', 'argneedle', 'outputneedle']) {
      const result = await runJarvis(['--cwd', workspace, 'sessions', 'search', query, '--json']);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as { matches: unknown[]; scannedSessions: number };
      expect(report.scannedSessions).toBe(1);
      expect(report.matches).toEqual([]);
      expect(result.stdout).not.toContain('secret payload');
    }
  });

  it('redacts secrets and terminal control characters in excerpts and the query echo', async () => {
    const workspace = await tempWorkspace('redaction ');
    await writeSession(workspace, 'redact-1', [
      v1Header(workspace, 'redact-1'),
      {
        t: 'message',
        message: { role: 'user', content: `needle sk-testsecret12345 and${ESC}[31m\r\nFORGED-LINE end` },
      },
    ]);

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'sk-querysecret123', '--json']);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('sk-***');
    expect(text.stdout).not.toContain('sk-testsecret12345');
    expect(text.stdout).not.toContain(ESC);
    expect(text.stdout).not.toContain('\r');
    expect(text.stdout).not.toContain('\nFORGED-LINE');

    expect(json.code).toBe(0);
    expect(json.stdout.includes(ESC)).toBe(false);
    const report = JSON.parse(json.stdout) as { query: string; matches: Array<{ excerpt: string }> };
    expect(report.query).toBe('sk-***');
    expect(report.matches[0]?.excerpt).toContain('sk-***');
    expect(JSON.stringify(report)).not.toContain('sk-testsecret12345');
  });

  it('skips fail-closed damaged sessions with exit 7 but still searches a crash-truncated tail', async () => {
    const workspace = await tempWorkspace('damage ');
    await writeFile(
      join(workspace, 'data', 'sessions', 'corrupt-middle.jsonl'),
      `${JSON.stringify(v1Header(workspace, 'corrupt-middle'))}\n`
        + '{"t":"message","message":{"role":"user","content":"needle in corrupted session"}}\n'
        + '{"t":"message","message":{"role":"user",\n'
        + '{"t":"message","message":{"role":"assistant","content":"a"}}\n',
      'utf8',
    );
    await writeFile(
      join(workspace, 'data', 'sessions', 'truncated-tail.jsonl'),
      `${JSON.stringify(v1Header(workspace, 'truncated-tail'))}\n`
        + '{"t":"message","message":{"role":"user","content":"needle in truncated session"}}\n'
        + '{"t":"mess',
      'utf8',
    );

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--json']);

    expect(text.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(text.stdout).toContain('truncated-tail');
    expect(text.stdout).toContain('integrity: partial');
    expect(text.stdout).toContain('skipped');
    expect(text.stdout).toContain('corrupt-middle');
    expect(text.stdout).not.toContain('needle in corrupted session');

    expect(json.code).toBe(CLI_EXIT.STATE_CORRUPT);
    const report = JSON.parse(json.stdout) as {
      matches: Array<{ sessionId: string; integrity: string }>;
      skipped: Array<{ sessionId: string; reason: string }>;
    };
    expect(report.matches.map((match) => match.sessionId)).toEqual(['truncated-tail']);
    expect(report.matches[0]?.integrity).toBe('partial');
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.sessionId).toBe('corrupt-middle');
    expect(report.skipped[0]?.reason).toContain('malformed-middle');
  });

  it('rejects a sessions-directory junction escape instead of searching outside content', async () => {
    const workspace = await tempWorkspace('junction source ');
    const outside = await tempWorkspace('junction target ');
    await writeSession(outside, 'escaped-session', [
      v1Header(outside, 'escaped-session'),
      { t: 'message', message: { role: 'user', content: 'needle outside the workspace' } },
    ]);
    await rm(join(workspace, 'data'), { recursive: true, force: true });
    await symlink(join(outside, 'data'), join(workspace, 'data'), 'junction');

    const result = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle']);

    expect(result.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(result.stdout).toContain('unsafe-path');
    expect(result.stdout).not.toContain('escaped-session');
    expect(result.stdout).not.toContain('outside the workspace');
  });

  it('skips a non-file .jsonl directory entry with exit 7', async () => {
    const workspace = await tempWorkspace('non-file ');
    await mkdir(join(workspace, 'data', 'sessions', 'directory-entry.jsonl'));
    await writeSession(workspace, 'clean-1', [
      v1Header(workspace, 'clean-1'),
      { t: 'message', message: { role: 'user', content: 'needle here' } },
    ]);

    const json = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--json']);

    expect(json.code).toBe(CLI_EXIT.STATE_CORRUPT);
    const report = JSON.parse(json.stdout) as {
      matches: Array<{ sessionId: string }>;
      skipped: Array<{ sessionId: string; reason: string }>;
    };
    expect(report.matches.map((match) => match.sessionId)).toEqual(['clean-1']);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.sessionId).toBe('directory-entry');
  });

  it('enforces per-session and global match caps with declared truncation', async () => {
    const workspace = await tempWorkspace('caps ');
    const messages = Array.from({ length: 25 }, (_, index) => ({
      t: 'message',
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `needle hit ${index}` },
    }));
    for (let session = 0; session < 6; session += 1) {
      await writeSession(workspace, `cap-${session}`, [v1Header(workspace, `cap-${session}`), ...messages]);
    }

    const json = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--json']);

    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as {
      matches: Array<{ sessionId: string }>;
      truncated: boolean;
      truncatedSessions: string[];
    };
    expect(report.matches).toHaveLength(100);
    const perSession = new Map<string, number>();
    for (const match of report.matches) perSession.set(match.sessionId, (perSession.get(match.sessionId) ?? 0) + 1);
    for (const count of perSession.values()) expect(count).toBe(20);
    expect(report.truncated).toBe(true);
    expect(report.truncatedSessions).toHaveLength(6);

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle']);
    expect(text.stdout).toContain('truncated:');
  });

  it('never loads a provider or echoes the credential value', async () => {
    const source = await readFile(join(repo, 'src', 'surfaces', 'cli', 'sessions-search.ts'), 'utf8');
    expect(source).not.toMatch(/createProvider|loadDoubaoConfig|loadEnvFile|ARK_API_KEY/u);

    const workspace = await tempWorkspace('nokey ');
    await writeSession(workspace, 'key-1', [
      v1Header(workspace, 'key-1'),
      { t: 'message', message: { role: 'user', content: 'needle' } },
    ]);

    const result = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle'], KEY_SENTINEL);

    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).not.toContain(KEY_SENTINEL);
    expect(result.stderr).not.toContain(KEY_SENTINEL);
  });
});

async function tempWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `jarvis sessions search e2e ${prefix}`));
  tempDirs.push(workspace);
  await mkdir(join(workspace, 'data', 'sessions'), { recursive: true });
  return workspace;
}

function v1Header(workspace: string, id: string): Record<string, unknown> {
  return { t: 'session', id, model: 'doubao-legacy', cwd: workspace, startedAt: '2026-08-01T00:00:00.000Z' };
}

function v2Header(workspace: string, id: string, seq: number): Record<string, unknown> {
  return {
    schemaVersion: 2,
    seq,
    at: 't1',
    t: 'session',
    id,
    model: 'doubao-v2-search',
    cwd: workspace,
    startedAt: 't0',
    composition: {
      root: 'repl',
      runtimeVersion: 'test-runtime',
      permissionMode: 'interactive',
      coverage: 'full',
      toolsetHash: 'sha256.tools',
      systemPromptHash: 'sha256.prompt',
      dynamicAddendumSource: 'none-v1',
      dynamicAddendumManifestHash: 'sha256.dynamic-none',
    },
  };
}

function v2Message(seq: number, message: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: 2, seq, at: `t${seq}`, t: 'message', message };
}

function writeSession(workspace: string, id: string, records: unknown[]): Promise<void> {
  return writeFile(
    join(workspace, 'data', 'sessions', `${id}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

function runJarvis(
  args: string[],
  apiKey: string | null = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: 'sessions-search-test-model' };
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
