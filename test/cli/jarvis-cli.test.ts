import { execFile, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// This file launches real CLI subprocesses; full-suite worker contention can
// exceed Vitest's 5 s default even though each child has its own cap.
vi.setConfig({ testTimeout: 20_000 });
afterAll(() => vi.resetConfig());
import {
  HEADLESS_MAX_FRAME_BYTES,
  formatHeadlessDiagnostic,
  forwardAuthenticatedHeadlessFrames,
  forwardChildProcess,
} from '../../src/surfaces/cli/jarvis.js';
import { parseSessionLog } from '../../src/runtime/session/session-store.js';
import { requestEmergencyStop } from '../../src/runtime/control/emergency-stop.js';

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
    // Full-suite worker contention can push these cold CLI spawns past Vitest's
    // 5 s default while every child keeps its own hard timeout.
  }, 15_000);

  it('shows subcommand help without launching the model-facing entry point', async () => {
    const result = await runJarvis(['goal', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: jarvis goal');
    expect(result.stdout).toContain('jarvis goal --allow-no-git');
    expect(result.stderr).not.toContain('ARK_API_KEY');
  });

  it('documents the explicit Recall off switch on run and resume', async () => {
    const runHelp = await runJarvis(['run', '--help']);
    const resumeHelp = await runJarvis(['resume', '--help']);

    expect(runHelp).toMatchObject({ code: 0 });
    expect(resumeHelp).toMatchObject({ code: 0 });
    expect(runHelp.stdout).toContain('--no-recall');
    expect(resumeHelp.stdout).toContain('--no-recall');
  });

  it('exposes typed config inspection and the two bounded preset selectors in help', async () => {
    const rootHelp = await runJarvis(['--help']);
    const configHelp = await runJarvis(['config', '--help']);

    expect(rootHelp).toMatchObject({ code: 0 });
    expect(rootHelp.stdout).toContain('--strict-config');
    expect(rootHelp.stdout).toContain('--ignore-user-config');
    expect(rootHelp.stdout).toContain('--preset <inspect|safe>');
    expect(rootHelp.stdout).toContain('--safe');
    expect(rootHelp.stdout).toContain('config');
    expect(configHelp.stdout).toContain('show');
    expect(configHelp.stdout).toContain('validate');
    expect(configHelp.stdout).toContain('preset');
  });

  it('shows effective typed config and exact sources without reading a provider key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-config-show-'));
    tempDirs.push(root);
    const workspace = join(root, 'project');
    const userHome = join(root, 'home');
    await mkdir(join(workspace, '.jarvis'), { recursive: true });
    await mkdir(join(userHome, '.jarvis'), { recursive: true });
    await writeFile(
      join(userHome, '.jarvis', 'config.toml'),
      'schemaVersion = 1\npreset = "safe"\n[model]\nid = "user-model"\nbaseURL = "https://user.example/v1"\n',
      'utf8',
    );
    await writeFile(
      join(workspace, '.jarvis', 'config.toml'),
      'schemaVersion = 1\n[permissions]\nwritesFiles = "deny"\n',
      'utf8',
    );

    const result = await runJarvis(
      ['--cwd', workspace, '--model', 'cli-model', 'config', 'show', '--effective', '--sources', '--json'],
      {
        ARK_API_KEY: undefined,
        ARK_MODEL: 'environment-model',
        HOME: userHome,
        USERPROFILE: userHome,
      },
    );
    const report = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(report).toMatchObject({
      authority: { mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false },
      effective: {
        provider: 'doubao',
        model: 'cli-model',
        preset: 'safe',
        permissions: { writesFiles: 'deny', executesCode: 'ask', network: 'ask' },
      },
      sources: { values: { model: 'cli', preset: 'user' } },
    });
    expect(result.stdout).not.toContain('ARK_API_KEY');
  });

  it('fails closed on project attempts to select model/provider behavior', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-config-project-scope-'));
    tempDirs.push(workspace);
    await mkdir(join(workspace, '.jarvis'), { recursive: true });
    await writeFile(
      join(workspace, '.jarvis', 'config.toml'),
      'schemaVersion = 1\npreset = "safe"\n[model]\nid = "attacker-model"\n',
      'utf8',
    );

    const result = await runJarvis(
      ['--cwd', workspace, '--ignore-user-config', 'config', 'validate'],
      { ARK_API_KEY: undefined },
    );

    expect(result.code).toBe(7);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('may not set model or preset');
    expect(result.stderr).not.toContain('attacker-model');
  });

  it('enforces inspect as a hard no-side-effect preset without opening approval', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-inspect-preset-'));
    tempDirs.push(workspace);
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    let requestCount = 0;
    const endpoint = createServer((_request, response) => {
      requestCount++;
      if (requestCount === 1) {
        writeToolCallSse(response, {
          id: 'call-write',
          name: 'write',
          arguments: '{"path":"blocked.txt","content":"x","createOnly":true}',
        });
      } else {
        writeTextSse(response, 'done');
      }
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--headless', '--cwd', workspace, '--preset', 'inspect', 'run', 'try a write'],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.code).toBe(0);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.finished', toolName: 'write', outcome: 'denied' }),
    ]));
    expect(events.some((event) => event.type === 'approval.required')).toBe(false);
    await expect(readFile(join(workspace, 'blocked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('applies --cwd before forwarding status, including when the flag follows the command', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis cwd with spaces '));
    tempDirs.push(workspace);

    const result = await runJarvis(['status', '--cwd', workspace, '--json']);
    const report = JSON.parse(result.stdout) as { meta: { source: { dataDir: string } } };

    expect(result.code).toBe(0);
    expect(report.meta.source.dataDir).toBe(resolve(workspace, 'data'));
  });

  it('shows clear and requested emergency-stop states in status JSON and text', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-status-stop-'));
    tempDirs.push(workspace);

    const clear = await runJarvis(['status', '--cwd', workspace, '--json']);
    expect(clear.code).toBe(0);
    expect(JSON.parse(clear.stdout)).toMatchObject({
      meta: { schemaVersion: 1 },
      control: { emergencyStop: { requested: false } },
    });

    await requestEmergencyStop({
      cwd: workspace,
      source: 'test',
      reason: 'operator stop',
      now: () => new Date('2026-08-22T04:00:00.000Z'),
      pid: 42,
    });
    const requested = await runJarvis(['status', '--cwd', workspace, '--json', '--data-dir', 'telemetry']);
    const textStatus = await runJarvis(['status', '--cwd', workspace, '--data-dir', 'telemetry']);

    expect(requested.code).toBe(0);
    expect(JSON.parse(requested.stdout)).toMatchObject({
      meta: { schemaVersion: 1 },
      control: {
        emergencyStop: {
          requested: true,
          record: {
            requestedAt: '2026-08-22T04:00:00.000Z',
            source: 'test',
            reason: 'operator stop',
          },
        },
      },
    });
    expect(textStatus).toMatchObject({ code: 0 });
    expect(textStatus.stdout).toContain(
      'emergency stop: requested at=2026-08-22T04:00:00.000Z source=test reason=operator stop',
    );

    const escape = String.fromCharCode(27);
    const bidiOverride = String.fromCodePoint(0x202e);
    await requestEmergencyStop({
      cwd: workspace,
      source: 'test',
      reason: `operator${escape}[31m\n${bidiOverride}FORGED-LINE`,
      pid: 43,
    });
    const hostile = await runJarvis(['status', '--cwd', workspace, '--data-dir', 'telemetry']);
    expect(hostile).toMatchObject({ code: 0 });
    expect(hostile.stdout).not.toContain(escape);
    expect(hostile.stdout).not.toContain(bidiOverride);
    expect(hostile.stdout).not.toContain('\nFORGED-LINE');
  });

  it('surfaces a real emergency-stop read failure in status JSON and text', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-status-unreadable-'));
    tempDirs.push(workspace);
    await mkdir(join(workspace, 'data', 'control', 'emergency-stop.json'), { recursive: true });

    const json = await runJarvis(['status', '--cwd', workspace, '--json']);
    const text = await runJarvis(['status', '--cwd', workspace]);

    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      control: { emergencyStop: { requested: true, unreadable: true } },
    });
    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('emergency stop: unreadable requested=true error=');
  });

  it('uses exit 2 for an invalid global cwd', async () => {
    const result = await runJarvis(['--cwd', join(repo, 'definitely-missing-cwd'), 'status']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--cwd');
  });

  it('rejects --headless for read-only/non-agent commands', async () => {
    const result = await runJarvis(['--headless', 'status']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--headless');
  });

  it.each([
    ['--help'],
    ['--version'],
    ['run', '--help'],
    ['help', 'goal'],
  ])('rejects headless CLI metadata request %j without human stdout', async (...args) => {
    const result = await runJarvis(['--headless', ...args]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('remove --headless');
  });

  it('requires headless resume to use run --resume with an explicit prompt', async () => {
    const result = await runJarvis(['--headless', 'resume', 'session-id']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('run, goal, and loop');
  });

  it('requires an explicit prompt for a headless conversational run before provider setup', async () => {
    const result = await runJarvis(['--headless', 'run']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('requires a non-empty prompt');
    expect(result.stderr).not.toContain('ARK_API_KEY');
  });

  it('keeps root headless stdout empty when provider configuration is missing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-missing-provider-'));
    tempDirs.push(workspace);

    const result = await runJarvis(
      ['--headless', '--cwd', workspace, 'run', 'configuration must fail before a session starts'],
      { ARK_API_KEY: undefined },
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ARK_API_KEY');
  });

  it('offers current-Session Recall by default and removes it completely with --no-recall', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-recall-switch-'));
    tempDirs.push(workspace);
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    const requests: Array<Record<string, unknown>> = [];
    const endpoint = createServer((request, response) => {
      collectJsonRequest(request, response, requests);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    const env = { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` };
    let enabled;
    let disabled;
    try {
      enabled = await runJarvis(['--headless', '--cwd', workspace, 'run', 'recall enabled'], env);
      disabled = await runJarvis(['--headless', '--cwd', workspace, 'run', '--no-recall', 'recall disabled'], env);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    expect(enabled.code).toBe(0);
    expect(disabled.code).toBe(0);
    expect(requests).toHaveLength(2);
    const enabledNames = requestToolNames(requests[0]);
    const disabledNames = requestToolNames(requests[1]);
    expect(enabledNames).toEqual(expect.arrayContaining(['history_search', 'history_turn']));
    expect(disabledNames).not.toContain('history_search');
    expect(disabledNames).not.toContain('history_turn');
    expect(requestSystemText(requests[0])).toContain('低权威历史数据');
    expect(requestSystemText(requests[1])).not.toContain('低权威历史数据');
  }, 20_000);

  it('executes Recall as read-only history without approval or completion authority and persists the bounded result', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-recall-execution-'));
    tempDirs.push(workspace);
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    let requestCount = 0;
    const endpoint = createServer((_request, response) => {
      requestCount++;
      if (requestCount === 1) {
        writeToolCallSse(response, { id: 'call-history', name: 'history_search', arguments: '{"query":"earlier"}' });
      } else {
        writeTextSse(response, 'done');
      }
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--headless', '--cwd', workspace, 'run', 'exercise Recall execution'],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.code).toBe(0);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.started', toolName: 'history_search' }),
      expect.objectContaining({ type: 'tool.finished', toolName: 'history_search', outcome: 'committed' }),
    ]));
    expect(events.some((event) => event.type === 'approval.required')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'run.finished',
      completion: { granted: false, authority: 'none' },
    });

    const sessionFiles = await readdir(join(workspace, 'data', 'sessions'));
    expect(sessionFiles).toHaveLength(1);
    const records = parseSessionLog(await readFile(join(workspace, 'data', 'sessions', sessionFiles[0] ?? ''), 'utf8'));
    const recalled = records.find(
      (record) => record.t === 'message' && record.message.role === 'tool' && record.message.toolCallId === 'call-history',
    );
    const content = recalled?.t === 'message' && recalled.message.role === 'tool' ? recalled.message.content : '';
    expect(content).toContain('"level":"historical-low"');
    expect(content).toContain('"currentStateProof":false');
    expect(content).not.toContain('[jarvis-file-receipt]');
  }, 20_000);

  it('routes only fd 3 agent events to stdout and moves child human output to stderr', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutText = '';
    let stderrText = '';
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', (chunk: string) => { stdoutText += chunk; });
    stderr.on('data', (chunk: string) => { stderrText += chunk; });

    const result = await forwardChildProcess(
      fixtureArgs('headless'),
      repo,
      new EventEmitter(),
      { headless: true, stdout, stderr },
    );

    expect(result).toBe(0);
    expect(stdoutText.trim()).toBe('{"schemaVersion":1,"type":"run.finished"}');
    expect(stderrText).toContain('human stdout');
    expect(stderrText).toContain('human stderr');
    expect(stdoutText).not.toContain('human');
  });

  it('rejects an unsigned child frame instead of forwarding it as public JSONL', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutText = '';
    let stderrText = '';
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', (chunk: string) => { stdoutText += chunk; });
    stderr.on('data', (chunk: string) => { stderrText += chunk; });

    const result = await forwardChildProcess(
      fixtureArgs('headless-forged'),
      repo,
      new EventEmitter(),
      { headless: true, stdout, stderr },
    );

    expect(result).toBe(5);
    expect(stdoutText).toBe('');
    expect(stderrText).toContain('transport failed');
  });

  it('rejects an over-limit, otherwise authenticated frame before its newline arrives', () => {
    const source = new PassThrough();
    const target = new ControlledWritable();
    const failed = vi.fn();
    const secret = 'cd'.repeat(32);
    const line = 'x'.repeat(HEADLESS_MAX_FRAME_BYTES);
    const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(line, 'utf8').digest('hex');
    const dispose = forwardAuthenticatedHeadlessFrames(source, asWritable(target), secret, failed);

    source.write(`${mac}\t${line}`);

    expect(failed).toHaveBeenCalledWith('frame-too-large');
    expect(target.writes).toEqual([]);
    dispose();
  });

  it('fails closed when fd 3 closes with a partial authenticated frame', async () => {
    const source = new PassThrough();
    const target = new ControlledWritable();
    const failed = vi.fn();
    const secret = 'ef'.repeat(32);
    const line = '{"schemaVersion":1';
    const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(line, 'utf8').digest('hex');
    const dispose = forwardAuthenticatedHeadlessFrames(source, asWritable(target), secret, failed);

    source.end(`${mac}\t${line}`);
    await new Promise<void>((resolveEnd) => setImmediate(resolveEnd));

    expect(failed).toHaveBeenCalledWith('partial-frame');
    dispose();
  });

  it('enforces the incomplete-frame limit even while fd 3 is paused for stdout backpressure', () => {
    const source = new PassThrough();
    const target = new ControlledWritable([false]);
    const failed = vi.fn();
    const secret = '12'.repeat(32);
    const first = signedFrame(secret, '{"sequence":1}');
    const oversizedLine = 'x'.repeat(HEADLESS_MAX_FRAME_BYTES);
    const oversizedMac = createHmac('sha256', Buffer.from(secret, 'hex')).update(oversizedLine, 'utf8').digest('hex');
    const dispose = forwardAuthenticatedHeadlessFrames(source, asWritable(target), secret, failed);

    source.write(`${first}\n`);
    source.emit('data', `${oversizedMac}\t${oversizedLine}`);

    expect(target.writes).toEqual(['{"sequence":1}\n']);
    expect(failed).toHaveBeenCalledWith('frame-too-large');
    dispose();
  });

  it('pauses fd 3 for public stdout backpressure, resumes on drain, and fails closed on output error', () => {
    const source = new PassThrough();
    const target = new ControlledWritable([false, true]);
    const failed = vi.fn();
    const secret = '01'.repeat(32);
    const pause = vi.spyOn(source, 'pause');
    const resume = vi.spyOn(source, 'resume');
    const first = signedFrame(secret, '{"sequence":1}');
    const second = signedFrame(secret, '{"sequence":2}');
    const dispose = forwardAuthenticatedHeadlessFrames(source, asWritable(target), secret, failed);

    source.write(`${first}\n${second}\n`);

    expect(target.writes).toEqual(['{"sequence":1}\n']);
    expect(pause).toHaveBeenCalledOnce();
    const resumesBeforeDrain = resume.mock.calls.length;
    target.emit('drain');
    expect(target.writes).toEqual(['{"sequence":1}\n', '{"sequence":2}\n']);
    expect(resume).toHaveBeenCalledTimes(resumesBeforeDrain + 1);

    target.emit('error', new Error('broken consumer'));
    expect(failed).toHaveBeenCalledWith('public-output');

    dispose();
    expect(source.listenerCount('data')).toBe(0);
    expect(source.listenerCount('end')).toBe(0);
    expect(target.listenerCount('error')).toBe(0);
  });

  it('does not report child success until an accepted backpressured frame has drained', async () => {
    const child = new IgnoringHeadlessChild();
    const stdout = new ControlledWritable([false]);
    const stderr = new ControlledWritable();
    const signals = new EventEmitter();
    let secret = '';
    let settled = false;
    child.auth.setEncoding('utf8');
    child.auth.on('data', (chunk: string) => { secret += chunk; });

    const result = forwardChildProcess(['unused'], repo, signals, {
      headless: true,
      stdout: asWritable(stdout),
      stderr: asWritable(stderr),
      spawnChild: () => child as unknown as ChildProcess,
    });
    void result.then(() => { settled = true; });
    await waitFor(() => secret.length === 64);

    child.agentEvents.end(`${signedFrame(secret, '{"sequence":1}')}\n`);
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    child.emit('close', 0, null);
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

    expect(stdout.writes).toEqual(['{"sequence":1}\n']);
    expect(settled).toBe(false);

    stdout.emit('drain');
    expect(await result).toBe(0);
    expect(settled).toBe(true);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('turns terminal controls in a child diagnostic into visible inert text', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const diagnostic = formatHeadlessDiagnostic('stdout', `before${ESC}]8;;https://example.invalid${BEL}\r\nafter\u202e`);

    expect(diagnostic).toContain('<0x1b>]8;;https://example.invalid<0x07><CR><LF>after<U+202E>');
    expect(diagnostic).not.toContain(ESC);
    expect(diagnostic).not.toContain('\r');
    expect(diagnostic).not.toContain('\u202e');
  });

  it('renders child stdout and stderr as inert single-line diagnostics', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrText = '';
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => { stderrText += chunk; });

    const result = await forwardChildProcess(
      fixtureArgs('headless-controls'),
      repo,
      new EventEmitter(),
      { headless: true, stdout, stderr },
    );

    expect(result).toBe(0);
    expect(stdout.read()?.toString()).toContain('run.finished');
    expect(stderrText).toContain('[jarvis child stdout]');
    expect(stderrText).toContain('[jarvis child stderr]');
    expect(stderrText).toContain('<0x1b>');
    expect(stderrText).toContain('<CR>');
    expect(stderrText).toContain('<LF>');
    expect(stderrText).toContain('<U+202E>');
    expect(stderrText).not.toContain('\u001b');
    expect(stderrText).not.toContain('\r');
    expect(stderrText).not.toContain('\u202e');
  });

  it('force-terminates a child that ignores SIGTERM after transport failure and cleans listeners', async () => {
    const child = new IgnoringHeadlessChild();
    const stdout = new ControlledWritable();
    const stderr = new ControlledWritable();
    const signals = new EventEmitter();
    const result = forwardChildProcess(['unused'], repo, signals, {
      headless: true,
      stdout: asWritable(stdout),
      stderr: asWritable(stderr),
      spawnChild: () => child as unknown as ChildProcess,
      transportFailureGraceMs: 10,
    });

    child.agentEvents.write('{"unsigned":true}\n');
    await waitFor(() => child.killSignals.includes('SIGKILL'));

    expect(await result).toBe(5);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.agentEvents.listenerCount('data')).toBe(0);
    expect(child.agentEvents.listenerCount('error')).toBe(0);
    expect(child.auth.listenerCount('error')).toBe(0);
    expect(stdout.listenerCount('error')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('closes a started headless goal with a failed terminal when the provider rejects the request', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-goal-'));
    tempDirs.push(workspace);
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\n', 'utf8');
    const endpoint = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture rejection' } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--headless', '--cwd', workspace, 'goal', '--allow-no-git', 'exercise provider failure'],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.code).toBe(5);
    expect(events[0]).toMatchObject({ type: 'session.started', root: 'goal' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.finished', status: 'failed' }),
    ]));
    expect(events.at(-1)).toMatchObject({
      type: 'run.finished',
      status: 'failed',
      exitCode: 5,
      completion: { granted: false, authority: 'none' },
    });
  });

  it('enforces inspect inside the actual headless goal permission gate', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-goal-inspect-'));
    tempDirs.push(workspace);
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    let requestCount = 0;
    const endpoint = createServer((_request, response) => {
      requestCount++;
      writeToolCallSse(
        response,
        requestCount === 1
          ? { id: 'call-write', name: 'write', arguments: '{"path":"blocked.txt","content":"x","createOnly":true}' }
          : { id: 'call-blocked', name: 'update_goal', arguments: '{"status":"blocked"}' },
      );
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--headless', '--cwd', workspace, '--preset', 'inspect', 'goal', '--allow-no-git', 'try a write'],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.code).toBe(3);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.finished', toolName: 'write', outcome: 'denied' }),
    ]));
    expect(events.some((event) => event.type === 'approval.required')).toBe(false);
    await expect(readFile(join(workspace, 'blocked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('keeps root headless loop JSONL-only while an ask-gated bash call is observably denied', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-loop-deny-'));
    tempDirs.push(workspace);
    const objectivesPath = join(workspace, 'objectives.txt');
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    await writeFile(objectivesPath, 'Exercise a denied bash request\n', 'utf8');
    let requestCount = 0;
    const endpoint = createServer((_request, response) => {
      requestCount++;
      writeToolCallSse(
        response,
        requestCount === 1
          ? { id: 'call-bash', name: 'bash', arguments: '{"command":"echo denied"}' }
          : { id: 'call-blocked', name: 'update_goal', arguments: '{"status":"blocked"}' },
      );
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--headless', '--cwd', workspace, 'loop', '--allow-no-git', objectivesPath],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const started = events.findIndex((event) => event.type === 'tool.started' && event.toolName === 'bash');
    const approvalRequired = events.findIndex((event) => event.type === 'approval.required');
    const approvalResolved = events.findIndex((event) => event.type === 'approval.resolved' && event.decision === 'deny');
    const finished = events.findIndex((event) => event.type === 'tool.finished' && event.toolName === 'bash' && event.outcome === 'denied');

    expect(result.code).toBe(3);
    expect(events.length).toBeGreaterThan(0);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(approvalRequired).toBeGreaterThanOrEqual(0);
    expect(approvalResolved).toBeGreaterThanOrEqual(0);
    expect(finished).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(approvalRequired);
    expect(approvalRequired).toBeLessThan(approvalResolved);
    expect(approvalResolved).toBeLessThan(finished);
    expect(events[approvalRequired]?.sessionId).toBe(events[started]?.sessionId);
    expect(events[approvalResolved]?.sessionId).toBe(events[started]?.sessionId);
    expect(events.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(result.stdout).not.toContain('Jarvis-Agent loop mode');
  });

  it('enforces inspect inside the actual per-goal loop permission gate', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jarvis-headless-loop-inspect-'));
    tempDirs.push(workspace);
    const objectivesPath = join(workspace, 'objectives.txt');
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    await writeFile(objectivesPath, 'Try a write under inspect\n', 'utf8');
    let requestCount = 0;
    const endpoint = createServer((_request, response) => {
      requestCount++;
      writeToolCallSse(
        response,
        requestCount === 1
          ? { id: 'call-write', name: 'write', arguments: '{"path":"blocked.txt","content":"x","createOnly":true}' }
          : { id: 'call-blocked', name: 'update_goal', arguments: '{"status":"blocked"}' },
      );
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        ['--headless', '--cwd', workspace, '--preset', 'inspect', 'loop', '--allow-no-git', objectivesPath],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.code).toBe(3);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.finished', toolName: 'write', outcome: 'denied' }),
    ]));
    expect(events.some((event) => event.type === 'approval.required')).toBe(false);
    await expect(readFile(join(workspace, 'blocked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('keeps safe write approval-required in an unattended parallel worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-headless-loop-safe-parallel-'));
    tempDirs.push(root);
    const workspace = join(root, 'project');
    const worktreeRoot = join(root, 'worktrees');
    const objectivesPath = join(workspace, 'objectives.txt');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, '.env'), 'ARK_API_KEY=fixture-key\nARK_MODEL=fixture-model\n', 'utf8');
    await writeFile(objectivesPath, 'Try a worktree write under safe\n', 'utf8');
    await writeFile(join(workspace, 'seed.txt'), 'seed\n', 'utf8');
    await runGit(workspace, ['init']);
    await runGit(workspace, ['config', 'user.email', 'fixture@example.test']);
    await runGit(workspace, ['config', 'user.name', 'Fixture']);
    await runGit(workspace, ['add', '.']);
    await runGit(workspace, ['commit', '-m', 'fixture']);

    let requestCount = 0;
    const endpoint = createServer((_request, response) => {
      requestCount++;
      writeToolCallSse(
        response,
        requestCount === 1
          ? { id: 'call-write', name: 'write', arguments: '{"path":"blocked.txt","content":"x","createOnly":true}' }
          : { id: 'call-blocked', name: 'update_goal', arguments: '{"status":"blocked"}' },
      );
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      endpoint.once('error', rejectListen);
      endpoint.listen(0, '127.0.0.1', resolveListen);
    });
    const address = endpoint.address() as AddressInfo;
    let result;
    try {
      result = await runJarvis(
        [
          '--headless', '--cwd', workspace, '--safe', 'loop', '--parallel', '2',
          '--worktree-root', worktreeRoot, objectivesPath,
        ],
        { ARK_API_KEY: undefined, ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => endpoint.close((err) => err ? rejectClose(err) : resolveClose()));
    }

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.code).toBe(3);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval.required', capability: 'writes-files' }),
      expect.objectContaining({ type: 'approval.resolved', decision: 'deny' }),
      expect.objectContaining({ type: 'tool.finished', toolName: 'write', outcome: 'denied' }),
    ]));
    const worktreeFiles = await readdir(worktreeRoot, { recursive: true });
    expect(worktreeFiles.some((path) => /(^|[\\/])blocked\.txt$/u.test(path))).toBe(false);
  }, 30_000);

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

