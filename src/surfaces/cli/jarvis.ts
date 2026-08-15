#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { classifySessionFileError } from '../../runtime/index.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';
import { collectDoctorReport, doctorExitCode, formatDoctorReport } from './doctor.js';
import {
  buildSessionsListReport,
  buildSessionsShowReport,
  formatSessionsListReport,
  formatSessionsShowReport,
} from './sessions.js';
import { JARVIS_VERSION } from './package-info.js';
import { safeInline } from './approval.js';
import {
  JARVIS_AGENT_EVENT_AUTH_FD_ENV,
  JARVIS_AGENT_EVENT_FD_ENV,
  JARVIS_HEADLESS_ENV,
  verifyAgentEventFrame,
} from './headless-events.js';

type ForwardTarget =
  | 'index'
  | 'goal-cli'
  | 'loop-cli'
  | 'observe-cli'
  | 'loop-finalize-cli'
  | 'cron-cli'
  | 'cron-daemon-cli'
  | 'shadow-cli';

export async function runJarvisCli(): Promise<void> {
  let extracted: { argv: string[]; cwd: string; headless: boolean };
  try {
    extracted = extractGlobalCwd(process.argv.slice(2), process.cwd());
  } catch (err) {
    console.error(`[jarvis] ${safeInline(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  if (extracted.headless && isCliMetadataRequest(extracted.argv)) {
    console.error('[jarvis] remove --headless when requesting help or version information');
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }

  let cwdInfo;
  try {
    cwdInfo = await stat(extracted.cwd);
  } catch (err) {
    reportCwdAccessFailure(extracted.cwd, 'inspect', err);
    return;
  }
  if (!cwdInfo.isDirectory()) {
    console.error(`[jarvis] --cwd is not a directory: ${safeInline(extracted.cwd)}`);
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  try {
    process.chdir(extracted.cwd);
  } catch (err) {
    reportCwdAccessFailure(extracted.cwd, 'enter', err);
    return;
  }

  const setExit = (code: number): void => {
    process.exitCode = code;
  };
  const forward = async (target: ForwardTarget, args: string[]): Promise<void> => {
    if (extracted.headless && !HEADLESS_TARGETS.has(target)) {
      console.error('[jarvis] --headless is supported only for run, goal, and loop');
      setExit(CLI_EXIT.USAGE);
      return;
    }
    setExit(await forwardToExistingCli(target, args, extracted.cwd, extracted.headless));
  };

  const program = new Command();
  program
    .name('jarvis')
    .description('Jarvis-Agent CLI-first project-maintainer harness')
    .version(JARVIS_VERSION)
    .option('--cwd <dir>', 'resolve project config, .env, tools, and data from this directory')
    .option('--headless', 'emit agent-event JSONL on stdout; send human diagnostics to stderr')
    .showSuggestionAfterError()
    .showHelpAfterError('(run jarvis --help for the command tree)')
    .exitOverride()
    .action(async () => forward('index', []));

  program.addHelpText('after', `
Examples:
  jarvis
  jarvis run "inspect this repository"
  jarvis goal "fix the failing test"
  jarvis status --json
  jarvis sessions list
  jarvis doctor

Compatibility: existing npm run dev|goal|loop|cron|observe commands remain available.`);

  program
    .command('run [prompt...]')
    .alias('chat')
    .description('start or continue the interactive coding-agent session')
    .option('--max-turns <n>', 'maximum model turns for each prompt')
    .option('--resume [id]', 'resume the latest session, or a specific session id')
    .option('--no-recall', 'disable current-session history_search/history_turn tools')
    .addHelpText('after', `
Examples:
  jarvis run
  jarvis run "summarize the current changes"
  jarvis run --resume
  jarvis run --resume <session-id>`)
    .action(async (prompt: string[], options: { maxTurns?: string; resume?: string | boolean; recall: boolean }) => {
      const args: string[] = [];
      if (options.maxTurns !== undefined) args.push('--max-turns', options.maxTurns);
      if (!options.recall) args.push('--no-recall');
      if (options.resume !== undefined) {
        args.push('--resume');
        if (typeof options.resume === 'string') args.push(options.resume);
      }
      if (prompt.length > 0) args.push('--prompt', prompt.join(' '));
      await forward('index', args);
    });

  program
    .command('resume [id]')
    .description('resume the latest session, or a specific session id')
    .option('--max-turns <n>', 'maximum model turns for each prompt')
    .option('--no-recall', 'disable current-session history_search/history_turn tools')
    .action(async (id: string | undefined, options: { maxTurns?: string; recall: boolean }) => {
      const args = ['--resume'];
      if (id !== undefined) args.push(id);
      if (options.maxTurns !== undefined) args.push('--max-turns', options.maxTurns);
      if (!options.recall) args.push('--no-recall');
      await forward('index', args);
    });

  addPassthrough(program, 'goal', 'run one objective through the verified GoalLoop', 'goal-cli', [
    'jarvis goal "fix the failing test"',
    'jarvis goal --allow-no-git "inspect a non-Git fixture"',
  ], forward);
  addPassthrough(program, 'loop', 'run or resume an objectives queue', 'loop-cli', [
    'jarvis loop objectives.txt',
    'jarvis loop --resume --verifier-map <path> --hook-map <path> --sandbox-check-map <path>',
  ], forward);
  addPassthrough(program, 'status', 'show the read-only workspace observation report', 'observe-cli', [
    'jarvis status',
    'jarvis status --json',
    'jarvis status --data-dir <path>',
  ], forward);
  addPassthrough(program, 'finalize', 'report, merge, or clean up a completed loop', 'loop-finalize-cli', [
    'jarvis finalize <loop-id>',
    'jarvis finalize <loop-id> --merge',
  ], forward);
  addPassthrough(program, 'shadow', 'inspect or restore ShadowGit snapshots', 'shadow-cli', [
    'jarvis shadow log 10',
    'jarvis shadow restore <sha>',
  ], forward);

  const cron = program.command('cron').description('run or observe scheduled loop tasks');
  addPassthrough(cron, 'run', 'scan once and trigger due tasks', 'cron-cli', ['jarvis cron run <trusted-cron-map>'], forward);
  addPassthrough(cron, 'daemon', 'run the foreground cron daemon', 'cron-daemon-cli', ['jarvis cron daemon <trusted-cron-map>'], forward);
  addPassthrough(cron, 'status', 'show workspace status including cron activity', 'observe-cli', ['jarvis cron status --json'], forward);
  cron.action(() => cron.help());

  program
    .command('doctor')
    .description('run local read-only readiness checks; no provider request is sent')
    .option('--json', 'print the versioned DoctorReport JSON contract')
    .addHelpText('after', `
Checks: Node, cwd, credential source, Git baseline, sandbox command availability, and data path.
Credential values are never printed. The sandbox command probe is local and does not replace npm run sandbox:smoke.`)
    .action(async (options: { json?: boolean }) => {
      const report = await collectDoctorReport(extracted.cwd);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else process.stdout.write(formatDoctorReport(report));
      setExit(doctorExitCode(report));
    });

  const sessions = program.command('sessions').description('inspect recorded sessions (read-only; no provider, no completion authority)');
  sessions.action(() => sessions.help());
  sessions
    .command('list')
    .description('list sessions with identity, integrity, pending effects, and resume summaries')
    .option('--json', 'print the versioned SessionsListReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions list
  jarvis sessions list --json
Exit codes: 0 ok, 2 usage error, 7 damaged session state.`)
    .action(async (options: { json?: boolean }) => {
      try {
        const { report, exitCode } = await buildSessionsListReport({ cwd: extracted.cwd });
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else process.stdout.write(formatSessionsListReport(report));
        setExit(exitCode);
      } catch (err) {
        console.error(`[sessions] ${safeInline(err instanceof Error ? err.message : String(err))}`);
        setExit(CLI_EXIT.RUNTIME);
      }
    });
  sessions
    .command('show <session-id>')
    .description('show one session: header, counts, composition, pending effects, integrity, and resume advice')
    .option('--json', 'print the versioned SessionsShowReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions show <session-id>
  jarvis sessions show <session-id> --json
Exit codes: 0 ok, 2 unknown or unsafe session id, 7 damaged session state.`)
    .action(async (sessionId: string, options: { json?: boolean }) => {
      try {
        const result = await buildSessionsShowReport({ cwd: extracted.cwd, sessionId });
        if (result.status === 'invalid-session-id') {
          console.error(`[sessions] ${safeInline(result.reason)}`);
          setExit(CLI_EXIT.USAGE);
          return;
        }
        if (result.status === 'not-found') {
          console.error(`[sessions] session not found: ${safeInline(result.sessionId)} (expected ${safeInline(result.path)})`);
          setExit(CLI_EXIT.USAGE);
          return;
        }
        if (options.json) console.log(JSON.stringify(result.report, null, 2));
        else process.stdout.write(formatSessionsShowReport(result.report));
        setExit(result.exitCode);
      } catch (err) {
        console.error(`[sessions] ${safeInline(err instanceof Error ? err.message : String(err))}`);
        setExit(CLI_EXIT.RUNTIME);
      }
    });

  program.hook('preAction', (_command, actionCommand) => {
    if (!extracted.headless) return;
    if (['jarvis', 'run', 'goal', 'loop'].includes(actionCommand.name())) return;
    console.error('[jarvis] --headless is supported only for run, goal, and loop');
    throw new CommanderError(CLI_EXIT.USAGE, 'jarvis.headlessUnsupported', '--headless unsupported for this command');
  });

  try {
    await program.parseAsync(['node', 'jarvis', ...extracted.argv]);
  } catch (err) {
    if (err instanceof CommanderError && (err.code === 'commander.helpDisplayed' || err.code === 'commander.version')) {
      setExit(CLI_EXIT.SUCCESS);
      return;
    }
    if (err instanceof CommanderError) {
      setExit(CLI_EXIT.USAGE);
      return;
    }
    throw err;
  }
}

function reportCwdAccessFailure(cwd: string, operation: 'inspect' | 'enter', err: unknown): void {
  if (classifySessionFileError(err) === 'not-found') {
    console.error(`[jarvis] --cwd does not exist: ${safeInline(cwd)}`);
    process.exitCode = CLI_EXIT.USAGE;
    return;
  }
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? `${err.code}: `
    : '';
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[jarvis] cannot ${operation} --cwd ${safeInline(cwd)}: ${safeInline(`${code}${detail}`)}`);
  process.exitCode = CLI_EXIT.STATE_CORRUPT;
}

function addPassthrough(
  parent: Command,
  name: string,
  description: string,
  target: ForwardTarget,
  examples: string[],
  forward: (target: ForwardTarget, args: string[]) => Promise<void>,
): void {
  parent
    .command(`${name} [args...]`)
    .description(description)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .addHelpText('after', `\nExamples:\n${examples.map((example) => `  ${example}`).join('\n')}`)
    .action(async (args: string[]) => forward(target, args));
}

export function extractGlobalCwd(argv: string[], baseCwd: string): { argv: string[]; cwd: string; headless: boolean } {
  const rest: string[] = [];
  let selected: string | undefined;
  let headless = false;
  let passthrough = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (passthrough) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      rest.push(arg);
      continue;
    }
    if (arg === '--cwd') {
      const value = argv[++index];
      if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error('--cwd requires a path');
      if (selected !== undefined) throw new Error('--cwd may only be supplied once');
      selected = value;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length);
      if (value.trim() === '') throw new Error('--cwd requires a path');
      if (selected !== undefined) throw new Error('--cwd may only be supplied once');
      selected = value;
      continue;
    }
    if (arg === '--headless') {
      if (headless) throw new Error('--headless may only be supplied once');
      headless = true;
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, cwd: resolve(baseCwd, selected ?? '.'), headless };
}

