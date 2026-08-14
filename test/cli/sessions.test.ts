import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSessionStore,
  NO_DYNAMIC_ADDENDUM,
  createModelRequestReceipt,
  createSessionComposition,
  serializeRecord,
  summarizeToolResult,
} from '../../src/runtime/session/session-store.js';
import {
  buildSessionsListReport,
  buildSessionsShowReport,
  formatSessionsListReport,
  formatSessionsShowReport,
  validateSessionId,
} from '../../src/surfaces/cli/sessions.js';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';
import type { Message } from '../../src/core/types.js';

const ESC = String.fromCharCode(27);
const SECRET_MARKER = 'TOP-SECRET-MESSAGE-CONTENT';

let root: string;
let sessionsDir: string;

const composition = createSessionComposition({
  root: 'repl',
  runtimeVersion: 'test-runtime',
  permissionMode: 'interactive',
  toolSchemas: [],
  systemPrompt: 'sys',
  dynamicAddendum: NO_DYNAMIC_ADDENDUM,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jarvis-sessions-unit-'));
  sessionsDir = join(root, 'data', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('validateSessionId', () => {
  it('accepts harness-shaped identifiers', () => {
    for (const id of ['goal-1', '2026-08-14T00-00-00-000Z', 'loop-abc', 'a.b_c-d', 's1']) {
      expect(validateSessionId(id)).toEqual({ ok: true });
    }
  });

  it.each([
    ['dot-dot', '..'],
    ['dot-dot sibling', '../sibling'],
    ['dot-dot windows sibling', '..\\sibling'],
    ['absolute posix', '/etc/passwd'],
    ['unc share', '\\\\server\\share'],
    ['drive absolute', 'C:\\evil'],
    ['drive relative ads', 'C:evil'],
    ['windows namespaced', '\\\\?\\C:\\evil'],
    ['windows device namespace', '\\\\.\\Device0'],
    ['separator escape', 'a/b'],
    ['windows separator escape', 'a\\b'],
    ['colon', 'a:b'],
    ['empty', ''],
    ['whitespace', '   '],
    ['dot', '.'],
    ['leading dash', '-flag'],
    ['space inside', 'a b'],
    ['non-ascii', '会话'],
    ['too long', 'a'.repeat(201)],
    ['windows device con', 'CON'],
    ['windows device con extension', 'con.txt'],
    ['windows device aux mixed case', 'AuX.log'],
    ['windows device com9', 'COM9.json'],
    ['windows device lpt1 trailing dot', 'lPt1.'],
    ['windows trailing dot alias', 'ordinary.'],
  ])('rejects %s', (_label, id) => {
    const check = validateSessionId(id);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason.length).toBeGreaterThan(0);
  });
});

describe('buildSessionsListReport', () => {
  it('returns an empty collection with exit 0 when data/sessions does not exist', async () => {
    await rm(join(root, 'data'), { recursive: true, force: true });

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions).toEqual([]);
    expect(report.integrity.status).toBe('complete');
    expect(formatSessionsListReport(report)).toContain('no sessions recorded');
  });

  it('returns an empty collection with exit 0 for an empty sessions directory', async () => {
    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions).toEqual([]);
  });

  it('ignores non-jsonl entries', async () => {
    await writeFile(join(sessionsDir, 'notes.txt'), 'ignore me', 'utf8');
    await writeV1Session('legacy-1');

    const { report } = await buildSessionsListReport({ cwd: root });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0].id).toBe('legacy-1');
  });

  it('summarizes a clean v1 session as legacy with partial evidence coverage and exit 0', async () => {
    await writeV1Session('legacy-1');

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions[0]).toMatchObject({
      id: 'legacy-1',
      format: 'v1',
      composition: { coverage: 'legacy' },
      pendingToolEffects: 0,
      integrity: { status: 'complete' },
      resume: { verdict: 'legacy-incomplete-evidence' },
    });
  });

  it('summarizes a clean v2 session as ready for the invocation-time resume check', async () => {
    await writeCleanV2Session('v2-clean');

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions[0]).toMatchObject({
      id: 'v2-clean',
      format: 'v2',
      composition: {
        coverage: 'full',
        dynamicAddendumCoverage: 'full',
        dynamicAddendumSource: 'none-v1',
        root: 'repl',
        runtimeVersion: 'test-runtime',
      },
      pendingToolEffects: 0,
      integrity: { status: 'complete' },
      resume: { verdict: 'ready-for-resume-check' },
    });
  });

  it('marks an older v2 session without dynamic provenance for composition review', async () => {
    const oldComposition = createSessionComposition({
      root: 'repl',
      runtimeVersion: 'test-runtime',
      permissionMode: 'interactive',
      toolSchemas: [],
      systemPrompt: 'sys',
    });
    await writeRawSession('v2-old-composition', [
      v2({
        t: 'session', id: 'v2-old-composition', model: 'm', cwd: root, startedAt: 't0', composition: oldComposition,
      }, 1),
    ]);

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions[0]).toMatchObject({
      composition: { coverage: 'full', dynamicAddendumCoverage: 'partial' },
      resume: { verdict: 'review-composition', reason: expect.stringContaining('dynamic addendum provenance') },
    });
  });

  it('marks a v2 pending assistant intent for manual review', async () => {
    await writePendingIntentV2('v2-intent');

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions[0]).toMatchObject({
      pendingToolEffects: 1,
      resume: { verdict: 'review-pending-effects' },
    });
  });

  it('counts a v2 planned orphan without a terminal receipt as pending', async () => {
    await writePlannedOrphanV2('v2-planned');

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions[0]).toMatchObject({
      pendingToolEffects: 1,
      resume: { verdict: 'review-pending-effects' },
    });
    const show = await buildSessionsShowReport({ cwd: root, sessionId: 'v2-planned' });
    if (show.status !== 'ok') throw new Error(`unexpected status: ${show.status}`);
    expect(show.report.session.pendingToolEffects[0]).toMatchObject({
      executionId: 'exec-1',
      reason: 'planned-without-terminal',
      toolName: 'write',
    });
  });

  it('counts a v2 unknown effect as pending', async () => {
    await writeUnknownEffectV2('v2-unknown');

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions[0].pendingToolEffects).toBe(1);
    const show = await buildSessionsShowReport({ cwd: root, sessionId: 'v2-unknown' });
    if (show.status !== 'ok') throw new Error(`unexpected status: ${show.status}`);
    expect(show.report.session.pendingToolEffects[0]).toMatchObject({ reason: 'unknown' });
  });

  it('reads a malformed tail diagnostically with exit 0 and keeps the session resumable', async () => {
    await writeCleanV2Session('v2-tail');
    await appendFile(join(sessionsDir, 'v2-tail.jsonl'), '{"t":"mess', 'utf8');

    const { report, exitCode } = await buildSessionsListReport({ cwd: root });

    expect(exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(report.sessions[0].integrity).toMatchObject({
      status: 'partial',
      issues: [{ kind: 'malformed-tail', path: 'sessions/v2-tail.jsonl', line: 9 }],
    });
    expect(report.sessions[0].resume).toMatchObject({
      verdict: 'ready-for-resume-check',
      reason: expect.stringContaining('crash-truncated tail at line 9'),
    });
  });

  it.each([
    [
      'middle corruption',
      async () => {
        await writeRawText('corrupt-middle', [
          serializeRecord({ t: 'session', id: 'corrupt-middle', model: 'm', cwd: '/x', startedAt: 't0' }),
          'NOT JSON',
          serializeRecord({ t: 'message', message: { role: 'user', content: 'kept' } }),
        ]);
      },
      { kind: 'malformed-middle', line: 2 },
    ],
    [
      'invalid record shape',
      async () => {
        await writeRawSession('corrupt-shape', [
          { t: 'session', id: 'corrupt-shape', model: 'm', cwd: '/x', startedAt: 't0' },
          {},
        ]);
      },
      { kind: 'invalid-record', line: 2 },
    ],
    [
      'missing header',
      async () => {
        await writeRawSession('corrupt-header', [
          { t: 'message', message: { role: 'user', content: 'orphan' } },
        ]);
      },
      { kind: 'header', line: 1 },
    ],
    [
      'v2 sequence gap',
      async () => {
        await writeRawSession('corrupt-seq', [
          v2({ t: 'session', id: 'corrupt-seq', model: 'm', cwd: '/x', startedAt: 't0', composition }, 1),
          v2({ t: 'message', message: { role: 'user', content: 'gap' } }, 3),
        ]);
      },
      { kind: 'sequence', line: 2 },
    ],
    [
      'request receipt contradiction',
      async () => {
        await writeRawSession('corrupt-receipt', [
          v2({ t: 'session', id: 'corrupt-receipt', model: 'm', cwd: '/x', startedAt: 't0', composition }, 1),
          v2({ t: 'message', message: { role: 'user', content: 'q' } }, 2),
          v2({
            t: 'request', requestId: 'req-1', runId: 'run-1', turn: 0,
            messageCount: 1, messagesHash: 'sha256.tampered', toolCount: 0, toolsHash: 'sha256.tools',
          }, 3),
        ]);
      },
      { kind: 'receipt', line: 3 },
    ],
    [
      'mixed v1/v2 records',
      async () => {
        await writeRawSession('corrupt-mixed', [
          v2({ t: 'session', id: 'corrupt-mixed', model: 'm', cwd: '/x', startedAt: 't0', composition }, 1),
          { t: 'message', message: { role: 'user', content: 'legacy' } },
        ]);
      },
      { kind: 'mixed-version', line: 2 },
    ],
  ])('reports %s as fail-closed with exit 7', async (_label, seed, expected) => {
    await seed();
    const text = await buildSessionsListReport({ cwd: root });
    expect(text.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(text.report.sessions[0].integrity.status).toBe('partial');
    expect(text.report.sessions[0].integrity.issues[0]).toMatchObject(expected);
    expect(text.report.sessions[0].resume.verdict).toBe('refuse-resume');

    const show = await buildSessionsShowReport({ cwd: root, sessionId: text.report.sessions[0].file.replace('.jsonl', '') });
    if (show.status !== 'ok') throw new Error(`unexpected status: ${show.status}`);
    expect(show.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(show.report.session.resume.verdict).toBe('refuse-resume');
  });

  it('preserves UTF-8 cwd and model metadata through text and JSON output', async () => {
    await writeRawSession('utf8-1', [
      {
        t: 'session', id: 'utf8-1', model: '模型-π', cwd: 'H:\\项目 workspace 测试',
        startedAt: '2026-08-14T00:00:00.000Z',
      },
      { t: 'message', message: { role: 'user', content: SECRET_MARKER } },
    ]);

    const { report } = await buildSessionsListReport({ cwd: root });
    const text = formatSessionsListReport(report);
    const json = JSON.stringify(report);

    expect(report.sessions[0].cwd).toBe('H:\\项目 workspace 测试');
    expect(report.sessions[0].model).toBe('模型-π');
    expect(text).toContain('H:\\项目 workspace 测试');
    expect(json).toContain('模型-π');
  });

  it('sorts by last modification time descending with a stable name tie-breaker', async () => {
    await writeV1Session('bbb');
    await writeV1Session('aaa');
    await writeV1Session('ccc');
    const base = new Date('2026-08-14T00:00:00Z');
    await setMtime('aaa.jsonl', base.getTime() + 5_000);
    await setMtime('bbb.jsonl', base.getTime() + 5_000);
    await setMtime('ccc.jsonl', base.getTime() + 10_000);

    const { report } = await buildSessionsListReport({ cwd: root });

    expect(report.sessions.map((session) => session.id)).toEqual(['ccc', 'aaa', 'bbb']);
    expect(report.sessions[0].lastModifiedAt).toBe('2026-08-14T00:00:10.000Z');
  });

  it('keeps the JSON contract versioned, observation-only, ANSI-free, and content-free', async () => {
    await writeCleanV2Session('v2-clean');

    const { report } = await buildSessionsListReport({ cwd: root, generatedAt: '2026-08-14T00:00:00.000Z' });
    const json = JSON.stringify(report);

    expect(report.schemaVersion).toBe(1);
    expect(report.authority).toEqual({
      mode: 'observation-only',
      canCompleteGoals: false,
      canCompleteLoops: false,
    });
    expect(report.source).toMatchObject({ cwd: root, dataDir: join(root, 'data') });
    expect(report.generatedAt).toBe('2026-08-14T00:00:00.000Z');
    expect(json.includes(ESC)).toBe(false);
    expect(json).not.toContain(SECRET_MARKER);
    expect(json).not.toContain('a.txt'); // tool arguments never serialized
  });

  it('keeps the text output contract human-facing and content-free', async () => {
    await writeCleanV2Session('v2-clean');
    const { report } = await buildSessionsListReport({ cwd: root });
    const text = formatSessionsListReport(report);

    expect(text).toContain('Sessions (read-only): 1');
    expect(text).toContain('source: ');
    expect(text).toContain('completion authority: none (observation-only)');
    expect(text).toContain('v2-clean');
    expect(text).toContain('integrity: complete');
    expect(text).toContain('resume: ready-for-resume-check');
    expect(text.includes(ESC)).toBe(false);
    expect(text).not.toContain(SECRET_MARKER);
  });
});

describe('buildSessionsShowReport', () => {
  it('rejects unsafe or unknown ids with usage-level results', async () => {
    await expect(buildSessionsShowReport({ cwd: root, sessionId: '../evil' })).resolves.toMatchObject({
      status: 'invalid-session-id',
    });
    await expect(buildSessionsShowReport({ cwd: root, sessionId: '\\\\?\\C:\\evil' })).resolves.toMatchObject({
      status: 'invalid-session-id',
    });
    await expect(buildSessionsShowReport({ cwd: root, sessionId: 'missing' })).resolves.toMatchObject({
      status: 'not-found',
      sessionId: 'missing',
    });
  });

  it('reports header identity, counts, composition hashes, and a pending invocation-time resume check', async () => {
    await writeCleanV2Session('v2-clean');

    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'v2-clean' });

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(result.report.schemaVersion).toBe(1);
    expect(result.report.authority).toEqual({
      mode: 'observation-only',
      canCompleteGoals: false,
      canCompleteLoops: false,
    });
    expect(result.report.source).toMatchObject({ cwd: root, dataDir: join(root, 'data') });
    expect(result.report.session).toMatchObject({
      id: 'v2-clean',
      file: 'v2-clean.jsonl',
      format: 'v2',
      counts: {
        messageRecords: 4,
        compactions: 0,
        requestReceipts: 1,
        toolReceipts: 2,
        projectedMessages: 4,
      },
      composition: {
        coverage: 'full',
        dynamicAddendumCoverage: 'full',
        dynamicAddendumSource: 'none-v1',
        dynamicAddendumManifestHash: expect.stringMatching(/^sha256\./u),
        root: 'repl',
        runtimeVersion: 'test-runtime',
        toolsetHash: expect.stringMatching(/^sha256\./u),
        systemPromptHash: expect.stringMatching(/^sha256\./u),
      },
      pendingToolEffects: [],
      integrity: { status: 'complete', issues: [], omittedIssueCount: 0 },
      resume: { verdict: 'ready-for-resume-check' },
    });
  });

  it('reports counts and legacy coverage for a clean v1 session', async () => {
    await writeV1Session('legacy-1');

    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'legacy-1' });

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(result.report.session).toMatchObject({
      format: 'v1',
      counts: { messageRecords: 4, compactions: 0, requestReceipts: 0, toolReceipts: 0 },
      composition: { coverage: 'legacy' },
      resume: { verdict: 'legacy-incomplete-evidence' },
    });
  });

  it('fails closed when the requested file id and JSONL header id differ', async () => {
    const hostileHeaderId = `different${ESC}[2J${ESC}[31m\r\nFORGED-HEADER-LINE`;
    await writeRawSession('requested-id', [
      { t: 'session', id: hostileHeaderId, model: 'm', cwd: root, startedAt: 't0' },
    ]);

    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'requested-id' });

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(result.report.session.integrity).toMatchObject({
      status: 'partial',
      issues: [expect.objectContaining({ kind: 'header', detail: expect.stringContaining('does not match file id') })],
    });
    expect(result.report.session.resume.verdict).toBe('refuse-resume');
    const text = formatSessionsShowReport(result.report);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain('\nFORGED-HEADER-LINE');
    const parsed = JSON.parse(JSON.stringify(result.report)) as typeof result.report;
    expect(parsed.session.id).toBe(hostileHeaderId);
    expect(parsed.session.integrity.issues[0].detail).toContain(hostileHeaderId);
    expect(parsed.session.resume.reason).toContain(hostileHeaderId);
  });

  it('reports a non-file session path as unreadable partial state instead of not-found', async () => {
    await mkdir(join(sessionsDir, 'directory-entry.jsonl'));

    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'directory-entry' });

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(result.report.session.integrity).toMatchObject({
      status: 'partial',
      issues: [expect.objectContaining({ kind: 'unreadable' })],
    });
    expect(result.report.session.resume.verdict).toBe('refuse-resume');
  });

  it('returns not-found when the file disappears before the operational second read', async () => {
    await writeCleanV2Session('vanished');

    const result = await buildSessionsShowReport(
      { cwd: root, sessionId: 'vanished' },
      {
        loadResolvedSession: async (resolution) => ({
          status: 'not-found',
          sessionId: resolution.sessionId,
          file: resolution.file,
          path: resolution.path,
        }),
      },
    );

    expect(result).toMatchObject({ status: 'not-found', sessionId: 'vanished' });
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('reports second-read %s as partial exit 7', async (code) => {
    await writeCleanV2Session('unreadable');

    const result = await buildSessionsShowReport(
      { cwd: root, sessionId: 'unreadable' },
      { loadResolvedSession: async () => { throw fsError(code); } },
    );

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(result.report.session.integrity).toMatchObject({
      status: 'partial',
      issues: [expect.objectContaining({ kind: 'unreadable', detail: expect.stringContaining(code) })],
    });
    expect(result.report.session.resume).toMatchObject({
      verdict: 'refuse-resume',
      reason: expect.stringContaining(code),
    });
  });

  it('reports a code-less semantic second-read failure as partial exit 7 with safe text', async () => {
    await writeCleanV2Session('semantic-failure');
    const attack = `semantic corruption${ESC}[2J${ESC}[31m\r\nFORGED-SEMANTIC-LINE`;

    const result = await buildSessionsShowReport(
      { cwd: root, sessionId: 'semantic-failure' },
      { loadResolvedSession: async () => { throw new Error(attack); } },
    );

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(result.report.session.integrity).toMatchObject({
      status: 'partial',
      issues: [expect.objectContaining({
        kind: 'unreadable',
        detail: expect.stringContaining(attack),
      })],
    });
    expect(result.report.session.resume).toMatchObject({
      verdict: 'refuse-resume',
      reason: expect.stringContaining(attack),
    });
    const text = formatSessionsShowReport(result.report);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\nFORGED-SEMANTIC-LINE');
    const json = JSON.stringify(result.report);
    expect(json).not.toContain(ESC);
    expect(JSON.parse(json)).toEqual(result.report);
  });

  it('summarizes pending effects with safe identifiers only', async () => {
    await writePendingIntentV2('v2-intent');

    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'v2-intent' });

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.SUCCESS);
    expect(result.report.session.pendingToolEffects).toEqual([
      {
        requestId: 'req-1',
        callId: 'call-1',
        toolName: 'write',
        reason: 'intent-without-plan',
      },
    ]);
    expect(JSON.stringify(result.report)).not.toContain('a.txt');
  });

  it('lists integrity issues with path, line, and type for a corrupt session', async () => {
    await writeRawSession('corrupt-receipt', [
      v2({ t: 'session', id: 'corrupt-receipt', model: 'm', cwd: '/x', startedAt: 't0', composition }, 1),
      v2({ t: 'message', message: { role: 'user', content: 'q' } }, 2),
      v2({
        t: 'request', requestId: 'req-1', runId: 'run-1', turn: 0,
        messageCount: 1, messagesHash: 'sha256.tampered', toolCount: 0, toolsHash: 'sha256.tools',
      }, 3),
    ]);

    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'corrupt-receipt' });

    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    expect(result.exitCode).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(result.report.session.integrity.issues[0]).toMatchObject({
      kind: 'receipt',
      path: 'sessions/corrupt-receipt.jsonl',
      line: 3,
    });
    expect(result.report.session.resume.verdict).toBe('refuse-resume');
    expect(formatSessionsShowReport(result.report)).toContain('receipt sessions/corrupt-receipt.jsonl:3');
  });

  it('keeps the show text output human-facing, ANSI-free, and content-free', async () => {
    await writeCleanV2Session('v2-clean');

    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'v2-clean' });
    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    const text = formatSessionsShowReport(result.report);

    expect(text).toContain('Session v2-clean (read-only)');
    expect(text).toContain('counts: messageRecords=4 compactions=0 requestReceipts=1 toolReceipts=2 projectedMessages=4');
    expect(text).toContain('pending tool effects: 0');
    expect(text).toContain('dynamicAddendumSource: none-v1');
    expect(text).toContain('dynamicAddendumManifestHash: sha256.');
    expect(text).toContain('integrity issues:');
    expect(text).toContain('completion authority: none (observation-only)');
    expect(text.includes(ESC)).toBe(false);
    expect(text).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(result.report).includes(ESC)).toBe(false);
  });

  it('single-lines every untrusted human field while standard JSON preserves escaped values', async () => {
    await writeCleanV2Session('v2-clean');
    const result = await buildSessionsShowReport({ cwd: root, sessionId: 'v2-clean' });
    if (result.status !== 'ok') throw new Error(`unexpected status: ${result.status}`);
    const attack = `hostile${ESC}[2J${ESC}[31m\r\nFORGED-LINE`;
    result.report.source.dataDir = attack;
    result.report.session.id = attack;
    result.report.session.file = attack;
    result.report.session.cwd = attack;
    result.report.session.model = attack;
    result.report.session.startedAt = attack;
    result.report.session.composition.dynamicAddendumSource = attack;
    result.report.session.composition.dynamicAddendumManifestHash = attack;
    result.report.session.pendingToolEffects = [{
      executionId: attack,
      requestId: attack,
      callId: attack,
      toolName: attack,
      reason: 'unknown',
    }];
    result.report.session.integrity = {
      status: 'partial',
      issues: [{ kind: 'receipt', path: attack, line: 2, detail: attack }],
      omittedIssueCount: 0,
    };
    result.report.session.resume = { verdict: 'refuse-resume', reason: attack };

    const text = formatSessionsShowReport(result.report);
    const json = JSON.stringify(result.report);

    expect(text).not.toContain(ESC);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\nFORGED-LINE');
    expect(text).toContain('hostile [2J [31m FORGED-LINE');
    expect(json).not.toContain(ESC);
    expect(JSON.parse(json)).toMatchObject({
      source: { dataDir: attack },
      session: { id: attack, cwd: attack, model: attack },
    });
  });
});

