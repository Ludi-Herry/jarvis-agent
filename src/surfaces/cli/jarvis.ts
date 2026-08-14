#!/usr/bin/env node
import { spawn } from 'node:child_process';
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
  let extracted: { argv: string[]; cwd: string };
  try {
    extracted = extractGlobalCwd(process.argv.slice(2), process.cwd());
  } catch (err) {
    console.error(`[jarvis] ${safeInline(err instanceof Error ? err.message : String(err))}`);
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
    setExit(await forwardToExistingCli(target, args, extracted.cwd));
  };

  const program = new Command();
  program
    .name('jarvis')
    .description('Jarvis-Agent CLI-first project-maintainer harness')
    .version(JARVIS_VERSION)
    .option('--cwd <dir>', 'resolve project config, .env, tools, and data from this directory')
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
    .addHelpText('after', `
Examples:
  jarvis run
  jarvis run "summarize the current changes"
  jarvis run --resume
  jarvis run --resume <session-id>`)
    .action(async (prompt: string[], options: { maxTurns?: string; resume?: string | boolean }) => {
      const args: string[] = [];
      if (options.maxTurns !== undefined) args.push('--max-turns', options.maxTurns);
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
    .action(async (id: string | undefined, options: { maxTurns?: string }) => {
      const args = ['--resume'];
      if (id !== undefined) args.push(id);
      if (options.maxTurns !== undefined) args.push('--max-turns', options.maxTurns);
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

export function extractGlobalCwd(argv: string[], baseCwd: string): { argv: string[]; cwd: string } {
  const rest: string[] = [];
  let selected: string | undefined;
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
    rest.push(arg);
  }
  return { argv: rest, cwd: resolve(baseCwd, selected ?? '.') };
}

async function forwardToExistingCli(target: ForwardTarget, args: string[], cwd: string): Promise<CliExitCode | number> {
  const currentPath = fileURLToPath(import.meta.url);
  const sourceMode = extname(currentPath) === '.ts';
  const targetPath = fileURLToPath(new URL(`./${target}${sourceMode ? '.ts' : '.js'}`, import.meta.url));
  const nodeArgs = sourceMode ? ['--import', import.meta.resolve('tsx'), targetPath, ...args] : [targetPath, ...args];

  return forwardChildProcess(nodeArgs, cwd);
}

export interface SignalHost {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export function forwardChildProcess(
  nodeArgs: string[],
  cwd: string,
  signalHost: SignalHost = process,
): Promise<CliExitCode | number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, nodeArgs, { cwd, env: process.env, stdio: 'inherit', windowsHide: true });
    let parentSignal: NodeJS.Signals | undefined;
    let settled = false;
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
      signalHost.off('SIGINT', onSigint);
      signalHost.off('SIGTERM', onSigterm);
      resolveExit(code);
    };
    child.once('error', (err) => {
      console.error(`[jarvis] failed to start child process: ${safeInline(err.message)}`);
      finish(CLI_EXIT.RUNTIME);
    });
    child.once('exit', (code, signal) => {
      const interrupted = parentSignal !== undefined || signal === 'SIGINT' || signal === 'SIGTERM';
      finish(interrupted ? CLI_EXIT.INTERRUPTED : code ?? CLI_EXIT.RUNTIME);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runJarvisCli().catch((err: unknown) => {
    console.error('[jarvis] fatal:', safeInline(err instanceof Error ? err.message : String(err)));
    process.exitCode = CLI_EXIT.RUNTIME;
  });
}