function isCliMetadataRequest(argv: string[]): boolean {
  if (argv[0] === 'help') return true;
  for (const arg of argv) {
    if (arg === '--') break;
    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V') return true;
  }
  return false;
}

const HEADLESS_TARGETS = new Set<ForwardTarget>(['index', 'goal-cli', 'loop-cli']);

async function forwardToExistingCli(
  target: ForwardTarget,
  args: string[],
  cwd: string,
  headless: boolean,
): Promise<CliExitCode | number> {
  const currentPath = fileURLToPath(import.meta.url);
  const sourceMode = extname(currentPath) === '.ts';
  const targetPath = fileURLToPath(new URL(`./${target}${sourceMode ? '.ts' : '.js'}`, import.meta.url));
  const nodeArgs = sourceMode ? ['--import', import.meta.resolve('tsx'), targetPath, ...args] : [targetPath, ...args];

  return forwardChildProcess(nodeArgs, cwd, process, { headless });
}

export interface SignalHost {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Largest authenticated internal frame accepted before its terminating newline. */
export const HEADLESS_MAX_FRAME_BYTES = 64 * 1024;
const HEADLESS_TRANSPORT_FAILURE_GRACE_MS = 500;

type HeadlessTransportFailure =
  | 'authentication'
  | 'frame-too-large'
  | 'partial-frame'
  | 'source'
  | 'public-output';

type PausableReadable = NodeJS.ReadableStream & {
  pause(): unknown;
  resume(): unknown;
};

export interface ForwardChildProcessOptions {
  headless?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Test seam: production always uses node:child_process spawn. */
  spawnChild?: (input: {
    nodeArgs: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    headless: boolean;
  }) => ChildProcess;
  /** Test seam for the bounded SIGTERM-to-SIGKILL grace period. */
  transportFailureGraceMs?: number;
}

/**
 * Forward only complete, authenticated fd 3 frames to the public JSONL target. It deliberately
 * owns both sides of backpressure: a full public target pauses fd 3 until `drain`, so the root
 * cannot accumulate an unbounded in-memory queue while claiming machine observability.
 */
export function forwardAuthenticatedHeadlessFrames(
  source: PausableReadable,
  target: NodeJS.WritableStream,
  secret: string,
  reportFailure: (failure: HeadlessTransportFailure) => void,
  maxFrameBytes = HEADLESS_MAX_FRAME_BYTES,
  reportComplete: () => void = () => undefined,
): () => void {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new Error('headless frame size limit must be a positive safe integer');
  }