function v2(record: Record<string, unknown>, seq: number): Record<string, unknown> {
  return { schemaVersion: 2, seq, at: `t${seq}`, ...record };
}

async function writeRawSession(name: string, records: Array<Record<string, unknown>>): Promise<void> {
  const text = records.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(join(sessionsDir, `${name}.jsonl`), `${text}\n`, 'utf8');
}

async function writeRawText(name: string, lines: string[]): Promise<void> {
  await writeFile(
    join(sessionsDir, `${name}.jsonl`),
    lines.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join(''),
    'utf8',
  );
}

async function setMtime(file: string, ms: number): Promise<void> {
  const date = new Date(ms);
  await utimes(join(sessionsDir, file), date, date);
}

const sys: Message = { role: 'system', content: `sys ${SECRET_MARKER}` };
const userQ: Message = { role: 'user', content: `q ${SECRET_MARKER}` };

async function writeV1Session(id: string): Promise<void> {
  const store = new FileSessionStore(join(sessionsDir, `${id}.jsonl`), 0, { format: 'v1' });
  // The v1 write path drops composition; the parameter type still requires it.
  await store.writeHeader({ id, model: 'doubao-legacy', cwd: root, startedAt: '2026-08-01T00:00:00.000Z', composition });
  await store.sync([
    sys,
    userQ,
    { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: 'A' },
  ]);
}

