import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];
const ESC = String.fromCharCode(27);
const KEY_SENTINEL = 'ark-sentinel-key-value-never-print';
const RESUME_MODEL = 'session-cli-test-model';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis sessions (read-only product surface)', () => {
  it('discovers sessions list/show from root and group help without a provider key', async () => {
    const rootHelp = await runJarvis(['--help']);
    const groupHelp = await runJarvis(['sessions', '--help']);
    const listHelp = await runJarvis(['sessions', 'list', '--help']);
    const showHelp = await runJarvis(['sessions', 'show', '--help']);

    expect(rootHelp.code).toBe(0);
    expect(rootHelp.stdout).toContain('sessions');
    expect(rootHelp.stdout).toContain('jarvis sessions list');
    expect(groupHelp).toMatchObject({ code: 0 });
    expect(groupHelp.stdout).toContain('list');
    expect(groupHelp.stdout).toContain('show [options] <session-id>');
    expect(listHelp).toMatchObject({ code: 0 });
    expect(listHelp.stdout).toContain('jarvis sessions list --json');
    expect(showHelp).toMatchObject({ code: 0 });
    expect(showHelp.stdout).toContain('jarvis sessions show <session-id>');
    for (const result of [rootHelp, groupHelp, listHelp, showHelp]) {
      expect(result.stderr).not.toContain(KEY_SENTINEL);
      expect(result.stderr).not.toContain('ARK_API_KEY');
    }
  });

  it('maps a headless run without provider configuration to usage exit 2 before any session starts', async () => {
    const workspace = await tempWorkspace('headless missing provider ');

    const result = await runJarvis(
      ['--headless', '--cwd', workspace, 'run', 'do not start a session'],
      null,
      isolatedHome(workspace),
    );

    expect(result.code).toBe(CLI_EXIT.USAGE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ARK_API_KEY is not set');
  });

  it('lists an empty workspace with exit 0', async () => {
    const workspace = await tempWorkspace('empty ');

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--json']);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('Sessions (read-only): 0');
    expect(text.stdout).toContain('no sessions recorded');
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as { schemaVersion: number; sessions: unknown[] };
    expect(report.schemaVersion).toBe(1);
    expect(report.sessions).toEqual([]);
  });

  it('lists v1 and v2 sessions with the versioned JSON contract and no ANSI', async () => {
    const workspace = await tempWorkspace('mixed ');
    await writeLegacyV1(workspace, 'legacy-1');
    await writeCleanV2(workspace, 'v2-clean');

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--json']);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('legacy-1');
    expect(text.stdout).toContain('v2-clean');
    expect(text.stdout).toContain('legacy-incomplete-evidence');
    expect(text.stdout).toContain('ready-for-resume-check');

    expect(json.code).toBe(0);
    expect(json.stdout.includes(ESC)).toBe(false);
    const report = JSON.parse(json.stdout) as {
      schemaVersion: number;
      authority: { mode: string; canCompleteGoals: boolean; canCompleteLoops: boolean };
      source: { cwd: string; dataDir: string };
      sessions: Array<{ id: string; format: string }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.authority).toEqual({ mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false });
    expect(report.source.dataDir).toBe(join(workspace, 'data'));
    expect(report.sessions.map((session) => session.id).sort()).toEqual(['legacy-1', 'v2-clean']);
    expect(report.sessions.find((session) => session.id === 'legacy-1')?.format).toBe('v1');
    expect(report.sessions.find((session) => session.id === 'v2-clean')?.format).toBe('v2');
  });

  it('shows a clean v2 session in text and JSON with exit 0', async () => {
    const workspace = await tempWorkspace('show ');
    await writeCleanV2(workspace, 'v2-clean');

    const text = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'v2-clean']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'v2-clean', '--json']);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('Session v2-clean (read-only)');
    expect(text.stdout).toContain('format: v2  integrity: complete');
    expect(text.stdout).toContain('resume: ready-for-resume-check');
    expect(text.stdout).toContain('completion authority: none (observation-only)');

    expect(json.code).toBe(0);
    expect(json.stdout.includes(ESC)).toBe(false);
    const report = JSON.parse(json.stdout) as {
      schemaVersion: number;
      authority: unknown;
      session: { id: string; counts: Record<string, number>; pendingToolEffects: unknown[] };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.session.id).toBe('v2-clean');
    expect(report.session.counts).toMatchObject({ messageRecords: 2, projectedMessages: 2 });
    expect(report.session.pendingToolEffects).toEqual([]);
  });

  it('returns exit 2 for unknown ids, missing arguments, and path-escape attempts', async () => {
    const workspace = await tempWorkspace('usage ');
    await writeCleanV2(workspace, 'v2-clean');

    const notFound = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'missing-id']);
    expect(notFound.code).toBe(CLI_EXIT.USAGE);
    expect(notFound.stderr).toContain('session not found: missing-id');

    const missingArg = await runJarvis(['--cwd', workspace, 'sessions', 'show']);
    expect(missingArg.code).toBe(CLI_EXIT.USAGE);

    for (const evil of ['../evil', '..\\..\\windows', '\\\\?\\C:\\evil', 'C:\\evil', 'a/b', 'a:b']) {
      const result = await runJarvis(['--cwd', workspace, 'sessions', 'show', evil]);
      expect(result.code).toBe(CLI_EXIT.USAGE);
      expect(result.stderr).toContain('not a safe identifier');
    }
  });

  it('rejects Windows device aliases through both sessions show and actual resume before provider setup', async () => {
    const workspace = await tempWorkspace('devices ');

    for (const id of ['CON', 'con.txt', 'lpt9.']) {
      const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', id]);
      const resume = await runJarvis(['--cwd', workspace, 'resume', id], null);
      expect(show.code).toBe(CLI_EXIT.USAGE);
      expect(show.stderr).toContain('session id');
      expect(resume.code).toBe(CLI_EXIT.USAGE);
      expect(resume.stderr).toContain('session id');
    }
  }, 10_000);

  it('reports a directory at the requested .jsonl path as unreadable partial state with exit 7', async () => {
    const workspace = await tempWorkspace('non-file ');
    await mkdir(join(workspace, 'data', 'sessions', 'directory-entry.jsonl'));

    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'directory-entry']);

    expect(show.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(show.stdout).toContain('integrity: partial');
    expect(show.stdout).toContain('unreadable');
    expect(show.stdout).toContain('refuse-resume');
  });

  it('rejects a sessions-directory junction escape for list, inspection, and actual resume', async () => {
    const workspace = await tempWorkspace('junction source ');
    const outside = await tempWorkspace('junction target ');
    await writeLegacyV1(outside, 'escaped-session');
    await rm(join(workspace, 'data'), { recursive: true, force: true });
    await symlink(join(outside, 'data'), join(workspace, 'data'), 'junction');

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'escaped-session']);
    const resume = await runJarvis(['--cwd', workspace, 'resume', 'escaped-session'], null);
    const resumeLatest = await runJarvis(['--cwd', workspace, 'resume'], null);

    expect(list.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(list.stdout).toContain('unsafe-path');
    expect(list.stdout).not.toContain('escaped-session');
    expect(show.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(show.stdout).toContain('integrity: partial');
    expect(show.stdout).toContain('unsafe-path');
    expect(resume.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(resume.stderr).toContain('unsafe session path');
    expect(resumeLatest.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(resumeLatest.stderr).toContain('unsafe session path');
  });

  it('fails actual resume closed on filename/header identity mismatch before any provider request', async () => {
    const workspace = await tempWorkspace('identity ');
    const attack = `different${ESC}[2J${ESC}[31m\r\nFORGED-RESUME-LINE`;
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\n', 'utf8');
    await writeFile(
      join(workspace, 'data', 'sessions', 'requested-id.jsonl'),
      `${JSON.stringify({ t: 'session', id: attack, model: RESUME_MODEL, cwd: workspace, startedAt: 't0' })}\n`,
      'utf8',
    );

    let providerRequests = 0;
    const endpoint = createServer((_request, response) => {
      providerRequests += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let headlessResume;
    try {
      headlessResume = await runJarvis(
        ['--headless', '--cwd', workspace, 'run', '--resume', 'requested-id', 'must not execute'],
        null,
        { ...isolatedHome(workspace), ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }
    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'requested-id']);
    const resume = await runJarvis(['--cwd', workspace, 'resume', 'requested-id'], null);

    expect(show.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(show.stdout).toContain('refuse-resume');
    expect(resume.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(resume.stderr).toContain('does not match requested session id');
    expect(headlessResume.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(headlessResume.stdout).toBe('');
    expect(providerRequests).toBe(0);
    for (const output of [show.stdout, show.stderr, resume.stdout, resume.stderr, headlessResume.stderr]) {
      expect(output).not.toContain(ESC);
      expect(output).not.toContain('\r');
      expect(output).not.toContain('\nFORGED-RESUME-LINE');
    }
  });

  it('reports exact compatibility only after an actual v2 resume completes current composition checks', async () => {
    const workspace = await tempWorkspace('exact resume ');
    const sessionId = await createSessionThroughCli(workspace);

    const resume = await runJarvis(
      ['--cwd', workspace, 'resume', sessionId],
      null,
      isolatedHome(workspace),
    );

    expect(resume.code).toBe(CLI_EXIT.SUCCESS);
    expect(resume.stdout).toContain('[resume] compatibility: exact; dynamic composition matched:');
    expect(resume.stdout).toContain(`已恢复会话 ${sessionId}`);
    expect(resume.stderr).not.toContain('session composition changed');
  }, 30_000);

  it('maps actual resume composition drift to exit 3 without claiming exact compatibility', async () => {
    const workspace = await tempWorkspace('drift resume ');
    const sessionId = await createSessionThroughCli(workspace);
    const sessionPath = join(workspace, 'data', 'sessions', `${sessionId}.jsonl`);
    const lines = (await readFile(sessionPath, 'utf8')).trimEnd().split('\n');
    const header = JSON.parse(lines[0]) as {
      composition: { dynamicAddendumManifestHash: string };
    };
    header.composition.dynamicAddendumManifestHash = 'sha256.forced-manifest-drift';
    lines[0] = JSON.stringify(header);
    await writeFile(sessionPath, `${lines.join('\n')}\n`, 'utf8');

    const resume = await runJarvis(
      ['--cwd', workspace, 'resume', sessionId],
      null,
      isolatedHome(workspace),
    );

    expect(resume.code).toBe(CLI_EXIT.NEEDS_HUMAN);
    expect(resume.stderr).toContain('session composition changed (dynamicAddendumManifestHash)');
    expect(resume.stdout).not.toContain('compatibility: exact');
  }, 30_000);

  it('single-lines ESC, clear-screen, color, CR, and LF from session text while JSON stays valid', async () => {
    const workspace = await tempWorkspace('terminal ');
    const attack = `hostile${ESC}[2J${ESC}[31m\r\nFORGED-SESSION-LINE`;
    await writeFile(
      join(workspace, 'data', 'sessions', 'hostile.jsonl'),
      `${JSON.stringify({ t: 'session', id: 'hostile', model: attack, cwd: attack, startedAt: attack })}\n`,
      'utf8',
    );

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const text = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'hostile']);
    const json = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'hostile', '--json']);

    expect(list.code).toBe(0);
    expect(text.code).toBe(0);
    for (const output of [list.stdout, text.stdout]) {
      expect(output).not.toContain(ESC);
      expect(output).not.toContain('\r');
      expect(output).not.toContain('\nFORGED-SESSION-LINE');
    }
    expect(text.stdout).toContain('hostile [2J [31m FORGED-SESSION-LINE');
    expect(json.code).toBe(0);
    expect(json.stdout).not.toContain(ESC);
    const report = JSON.parse(json.stdout) as { session: { cwd: string; model: string; startedAt: string } };
    expect(report.session).toMatchObject({ cwd: attack, model: attack, startedAt: attack });
  });

  it('reports middle corruption with exit 7 for both list and show while printing the diagnosis', async () => {
    const workspace = await tempWorkspace('corrupt ');
    await writeFile(
      join(workspace, 'data', 'sessions', 'corrupt-1.jsonl'),
      '{"t":"session","id":"corrupt-1","model":"m","cwd":"c","startedAt":"t0"}\n'
        + 'NOT JSON\n'
        + '{"t":"message","message":{"role":"user","content":"kept"}}\n',
      'utf8',
    );

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const listJson = await runJarvis(['--cwd', workspace, 'sessions', 'list', '--json']);
    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'corrupt-1']);

    expect(list.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(list.stdout).toContain('integrity: partial');
    expect(list.stdout).toContain('malformed-middle sessions/corrupt-1.jsonl:2');
    expect(list.stdout).toContain('refuse-resume');
    expect(listJson.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(show.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(show.stdout).toContain('Session corrupt-1 (read-only)');
    expect(show.stdout).toContain('refuse-resume');
  });

  it('keeps a crash-truncated tail diagnosable with exit 0 and never claims a clean state', async () => {
    const workspace = await tempWorkspace('tail ');
    await writeCleanV2(workspace, 'v2-tail');
    await writeFile(
      join(workspace, 'data', 'sessions', 'v2-tail.jsonl'),
      `${await readSessionText(workspace, 'v2-tail')}{"t":"mess`,
      'utf8',
    );

    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'v2-tail']);

    expect(show.code).toBe(0);
    expect(show.stdout).toContain('integrity: partial');
    expect(show.stdout).toContain('malformed-tail');
    expect(show.stdout).toContain('crash-truncated tail');
  });

  it('marks pending legacy tool effects for manual review without failing the listing', async () => {
    const workspace = await tempWorkspace('pending ');
    await writeFile(
      join(workspace, 'data', 'sessions', 'pending-1.jsonl'),
      '{"t":"session","id":"pending-1","model":"m","cwd":"c","startedAt":"t0"}\n'
        + '{"t":"message","message":{"role":"user","content":"q"}}\n'
        + '{"t":"message","message":{"role":"assistant","toolCalls":[{"id":"c1","name":"write","arguments":"{}"}]}}\n',
      'utf8',
    );

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'pending-1']);

    expect(list.code).toBe(0);
    expect(list.stdout).toContain('pending tool effects: 1');
    expect(list.stdout).toContain('review-pending-effects');
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('write c1 intent-without-plan');
  });

  it('works from a Windows workspace path containing spaces and shows UTF-8 metadata', async () => {
    const workspace = await tempWorkspace('spaces and 中文 ');
    await writeFile(
      join(workspace, 'data', 'sessions', 'utf8-1.jsonl'),
      JSON.stringify({ t: 'session', id: 'utf8-1', model: '模型-π', cwd: 'H:\\项目 workspace 测试', startedAt: 't0' }) + '\n'
        + JSON.stringify({ t: 'message', message: { role: 'user', content: 'q' } }) + '\n',
      'utf8',
    );

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list']);
    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'utf8-1', '--json']);

    expect(list).toMatchObject({ code: 0 });
    expect(list.stdout).toContain('H:\\项目 workspace 测试');
    expect(list.stdout).toContain('模型-π');
    expect(show.code).toBe(0);
    const report = JSON.parse(show.stdout) as { session: { cwd: string; model: string } };
    expect(report.session.cwd).toBe('H:\\项目 workspace 测试');
    expect(report.session.model).toBe('模型-π');
  });

  it('never loads a provider or echoes the credential value', async () => {
    const source = await readFile(join(repo, 'src', 'surfaces', 'cli', 'sessions.ts'), 'utf8');
    expect(source).not.toMatch(/createProvider|loadDoubaoConfig|loadEnvFile|ARK_API_KEY/u);

    const workspace = await tempWorkspace('nokey ');
    await writeCleanV2(workspace, 'v2-clean');

    const list = await runJarvis(['--cwd', workspace, 'sessions', 'list'], KEY_SENTINEL);
    const show = await runJarvis(['--cwd', workspace, 'sessions', 'show', 'v2-clean'], KEY_SENTINEL);

    expect(list).toMatchObject({ code: 0 });
    expect(show).toMatchObject({ code: 0 });
    for (const result of [list, show]) {
      expect(result.stdout).not.toContain(KEY_SENTINEL);
      expect(result.stderr).not.toContain(KEY_SENTINEL);
    }
  });
});