  let buffer = '';
  let blocked = false;
  let failed = false;
  let disposed = false;
  let sourceEnded = false;
  let completed = false;

  const fail = (failure: HeadlessTransportFailure): void => {
    if (disposed || failed) return;
    failed = true;
    reportFailure(failure);
  };
  const completeIfReady = (): void => {
    if (disposed || failed || completed || !sourceEnded || blocked || buffer !== '') return;
    completed = true;
    reportComplete();
  };
  const onDrain = (): void => {
    if (disposed || failed || !blocked) return;
    blocked = false;
    flush();
    if (disposed || failed || blocked) return;
    if (!sourceEnded) {
      try {
        source.resume();
      } catch {
        fail('source');
        return;
      }
    }
    completeIfReady();
  };
  const pauseForBackpressure = (): void => {
    if (disposed || failed || blocked) return;
    blocked = true;
    target.once('drain', onDrain);
    try {
      source.pause();
    } catch {
      fail('source');
    }
  };
  const forwardFrame = (frame: string): boolean => {
    if (Buffer.byteLength(frame, 'utf8') > maxFrameBytes) {
      fail('frame-too-large');
      return false;
    }
    let line: string;
    try {
      line = verifyAgentEventFrame(secret, frame);
    } catch {
      fail('authentication');
      return false;
    }
    try {
      if (!target.write(`${line}\n`)) pauseForBackpressure();
    } catch {
      fail('public-output');
      return false;
    }
    return !failed && !blocked;
  };
  const hasOversizedBufferedFrame = (): boolean => {
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf('\n', start);
      const end = newline < 0 ? buffer.length : newline;
      if (Buffer.byteLength(buffer.slice(start, end), 'utf8') > maxFrameBytes) return true;
      if (newline < 0) return false;
      start = newline + 1;
    }
  };
  const flush = (): void => {
    if (disposed || failed || blocked) return;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!forwardFrame(frame)) return;
    }
    if (hasOversizedBufferedFrame()) fail('frame-too-large');
    completeIfReady();
  };
  const onData = (chunk: string | Buffer): void => {
    if (disposed || failed) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (hasOversizedBufferedFrame()) {
      fail('frame-too-large');
      return;
    }
    flush();
  };
  const onSourceEnd = (): void => {
    if (disposed || failed || sourceEnded) return;
    sourceEnded = true;
    flush();
    if (disposed || failed) return;
    // While blocked, complete newline-terminated frames may legitimately remain queued until
    // public stdout drains. Any non-terminated tail is still an authenticated-frame failure.
    if (buffer !== '' && (!blocked || !buffer.endsWith('\n'))) {
      fail('partial-frame');
      return;
    }
    completeIfReady();
  };
  const onSourceClose = (): void => {
    if (!disposed && !failed && !sourceEnded) fail(buffer === '' ? 'source' : 'partial-frame');
  };
  const onSourceError = (): void => fail('source');
  const onPublicOutputFailure = (): void => fail('public-output');

  source.setEncoding('utf8');
  source.on('data', onData);
  source.once('error', onSourceError);
  source.once('end', onSourceEnd);
  source.once('close', onSourceClose);
  target.once('error', onPublicOutputFailure);
  target.once('close', onPublicOutputFailure);

  return () => {
    if (disposed) return;
    disposed = true;
    source.removeListener('data', onData);
    source.removeListener('error', onSourceError);
    source.removeListener('end', onSourceEnd);
    source.removeListener('close', onSourceClose);
    target.removeListener('drain', onDrain);
    target.removeListener('error', onPublicOutputFailure);
    target.removeListener('close', onPublicOutputFailure);
  };
}

