import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis sessions list selection (filter/sort/page)', () => {
  it('rejects invalid selection flag values with exit 2', async () => {
    const workspace = await tempWorkspace('invalid ');
    const cases: string[][] = [
      ['--format', 'bogus'],
      ['--integrity', 'bogus'],
      ['--resume', 'nope'],
      ['--sort', 'size'],
      ['--order', 'sideways'],
      ['--page', '0'],
      ['--page', 'x'],
      ['--page-size', '201'],
      ['--page-size', '1.5'],
    ];
    for (const flags of cases) {
      const result = await runJarvis(['--cwd', workspace, 'sessions', 'list', ...flags]);
      expect(result.code, flags.join(' ')).toBe(CLI_EXIT.USAGE);
      expect(result.stderr).toContain(flags[0]);
    }
  }, 20_000);

  it('keeps the default report free of any selection echo for backward compatibility', async () => {
    const workspace = await tempWorkspace('default ');
    await writeSession(workspace, 'plain-1', [v1Header(workspace, 'plain-1'), userMessage('q')]);

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--json']);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('Sessions (read-only): 1');
    expect(text.stdout).not.toContain('selection:');
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as Record<string, unknown>;
    expect('selection' in report).toBe(false);
  });

  it('filters by format, integrity, and resume verdict with an accurate echo', async () => {
    const workspace = await tempWorkspace('filters ');
    await writeSession(workspace, 'filter-v1', [v1Header(workspace, 'filter-v1'), userMessage('q')]);
    await writeSession(workspace, 'filter-v2', [v2Header(workspace, 'filter-v2'), v2Message(2, { role: 'user', content: 'q' })]);
    await writeSession(workspace, 'filter-tail', [
      v1Header(workspace, 'filter-tail'),
      userMessage('q'),
    ], '{"t":"mess');

    const byFormat = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--format', 'v2', '--json']);
    expect(byFormat.code).toBe(0);
    const formatReport = JSON.parse(byFormat.stdout) as {
      sessions: Array<{ id: string }>;
      selection: {
        filters: { format?: string };
        total: number;
        filtered: number;
        returned: number;
        sort: string;
        order: string;
      };
    };
    expect(formatReport.sessions.map((session) => session.id)).toEqual(['filter-v2']);
    expect(formatReport.selection).toMatchObject({
      filters: { format: 'v2' },
      total: 3,
      filtered: 1,
      returned: 1,
      sort: 'modified',
      order: 'desc',
    });

    const byIntegrity = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--integrity', 'partial', '--json']);
    const integrityReport = JSON.parse(byIntegrity.stdout) as { sessions: Array<{ id: string }> };
    expect(integrityReport.sessions.map((session) => session.id)).toEqual(['filter-tail']);

    const byResume = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--resume', 'legacy-incomplete-evidence', '--json']);
    const resumeReport = JSON.parse(byResume.stdout) as { sessions: Array<{ id: string }> };
    expect(resumeReport.sessions.map((session) => session.id).sort()).toEqual(['filter-tail', 'filter-v1']);

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--format', 'v1']);
    expect(text.stdout).toContain('selection:');
    expect(text.stdout).toContain('filters: format=v1');
    expect(text.stdout).toContain('showing 2 of 2 matching (3 total)');
  });

  it('sorts by id and modified time in both orders with a stable id tie-break', async () => {
    const workspace = await tempWorkspace('sort ');
    await writeSession(workspace, 'sort-c', [v1Header(workspace, 'sort-c'), userMessage('q')]);
    await writeSession(workspace, 'sort-a', [v1Header(workspace, 'sort-a'), userMessage('q')]);
    await writeSession(workspace, 'sort-b', [v1Header(workspace, 'sort-b'), userMessage('q')]);
    const file = (id: string) => join(workspace, 'data', 'sessions', `${id}.jsonl`);
    await utimes(file('sort-c'), new Date('2020-01-03T00:00:00Z'), new Date('2020-01-03T00:00:00Z'));
    await utimes(file('sort-a'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    await utimes(file('sort-b'), new Date('2020-01-02T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));

    const idAsc = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--sort', 'id', '--order', 'asc', '--json']);
    const idAscReport = JSON.parse(idAsc.stdout) as { sessions: Array<{ id: string }> };
    expect(idAscReport.sessions.map((session) => session.id)).toEqual(['sort-a', 'sort-b', 'sort-c']);

    const modifiedDesc = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--json']);
    const descReport = JSON.parse(modifiedDesc.stdout) as { sessions: Array<{ id: string }> };
    expect(descReport.sessions.map((session) => session.id)).toEqual(['sort-c', 'sort-b', 'sort-a']);

    const modifiedAsc = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--sort', 'modified', '--order', 'asc', '--json']);
    const ascReport = JSON.parse(modifiedAsc.stdout) as { sessions: Array<{ id: string }> };
    expect(ascReport.sessions.map((session) => session.id)).toEqual(['sort-a', 'sort-b', 'sort-c']);
  });

  it('paginates after filter and sort with declared totals', async () => {
    const workspace = await tempWorkspace('page ');
    for (const id of ['page-1', 'page-2', 'page-3', 'page-4', 'page-5']) {
      await writeSession(workspace, id, [v1Header(workspace, id), userMessage('q')]);
    }

    const page2 = await runJarvis([
      '--cwd', workspace, 'sessions', 'list',
      '--sort', 'id', '--order', 'asc', '--page-size', '2', '--page', '2', '--json',
    ]);
    expect(page2.code).toBe(0);
    const report = JSON.parse(page2.stdout) as {
      sessions: Array<{ id: string }>;
      selection: { page: number; pageSize: number; totalPages: number; filtered: number; returned: number };
    };
    expect(report.sessions.map((session) => session.id)).toEqual(['page-3', 'page-4']);
    expect(report.selection).toMatchObject({ page: 2, pageSize: 2, totalPages: 3, filtered: 5, returned: 2 });

    const beyond = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--page-size', '2', '--page', '9', '--json']);
    const beyondReport = JSON.parse(beyond.stdout) as { sessions: unknown[]; selection: { returned: number } };
    expect(beyond.code).toBe(0);
    expect(beyondReport.sessions).toEqual([]);
    expect(beyondReport.selection.returned).toBe(0);

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--page-size', '2', '--page', '2', '--sort', 'id']);
    expect(text.stdout).toContain('page 2/3 (size 2)');
  });

  it('keeps exit 7 and damage visible when a filter excludes the corrupt session', async () => {
    const workspace = await tempWorkspace('damage ');
    await writeFile(
      join(workspace, 'data', 'sessions', 'corrupt-middle.jsonl'),
      `${JSON.stringify(v1Header(workspace, 'corrupt-middle'))}\n`
        + '{"t":"message","message":{"role":"user","content":"q"}}\n'
        + '{"t":"message","message":{"role":"user",\n'
        + '{"t":"message","message":{"role":"assistant","content":"a"}}\n',
      'utf8',
    );
    await writeSession(workspace, 'clean-v2', [v2Header(workspace, 'clean-v2'), v2Message(2, { role: 'user', content: 'q' })]);

    const filtered = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--format', 'v2', '--json']);

    expect(filtered.code).toBe(CLI_EXIT.STATE_CORRUPT);
    const report = JSON.parse(filtered.stdout) as {
      sessions: Array<{ id: string }>;
      selection: { total: number; filtered: number };
    };
    expect(report.sessions.map((session) => session.id)).toEqual(['clean-v2']);
    expect(report.selection).toMatchObject({ total: 2, filtered: 1 });
  });
});

describe('jarvis sessions search selection (session filter + match page)', () => {
  it('filters which sessions are content-searched while damage stays visible', async () => {
    const workspace = await tempWorkspace('search filter ');
    await writeSession(workspace, 'sf-v1', [v1Header(workspace, 'sf-v1'), userMessage('needle in v1')]);
    await writeSession(workspace, 'sf-v2', [v2Header(workspace, 'sf-v2'), v2Message(2, { role: 'user', content: 'needle in v2' })]);
    await writeFile(
      join(workspace, 'data', 'sessions', 'sf-corrupt.jsonl'),
      `${JSON.stringify(v1Header(workspace, 'sf-corrupt'))}\n`
        + '{"t":"message","message":{"role":"user","content":"needle in corrupt"}}\n'
        + '{"t":"message","message":{"role":"user",\n'
        + '{"t":"message","message":{"role":"assistant","content":"a"}}\n',
      'utf8',
    );

    const result = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--format', 'v2', '--json']);

    expect(result.code).toBe(CLI_EXIT.STATE_CORRUPT);
    const report = JSON.parse(result.stdout) as {
      scannedSessions: number;
      matches: Array<{ sessionId: string }>;
      skipped: Array<{ sessionId: string }>;
      selection: { filters: { format?: string }; matchedTotal: number; returned: number };
    };
    expect(report.scannedSessions).toBe(1);
    expect(report.matches.map((match) => match.sessionId)).toEqual(['sf-v2']);
    expect(report.skipped.map((skip) => skip.sessionId)).toEqual(['sf-corrupt']);
    expect(report.selection).toMatchObject({ filters: { format: 'v2' }, matchedTotal: 1, returned: 1 });
    expect(result.stdout).not.toContain('needle in v1');
    expect(result.stdout).not.toContain('needle in corrupt');
  });

  it('paginates matches with declared totals and rejects bad flags with exit 2', async () => {
    const workspace = await tempWorkspace('search page ');
    const messages = Array.from({ length: 12 }, (_, index) => userMessage(`needle hit ${index}`));
    await writeSession(workspace, 'sp-1', [v1Header(workspace, 'sp-1'), ...messages]);

    const page2 = await runJarvis([
      '--cwd', workspace, 'sessions', 'search', 'needle', '--page-size', '5', '--page', '2', '--json',
    ]);
    expect(page2.code).toBe(0);
    const report = JSON.parse(page2.stdout) as {
      matches: Array<{ recordOrdinal?: number }>;
      matchedSessions: number;
      selection: { matchedTotal: number; returned: number; page: number; pageSize: number; totalPages: number };
    };
    expect(report.selection).toMatchObject({ matchedTotal: 12, returned: 5, page: 2, pageSize: 5, totalPages: 3 });
    expect(report.matches).toHaveLength(5);
    expect(report.matchedSessions).toBe(1);

    const page1 = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--page-size', '5', '--json']);
    const firstPage = JSON.parse(page1.stdout) as { matches: Array<{ recordOrdinal?: number }> };
    const secondPageOrdinals = report.matches.map((match) => match.recordOrdinal);
    const firstPageOrdinals = firstPage.matches.map((match) => match.recordOrdinal);
    expect(secondPageOrdinals.some((ordinal) => firstPageOrdinals.includes(ordinal))).toBe(false);

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--page-size', '5', '--page', '3']);
    expect(text.stdout).toContain('page 3/3 (size 5)');
    expect(text.stdout).toContain('showing 2 of 12 matched');

    const invalid = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--integrity', 'bogus']);
    expect(invalid.code).toBe(CLI_EXIT.USAGE);
    expect(invalid.stderr).toContain('--integrity');
  });

  it('reports zero matches when the filter empties the candidate set', async () => {
    const workspace = await tempWorkspace('search empty ');
    await writeSession(workspace, 'se-v1', [v1Header(workspace, 'se-v1'), userMessage('needle')]);

    const result = await runJarvis(['--cwd', workspace, 'sessions', 'search', 'needle', '--format', 'v2', '--json']);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      scannedSessions: number;
      matches: unknown[];
      selection: { matchedTotal: number; returned: number };
    };
    expect(report.scannedSessions).toBe(0);
    expect(report.matches).toEqual([]);
    expect(report.selection).toMatchObject({ matchedTotal: 0, returned: 0 });
  });
});

async function tempWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `jarvis sessions selection e2e ${prefix}`));
  tempDirs.push(workspace);
  await mkdir(join(workspace, 'data', 'sessions'), { recursive: true });
  return workspace;
}

function v1Header(workspace: string, id: string): Record<string, unknown> {
  return { t: 'session', id, model: 'doubao-legacy', cwd: workspace, startedAt: '2026-08-01T00:00:00.000Z' };
}

function v2Header(workspace: string, id: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    seq: 1,
    at: 't1',
    t: 'session',
    id,
    model: 'doubao-v2-selection',
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

function userMessage(content: string): Record<string, unknown> {
  return { t: 'message', message: { role: 'user', content } };
}

function writeSession(workspace: string, id: string, records: unknown[], trailing = ''): Promise<void> {
  return writeFile(
    join(workspace, 'data', 'sessions', `${id}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n${trailing}`,
    'utf8',
  );
}

function runJarvis(
  args: string[],
  apiKey: string | null = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: 'sessions-selection-test-model' };
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