function runJarvis(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_API_KEY: '', ...envOverrides };
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
    }
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

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    execFile('git', args, { cwd, windowsHide: true }, (error) => {
      if (error) rejectRun(error);
      else resolveRun();
    });
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

function signedFrame(secret: string, line: string): string {
  const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(line, 'utf8').digest('hex');
  return `${mac}\t${line}`;
}

function asWritable(stream: ControlledWritable): NodeJS.WritableStream {
  return stream as unknown as NodeJS.WritableStream;
}

class ControlledWritable extends EventEmitter {
  readonly writes: string[] = [];

  constructor(private readonly writeResults: boolean[] = []) {
    super();
  }

  write(text: string): boolean {
    this.writes.push(text);
    return this.writeResults.shift() ?? true;
  }
}

class IgnoringHeadlessChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly agentEvents = new PassThrough();
  readonly auth = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, this.agentEvents, this.auth] as unknown as ChildProcess['stdio'];
  readonly killSignals: NodeJS.Signals[] = [];
  killed = false;

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.killSignals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => this.emit('close', null, 'SIGKILL'));
    return true;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function writeToolCallSse(
  response: ServerResponse,
  call: { id: string; name: string; arguments: string },
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    id: 'fixture-response',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: 'fixture-response',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function collectJsonRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<Record<string, unknown>>,
): void {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => { raw += chunk; });
  request.on('end', () => {
    requests.push(JSON.parse(raw) as Record<string, unknown>);
    writeTextSse(response, 'done');
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

function requestToolNames(request: Record<string, unknown> | undefined): string[] {
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  return tools.flatMap((tool) => {
    if (typeof tool !== 'object' || tool === null || !('function' in tool)) return [];
    const fn = tool.function;
    return typeof fn === 'object' && fn !== null && 'name' in fn && typeof fn.name === 'string' ? [fn.name] : [];
  });
}

function requestSystemText(request: Record<string, unknown> | undefined): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const system = messages.find((message) => typeof message === 'object' && message !== null && message.role === 'system');
  return typeof system === 'object' && system !== null && 'content' in system && typeof system.content === 'string'
    ? system.content
    : '';
}