/** Render untrusted child text as one inert diagnostic record; only this function adds a newline. */
export function formatHeadlessDiagnostic(channel: 'stdout' | 'stderr', chunk: string | Buffer): string {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (text === '') return '';
  return `[jarvis child ${channel}] ${Array.from(text, escapeTerminalControl).join('')}\n`;
}

function escapeTerminalControl(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x0d) return '<CR>';
  if (code === 0x0a) return '<LF>';
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return `<0x${code.toString(16).padStart(2, '0')}>`;
  if (
    code === 0x061c
    || code === 0x200e
    || code === 0x200f
    || code === 0x2028
    || code === 0x2029
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069)
  ) {
    return `<U+${code.toString(16).toUpperCase()}>`;
  }
  return character;
}

function isPausableReadable(stream: unknown): stream is PausableReadable {
  return typeof stream === 'object'
    && stream !== null
    && 'on' in stream
    && 'once' in stream
    && 'removeListener' in stream
    && 'setEncoding' in stream
    && 'pause' in stream
    && 'resume' in stream
    && typeof stream.on === 'function'
    && typeof stream.once === 'function'
    && typeof stream.removeListener === 'function'
    && typeof stream.setEncoding === 'function'
    && typeof stream.pause === 'function'
    && typeof stream.resume === 'function';
}