const v2Call = { id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' };
const v2WriteCall = { id: 'call-1', name: 'write', arguments: '{"path":"a.txt","content":"x","createOnly":true}' };

async function writeCleanV2Session(id: string): Promise<void> {
  const store = new FileSessionStore(join(sessionsDir, `${id}.jsonl`));
  const assistant: Message = { role: 'assistant', requestId: 'req-1', toolCalls: [v2Call] };
  await store.writeHeader({ id, model: 'doubao-v2', cwd: root, startedAt: '2026-08-14T00:00:00.000Z', composition });
  await store.sync([sys, userQ]);
  await store.recordRequest(createModelRequestReceipt({
    requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys, userQ],
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
  }));
  await store.sync([sys, userQ, assistant]);
  await store.recordToolPlanned({
    t: 'tool', phase: 'planned', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1',
    turn: 0, callIndex: 0, call: v2Call,
  });
  await store.recordToolCommitted({
    t: 'tool', phase: 'committed', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1',
    turn: 0, callIndex: 0, result: summarizeToolResult({ callId: 'call-1', content: `A ${SECRET_MARKER}` }),
  });
  await store.sync([sys, userQ, assistant, { role: 'tool', toolCallId: 'call-1', content: 'A', executionId: 'exec-1' }]);
}