async function tempWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `jarvis sessions e2e ${prefix}`));
  tempDirs.push(workspace);
  await mkdir(join(workspace, 'data', 'sessions'), { recursive: true });
  return workspace;
}

function writeLegacyV1(workspace: string, id: string): Promise<void> {
  return writeFile(
    join(workspace, 'data', 'sessions', `${id}.jsonl`),
    `{"t":"session","id":"${id}","model":"doubao-legacy","cwd":"${workspace.replaceAll('\\', '\\\\')}","startedAt":"2026-08-01T00:00:00.000Z"}\n`
      + '{"t":"message","message":{"role":"user","content":"q"}}\n'
      + '{"t":"message","message":{"role":"assistant","content":"a"}}\n',
    'utf8',
  );
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

async function readSessionText(workspace: string, id: string): Promise<string> {
  return readFile(join(workspace, 'data', 'sessions', `${id}.jsonl`), 'utf8');
}

function runJarvis(
  args: string[],
  apiKey: string | null = '',
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: RESUME_MODEL, ...envOverrides };
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

async function createSessionThroughCli(workspace: string): Promise<string> {
  await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\n', 'utf8');
  const created = await runJarvis(['--cwd', workspace, 'run'], null, isolatedHome(workspace));
  expect(created.code).toBe(CLI_EXIT.SUCCESS);
  const files = (await readdir(join(workspace, 'data', 'sessions'))).filter((file) => file.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  return files[0].slice(0, -'.jsonl'.length);
}

function isolatedHome(workspace: string): NodeJS.ProcessEnv {
  return { HOME: workspace, USERPROFILE: workspace };
}