function isWritableStream(stream: unknown): stream is NodeJS.WritableStream {
  return typeof stream === 'object'
    && stream !== null
    && 'write' in stream
    && 'end' in stream
    && 'once' in stream
    && 'removeListener' in stream
    && typeof stream.write === 'function'
    && typeof stream.end === 'function'
    && typeof stream.once === 'function'
    && typeof stream.removeListener === 'function';
}

function writeHeadlessDiagnostic(target: NodeJS.WritableStream, text: string): void {
  try {
    target.write(text);
  } catch {
    // A broken diagnostic stream must not prevent the already-failing child from being terminated.
  }
}

function attachHeadlessDiagnostic(
  channel: 'stdout' | 'stderr',
  source: NodeJS.ReadableStream | null,
  target: NodeJS.WritableStream,
): () => void {
  if (source === null) return () => undefined;
  source.setEncoding('utf8');
  const onData = (chunk: string | Buffer): void => writeHeadlessDiagnostic(target, formatHeadlessDiagnostic(channel, chunk));
  const onError = (): void => writeHeadlessDiagnostic(target, `[jarvis] child ${channel} diagnostic stream failed\n`);
  source.on('data', onData);
  source.once('error', onError);
  return () => {
    source.removeListener('data', onData);
    source.removeListener('error', onError);
  };
}