async function writePendingIntentV2(id: string): Promise<void> {
  const store = new FileSessionStore(join(sessionsDir, `${id}.jsonl`));
  await store.writeHeader({ id, model: 'doubao-v2', cwd: root, startedAt: '2026-08-14T00:00:00.000Z', composition });
  await store.sync([sys]);
  await store.recordRequest(createModelRequestReceipt({
    requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
  }));
  await store.sync([sys, { role: 'assistant', requestId: 'req-1', toolCalls: [v2WriteCall] }]);
}

async function writePlannedOrphanV2(id: string): Promise<void> {
  const store = new FileSessionStore(join(sessionsDir, `${id}.jsonl`));
  await store.writeHeader({ id, model: 'doubao-v2', cwd: root, startedAt: '2026-08-14T00:00:00.000Z', composition });
  await store.sync([sys]);
  await store.recordRequest(createModelRequestReceipt({
    requestId: 'req-1', runId: 'run-1', turn: 0, messages: [sys], tools: [],
  }));
  await store.sync([sys, { role: 'assistant', requestId: 'req-1', toolCalls: [v2WriteCall] }]);
  await store.recordToolPlanned({
    t: 'tool', phase: 'planned', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1',
    turn: 0, callIndex: 0, call: v2WriteCall,
  });
}

async function writeUnknownEffectV2(id: string): Promise<void> {
  await writePlannedOrphanV2(id);
  const store = new FileSessionStore(join(sessionsDir, `${id}.jsonl`), 0, {
    format: 'v2',
    initialSequence: 5,
  });
  await store.recordToolUnknown({
    t: 'tool', phase: 'unknown', executionId: 'exec-1', requestId: 'req-1', runId: 'run-1',
    turn: 0, callIndex: 0, reason: 'runner exited before confirming the effect',
  });
}

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: fixture filesystem failure`), { code });
}