export function forwardChildProcess(
  nodeArgs: string[],
  cwd: string,
  signalHost: SignalHost = process,
  options: ForwardChildProcessOptions = {},
): Promise<CliExitCode | number> {
  return new Promise((resolveExit) => {
    const headless = options.headless === true;
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const transportSecret = headless ? randomBytes(32).toString('hex') : undefined;
    const env = headless
      ? {
          ...process.env,
          [JARVIS_HEADLESS_ENV]: '1',
          [JARVIS_AGENT_EVENT_FD_ENV]: '3',
          [JARVIS_AGENT_EVENT_AUTH_FD_ENV]: '4',
        }
      : process.env;
    const child = options.spawnChild?.({ nodeArgs, cwd, env, headless }) ?? spawn(process.execPath, nodeArgs, {
      cwd,
      env,
      stdio: headless ? ['inherit', 'pipe', 'pipe', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let transportFailed = false;
    let parentSignal: NodeJS.Signals | undefined;
    let settled = false;
    let transportComplete = !headless;
    let childCloseResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let cancelForcedTermination: (() => void) | undefined;
    let cleanupHeadless = (): void => undefined;
    const relaySignal = (signal: NodeJS.Signals): void => {
      parentSignal ??= signal;
      if (!child.killed) child.kill(signal);
    };
    const onSigint = (): void => relaySignal('SIGINT');
    const onSigterm = (): void => relaySignal('SIGTERM');
    signalHost.on('SIGINT', onSigint);
    signalHost.on('SIGTERM', onSigterm);
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      cancelForcedTermination?.();
      cleanupHeadless();
      signalHost.off('SIGINT', onSigint);
      signalHost.off('SIGTERM', onSigterm);
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      resolveExit(code);
    };
    const onChildError = (err: Error): void => {
      stderr.write(`[jarvis] failed to start child process: ${safeInline(err.message)}\n`);
      finish(CLI_EXIT.RUNTIME);
    };
    const finishClosedChildIfReady = (): void => {
      if (childCloseResult === undefined || (!transportFailed && !transportComplete)) return;
      const { code, signal } = childCloseResult;
      const interrupted = parentSignal !== undefined || signal === 'SIGINT' || signal === 'SIGTERM';
      finish(transportFailed ? CLI_EXIT.RUNTIME : interrupted ? CLI_EXIT.INTERRUPTED : code ?? CLI_EXIT.RUNTIME);
    };
    const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      childCloseResult = { code, signal };
      finishClosedChildIfReady();
    };
    const failTransport = (failure: HeadlessTransportFailure): void => {
      if (transportFailed || settled) return;
      transportFailed = true;
      writeHeadlessDiagnostic(stderr, `[jarvis] headless agent-event transport failed: ${transportFailureMessage(failure)}\n`);
      try {
        if (!child.killed) child.kill('SIGTERM');
      } catch {
        // Continue to the hard termination timer; the public stream is already failed closed.
      }
      const graceMs = normalizedTransportGraceMs(options.transportFailureGraceMs);
      const timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The close/error path owns final resolution. Never restore a failed transport to success.
        }
      }, graceMs);
      cancelForcedTermination = () => clearTimeout(timer);
      finishClosedChildIfReady();
    };

    child.once('error', onChildError);
    child.once('close', onChildClose);

    if (headless && transportSecret !== undefined) {
      cleanupHeadless = wireHeadlessTransport(
        child,
        transportSecret,
        stdout,
        stderr,
        failTransport,
        () => {
          transportComplete = true;
          finishClosedChildIfReady();
        },
      );
    }
  });
}

function wireHeadlessTransport(
  child: ChildProcess,
  transportSecret: string,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  failTransport: (failure: HeadlessTransportFailure) => void,
  completeTransport: () => void,
): () => void {
  const cleanups = [
    attachHeadlessDiagnostic('stdout', child.stdout, stderr),
    attachHeadlessDiagnostic('stderr', child.stderr, stderr),
  ];
  const auth = child.stdio[4];
  if (isWritableStream(auth)) {
    const onAuthError = (): void => failTransport('authentication');
    auth.once('error', onAuthError);
    cleanups.push(() => auth.removeListener('error', onAuthError));
    try {
      auth.end(transportSecret);
    } catch {
      failTransport('authentication');
    }
  } else {
    failTransport('authentication');
  }

  const agentEvents = child.stdio[3];
  if (isPausableReadable(agentEvents)) {
    cleanups.push(forwardAuthenticatedHeadlessFrames(
      agentEvents,
      stdout,
      transportSecret,
      failTransport,
      HEADLESS_MAX_FRAME_BYTES,
      completeTransport,
    ));
  } else {
    failTransport('source');
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function normalizedTransportGraceMs(value: number | undefined): number {
  if (value === undefined) return HEADLESS_TRANSPORT_FAILURE_GRACE_MS;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : HEADLESS_TRANSPORT_FAILURE_GRACE_MS;
}

function transportFailureMessage(failure: HeadlessTransportFailure): string {
  switch (failure) {
    case 'authentication':
      return 'authentication failed';
    case 'frame-too-large':
      return 'frame exceeded size limit';
    case 'partial-frame':
      return 'frame closed before newline';
    case 'source':
      return 'dedicated event stream failed';
    case 'public-output':
      return 'public stdout failed';
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runJarvisCli().catch((err: unknown) => {
    console.error('[jarvis] fatal:', safeInline(err instanceof Error ? err.message : String(err)));
    process.exitCode = CLI_EXIT.RUNTIME;
  });
}
