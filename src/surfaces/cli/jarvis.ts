#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { ShadowGit } from '../../capabilities/index.js';
import { defaultShellPath } from '../../core/index.js';
import { CONFIG_PRESETS, classifySessionFileError } from '../../runtime/index.js';
import { applyConversationRewind, prepareConversationRewind } from '../../runtime/checkpoint/index.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';
import { collectDoctorReport, doctorExitCode, formatDoctorReport } from './doctor.js';
import {
  buildSessionsListReport,
  buildSessionsShowReport,
  formatSessionsListReport,
  formatSessionsShowReport,
} from './sessions.js';
import {
  buildSessionsSearchReport,
  formatSessionsSearchReport,
  type SessionSearchSelection,
} from './sessions-search.js';
import {
  hasSessionSelection,
  parseSessionSelection,
  pickSelectionFlags,
  type SessionSelectionFlags,
  type SessionSelectionQuery,
} from './sessions-query.js';
import {
  formatSessionMutationReport,
  runSessionsFork,
  runSessionsMove,
  runSessionsRename,
} from './sessions-mutations.js';
import {
  buildReviewListReport,
  buildReviewShowReport,
  formatReviewDecisionReport,
  formatReviewListReport,
  formatReviewShowReport,
  reviewDecisionExitCode,
  reviewListExitCode,
  reviewShowExitCode,
  runReviewDecision,
} from './review.js';
import { JARVIS_VERSION } from './package-info.js';
import { safeInline } from './approval.js';
import {
  buildCheckpointsListReport,
  buildCheckpointsShowReport,
  assertCheckpointCommandIds,
  checkpointCommandErrorExitCode,
  formatCheckpointsListReport,
  formatCheckpointsShowReport,
} from './checkpoints.js';
import {
  configCliOptionsToArgs,
  extractConfigCliOptions,
  type ConfigCliOptions,
} from './config-options.js';
import {
  CONFIG_AUTHORITY,
  buildConfigInspectionReport,
  formatConfigInspectionReport,
  loadCliConfig,
  reportConfigWarnings,
} from './config.js';
import {
  JARVIS_AGENT_EVENT_AUTH_FD_ENV,
  JARVIS_AGENT_EVENT_FD_ENV,
  JARVIS_HEADLESS_ENV,
  verifyAgentEventFrame,
} from './headless-events.js';
import {
  executeFileRewind,
  prepareFileRewind,
  type PreparedFileRewind,
} from './file-rewind.js';
import {
  A0_AUTHORITY,
  DEFAULT_A0_CORPUS,
  DEFAULT_A0_PROMPT,
  a0CommandErrorExitCode,
  formatA0ReportResult,
  formatA0RunResult,
  reportA0Command,
  runA0Command,
  sanitizeA0Manifest,
} from './a0-cli.js';

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
  let extracted: { argv: string[]; cwd: string; headless: boolean; noTui: boolean; config: ConfigCliOptions };
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
    const surfaceArgs = target === 'index' && extracted.noTui ? ['--no-tui'] : [];
    const forwardedArgs = CONFIG_TARGETS.has(target)
      ? [...configCliOptionsToArgs(extracted.config), ...surfaceArgs, ...args]
      : [...surfaceArgs, ...args];
    setExit(await forwardToExistingCli(target, forwardedArgs, extracted.cwd, extracted.headless));
  };

  const program = new Command();
  program
    .name('jarvis')
    .description('Jarvis-Agent CLI-first project-maintainer harness')
    .version(JARVIS_VERSION)
    .option('--cwd <dir>', 'resolve project config, .env, tools, and data from this directory')
    .option('--headless', 'emit agent-event JSONL on stdout; send human diagnostics to stderr')
    .option('--no-tui', 'force the line REPL even when stdin/stdout are TTYs')
    .option('--strict-config', 'reject unknown typed-config keys instead of reporting warnings')
    .option('--ignore-user-config', 'skip the user config file for this invocation')
    .option('--preset <inspect|safe>', 'apply a built-in permission preset')
    .option('--safe', 'shorthand for --preset safe')
    .option('--model <id>', 'override the non-secret builder model id')
    .option('--base-url <url>', 'override the non-secret provider endpoint')
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
    .option('--format <v1|v2|unknown>', 'only list sessions of one log format')
    .option('--integrity <complete|partial>', 'only list sessions with this integrity status')
    .option('--resume <verdict>', 'only list sessions with this resume verdict')
    .option('--sort <modified|started|id>', 'sort key (default: modified)')
    .option('--order <asc|desc>', 'sort order (default: desc)')
    .option('--page <n>', '1-based page number (default page size 50)')
    .option('--page-size <n>', 'sessions per page (1-200)')
    .option('--archived', 'list archived sessions instead of active ones')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions list
  jarvis sessions list --json
  jarvis sessions list --integrity partial --sort id --order asc
  jarvis sessions list --page 2 --page-size 20
  jarvis sessions list --archived
Damage visibility is not selectable: corrupt sessions still set exit 7 even when filters exclude them from the listing.
Exit codes: 0 ok, 2 usage error, 7 damaged session state.`)
    .action(async (options: { json?: boolean; archived?: boolean } & SessionSelectionFlags) => {
      try {
        let selection: SessionSelectionQuery | undefined;
        const flags = pickSelectionFlags(options);
        if (hasSessionSelection(flags)) {
          const parsed = parseSessionSelection(flags);
          if (parsed.status === 'invalid') {
            console.error(`[sessions] ${safeInline(parsed.reason)}`);
            setExit(CLI_EXIT.USAGE);
            return;
          }
          selection = parsed.query;
        }
        const { report, exitCode } = await buildSessionsListReport({
          cwd: extracted.cwd,
          ...(selection === undefined ? {} : { selection }),
          ...(options.archived === true ? { archived: true } : {}),
        });
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

  sessions
    .command('search <query>')
    .description('search session metadata and user/assistant message text across all sessions (linear scan)')
    .option('--json', 'print the versioned SessionsSearchReport JSON contract')
    .option('--format <v1|v2|unknown>', 'only content-search sessions of one log format')
    .option('--integrity <complete|partial>', 'only content-search sessions with this integrity status')
    .option('--page <n>', '1-based page over the matched results (default page size 50)')
    .option('--page-size <n>', 'matches per page (1-200)')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions search "checkpoint rewind"
  jarvis sessions search "模型" --json
  jarvis sessions search "rewind" --format v2 --page 1 --page-size 10
Bounds: metadata (id/cwd/model) and append-only user/assistant text only; tool outputs, tool arguments, and system prompts are never searched. Excerpts are secret-redacted and bounded. Damaged sessions are skipped, not content-searched, and still set exit 7 even when filters exclude them.
Exit codes: 0 ok (including no matches), 2 usage error, 7 damaged session state skipped.`)
    .action(async (query: string, options: { json?: boolean } & SessionSelectionFlags) => {
      try {
        let selection: SessionSearchSelection | undefined;
        const flags = pickSelectionFlags(options);
        if (hasSessionSelection(flags)) {
          const parsed = parseSessionSelection(flags);
          if (parsed.status === 'invalid') {
            console.error(`[sessions] ${safeInline(parsed.reason)}`);
            setExit(CLI_EXIT.USAGE);
            return;
          }
          selection = {
            ...(parsed.query.format === undefined ? {} : { format: parsed.query.format }),
            ...(parsed.query.integrity === undefined ? {} : { integrity: parsed.query.integrity }),
            ...(parsed.query.page === undefined ? {} : { page: parsed.query.page }),
            ...(parsed.query.pageSize === undefined ? {} : { pageSize: parsed.query.pageSize }),
          };
        }
        const result = await buildSessionsSearchReport({
          cwd: extracted.cwd,
          query,
          ...(selection === undefined ? {} : { selection }),
        });
        if (result.status === 'invalid-query') {
          console.error(`[sessions] ${safeInline(result.reason)}`);
          setExit(CLI_EXIT.USAGE);
          return;
        }
        if (options.json) console.log(JSON.stringify(result.report, null, 2));
        else process.stdout.write(formatSessionsSearchReport(result.report));
        setExit(result.exitCode);
      } catch (err) {
        console.error(`[sessions] ${safeInline(err instanceof Error ? err.message : String(err))}`);
        setExit(CLI_EXIT.RUNTIME);
      }
    });

  const MUTATION_EXIT_HELP = 'Exit codes: 0 success, 2 usage error, 3 refused/blocked/partial, 5 runtime failure, 7 corrupt source.';
  const runMutation = async (
    kind: 'fork' | 'rename' | 'archive' | 'unarchive',
    ids: { sessionId: string; newId?: string },
    options: { json?: boolean },
  ): Promise<void> => {
    try {
      const { report, exitCode } = kind === 'fork'
        ? await runSessionsFork({ cwd: extracted.cwd, sessionId: ids.sessionId, ...(ids.newId === undefined ? {} : { newId: ids.newId }) })
        : kind === 'rename'
          ? await runSessionsRename({ cwd: extracted.cwd, sessionId: ids.sessionId, newId: ids.newId ?? '' })
          : await runSessionsMove({ cwd: extracted.cwd, sessionId: ids.sessionId, direction: kind });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else process.stdout.write(formatSessionMutationReport(report));
      setExit(exitCode);
    } catch (err) {
      console.error(`[sessions] ${safeInline(err instanceof Error ? err.message : String(err))}`);
      setExit(CLI_EXIT.RUNTIME);
    }
  };

  sessions
    .command('fork <session-id>')
    .description('create a full-fidelity copy of a session under a new id (receipts preserved, lineage recorded)')
    .option('--new-id <id>', 'explicit id for the fork (default: generated fork-<timestamp>-<random>)')
    .option('--json', 'print the versioned SessionMutationReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions fork <session-id>
  jarvis sessions fork <session-id> --new-id <new-id>
A source with pending tool effects, a partially recorded v2 composition, or fail-closed damage is refused (exit 3/7). The original session is never modified.
${MUTATION_EXIT_HELP}`)
    .action(async (sessionId: string, options: { newId?: string; json?: boolean }) => {
      await runMutation('fork', { sessionId, newId: options.newId }, options);
    });
  sessions
    .command('rename <session-id> <new-id>')
    .description('rename a session: fork to the new id, then archive the original (nothing is deleted)')
    .option('--json', 'print the versioned SessionMutationReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions rename <session-id> <new-id>
Rename is fork + archive: the original log is preserved in data/sessions/archived/. Any fork refusal (pending effects, partial composition, damage) stops the rename before anything changes.
${MUTATION_EXIT_HELP}`)
    .action(async (sessionId: string, newId: string, options: { json?: boolean }) => {
      await runMutation('rename', { sessionId, newId }, options);
    });
  sessions
    .command('archive <session-id>')
    .description('move a session into data/sessions/archived/ (content untouched; checkpoint audit moves alongside)')
    .option('--json', 'print the versioned SessionMutationReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions archive <session-id>
Archived sessions are invisible to list (without --archived), latest discovery, and resume; resume of an archived id reports not-found until unarchived.
${MUTATION_EXIT_HELP}`)
    .action(async (sessionId: string, options: { json?: boolean }) => {
      await runMutation('archive', { sessionId }, options);
    });
  sessions
    .command('unarchive <session-id>')
    .description('move an archived session back into the active sessions directory')
    .option('--json', 'print the versioned SessionMutationReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis sessions unarchive <session-id>
${MUTATION_EXIT_HELP}`)
    .action(async (sessionId: string, options: { json?: boolean }) => {
      await runMutation('unarchive', { sessionId }, options);
    });

  const checkpoints = program.command('checkpoints')
    .description('inspect checkpoint audit records (read-only; no completion authority)');
  checkpoints.action(() => checkpoints.help());
  checkpoints
    .command('list <session-id>')
    .description('list checkpoints for one recorded session')
    .option('--json', 'print the versioned checkpoint report')
    .allowExcessArguments(false)
    .action(async (sessionId: string, options: { json?: boolean }) => {
      try {
        const { report, exitCode } = await buildCheckpointsListReport({ cwd: extracted.cwd, sessionId });
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else process.stdout.write(formatCheckpointsListReport(report));
        setExit(exitCode);
      } catch (err) {
        console.error(`[checkpoints] ${safeCheckpointInline(err)}`);
        setExit(checkpointCommandErrorExitCode(err));
      }
    });
  checkpoints
    .command('show <session-id> <checkpoint-id>')
    .description('show one checkpoint without changing Session or files')
    .option('--json', 'print the versioned checkpoint report')
    .allowExcessArguments(false)
    .action(async (sessionId: string, checkpointId: string, options: { json?: boolean }) => {
      try {
        const result = await buildCheckpointsShowReport({ cwd: extracted.cwd, sessionId, checkpointId });
        if (result.status === 'not-found') {
          console.error(`[checkpoints] checkpoint not found: ${safeCheckpointInline(checkpointId)}`);
          setExit(CLI_EXIT.USAGE);
          return;
        }
        if (options.json) console.log(JSON.stringify(result.report, null, 2));
        else process.stdout.write(formatCheckpointsShowReport(result.report));
        setExit(result.exitCode);
      } catch (err) {
        console.error(`[checkpoints] ${safeCheckpointInline(err)}`);
        setExit(checkpointCommandErrorExitCode(err));
      }
    });

  program
    .command('rewind <session-id> <checkpoint-id>')
    .description('create a new conversation Session from a checkpoint; source logs remain unchanged')
    .option('--files', 'also restore files after bounded preview and one-time confirmation')
    .allowExcessArguments(false)
    .action(async (sessionId: string, checkpointId: string, options: { files?: boolean }) => {
      try {
        assertCheckpointCommandIds(sessionId, checkpointId);
        const plan = await prepareConversationRewind({
          cwd: extracted.cwd,
          sourceSessionId: sessionId,
          checkpointId,
        });
        if (options.files) {
          const prepared = await prepareFileRewind({
            conversation: plan,
            shadow: new ShadowGit({
              shellPath: defaultShellPath(),
              cwd: extracted.cwd,
              gitDir: join(extracted.cwd, 'data', 'checkpoint-shadow', sessionId),
            }),
          });
          process.stdout.write(formatFileRewindPreview(prepared));
          const approved = await askFileRewindApproval();
          const result = await executeFileRewind(prepared, approved);
          if (result.status === 'declined') {
            console.error(`[rewind] file rewind declined; preflight retained: ${safeCheckpointInline(result.preflightRef)}`);
            setExit(CLI_EXIT.NEEDS_HUMAN);
            return;
          }
          if (result.status === 'blocked') {
            console.error(`[rewind] file rewind blocked: ${safeCheckpointInline(result.reason)}`);
            setExit(result.reason.startsWith('recovery-required:') ? CLI_EXIT.STATE_CORRUPT : CLI_EXIT.NEEDS_HUMAN);
            return;
          }
          process.stdout.write(
            `rewind created: ${safeCheckpointInline(result.forkSessionId)} (${result.messageCount} message(s), files restored)\n`
              + `preflight retained: ${safeCheckpointInline(result.preflightRef)}\n`
              + `continue with: jarvis resume ${safeCheckpointInline(result.forkSessionId)}\n`,
          );
          setExit(CLI_EXIT.SUCCESS);
          return;
        }
        const result = await applyConversationRewind(plan);
        process.stdout.write(
          `rewind created: ${safeCheckpointInline(result.forkSessionId)} (${result.messageCount} message(s))\n`
            + `continue with: jarvis resume ${safeCheckpointInline(result.forkSessionId)}\n`,
        );
        setExit(CLI_EXIT.SUCCESS);
      } catch (err) {
        console.error(`[rewind] ${safeCheckpointInline(err)}`);
        setExit(checkpointCommandErrorExitCode(err));
      }
    });

  const config = program.command('config').description('inspect typed configuration and built-in presets (read-only)');
  const loadRootConfig = async () => {
    try {
      if (existsSync('.env')) process.loadEnvFile('.env');
      return await loadCliConfig({ cwd: extracted.cwd, options: extracted.config });
    } finally {
      // Config inspection never needs credentials. Drop any values loaded from .env before exit.
      delete process.env.ARK_API_KEY;
      delete process.env.ARK_REASONING_KEY;
    }
  };
  const failConfigCommand = (err: unknown): void => {
    console.error(`[config] ${safeInline(err instanceof Error ? err.message : String(err))}`);
    setExit(CLI_EXIT.STATE_CORRUPT);
  };
  config.action(() => config.help());
  config
    .command('path')
    .description('show the user, project, and project-local config paths without reading them')
    .option('--json', 'print a versioned JSON report')
    .allowExcessArguments(false)
    .action((options: { json?: boolean }) => {
      const paths = [
        { layer: 'user', path: join(homedir(), '.jarvis', 'config.toml') },
        { layer: 'project', path: join(extracted.cwd, '.jarvis', 'config.toml') },
        { layer: 'project-local', path: join(extracted.cwd, '.jarvis', 'config.local.toml') },
      ];
      if (options.json) {
        console.log(JSON.stringify({ schemaVersion: 1, authority: CONFIG_AUTHORITY, paths }, null, 2));
      } else {
        process.stdout.write(paths.map((entry) => `${entry.layer}: ${safeInline(entry.path)}`).join('\n') + '\n');
      }
      setExit(CLI_EXIT.SUCCESS);
    });
  config
    .command('show')
    .description('show the effective credential-free configuration')
    .option('--effective', 'show fully resolved values (the v0.1 default)')
    .option('--sources', 'include exact value and permission-deny provenance')
    .option('--json', 'print a versioned JSON report')
    .allowExcessArguments(false)
    .action(async (options: { effective?: boolean; sources?: boolean; json?: boolean }) => {
      try {
        const resolvedConfig = await loadRootConfig();
        const report = buildConfigInspectionReport(resolvedConfig, options.sources === true);
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else process.stdout.write(formatConfigInspectionReport(report));
        if (!options.json) reportConfigWarnings(resolvedConfig);
        setExit(CLI_EXIT.SUCCESS);
      } catch (err) {
        failConfigCommand(err);
      }
    });
  config
    .command('validate')
    .description('parse every selected config layer and fail closed on invalid state')
    .option('--json', 'print a versioned validation report')
    .allowExcessArguments(false)
    .action(async (options: { json?: boolean }) => {
      try {
        const resolvedConfig = await loadRootConfig();
        if (options.json) {
          console.log(JSON.stringify({
            schemaVersion: 1,
            authority: CONFIG_AUTHORITY,
            valid: true,
            files: resolvedConfig.files,
            warnings: resolvedConfig.warnings,
          }, null, 2));
        } else {
          process.stdout.write(`config valid (${resolvedConfig.files.filter((file) => file.status === 'loaded').length} file(s) loaded)\n`);
          reportConfigWarnings(resolvedConfig);
        }
        setExit(CLI_EXIT.SUCCESS);
      } catch (err) {
        failConfigCommand(err);
      }
    });
  const preset = config.command('preset').description('inspect the built-in inspect/safe presets');
  preset.action(() => preset.help());
  preset
    .command('list')
    .description('list built-in presets')
    .option('--json', 'print a versioned JSON report')
    .allowExcessArguments(false)
    .action((options: { json?: boolean }) => {
      const names = Object.keys(CONFIG_PRESETS);
      if (options.json) console.log(JSON.stringify({ schemaVersion: 1, authority: CONFIG_AUTHORITY, presets: names }, null, 2));
      else process.stdout.write(`${names.join('\n')}\n`);
      setExit(CLI_EXIT.SUCCESS);
    });
  preset
    .command('show <name>')
    .description('show one built-in preset capability matrix')
    .option('--json', 'print a versioned JSON report')
    .allowExcessArguments(false)
    .action((name: string, options: { json?: boolean }) => {
      if (name !== 'inspect' && name !== 'safe') {
        console.error(`[config] unknown preset: ${safeInline(name)} (expected inspect or safe)`);
        setExit(CLI_EXIT.USAGE);
        return;
      }
      const permissions = CONFIG_PRESETS[name];
      if (options.json) {
        console.log(JSON.stringify({ schemaVersion: 1, authority: CONFIG_AUTHORITY, name, permissions }, null, 2));
      } else {
        process.stdout.write(`${name}\n${Object.entries(permissions).map(([key, value]) => `  ${key}: ${value}`).join('\n')}\n`);
      }
      setExit(CLI_EXIT.SUCCESS);
    });

  const review = program.command('review')
    .description('inspect and resolve parked human-routed requirements (terminal human review)');
  review.action(() => review.help());
  review
    .command('list')
    .description('list goals parked for human review')
    .option('--json', 'print the versioned ReviewListReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis review list
  jarvis review list --json
Exit codes: 0 ok (including none pending), 7 corrupt goal/loop log.`)
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await buildReviewListReport({ cwd: extracted.cwd });
        if (result.status === 'ok') {
          if (options.json) console.log(JSON.stringify(result.report, null, 2));
          else process.stdout.write(formatReviewListReport(result.report));
        } else {
          console.error(`[review] ${safeInline(result.reason)}`);
        }
        setExit(reviewListExitCode(result));
      } catch (err) {
        console.error(`[review] ${safeInline(err instanceof Error ? err.message : String(err))}`);
        setExit(CLI_EXIT.RUNTIME);
      }
    });
  review
    .command('show <goal-id>')
    .description('show one parked human review: requirements, evidence summary, and checks')
    .option('--json', 'print the versioned ReviewShowReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis review show <goal-id>
Exit codes: 0 ok, 2 unknown or unsafe goal id, 7 corrupt goal/loop log.`)
    .action(async (goalId: string, options: { json?: boolean }) => {
      try {
        const result = await buildReviewShowReport({ cwd: extracted.cwd, goalId });
        if (result.status === 'ok') {
          if (options.json) console.log(JSON.stringify(result.report, null, 2));
          else process.stdout.write(formatReviewShowReport(result.report));
        } else if (result.status === 'not-found') {
          console.error(`[review] no pending human review for goal: ${safeInline(result.goalId)}`);
        } else {
          console.error(`[review] ${safeInline(result.reason)}`);
        }
        setExit(reviewShowExitCode(result));
      } catch (err) {
        console.error(`[review] ${safeInline(err instanceof Error ? err.message : String(err))}`);
        setExit(CLI_EXIT.RUNTIME);
      }
    });
  const runDecision = async (
    decision: 'approve' | 'reject',
    goalId: string,
    options: { requirement: string; note: string; reviewer?: string; json?: boolean },
  ): Promise<void> => {
    try {
      const result = await runReviewDecision({
        cwd: extracted.cwd,
        goalId,
        decision,
        requirementId: options.requirement,
        note: options.note,
        ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
      });
      if (result.status === 'recorded') {
        if (options.json) console.log(JSON.stringify(result.report, null, 2));
        else process.stdout.write(formatReviewDecisionReport(result.report));
      } else {
        console.error(`[review] ${safeInline(result.reason)}`);
      }
      setExit(reviewDecisionExitCode(result));
    } catch (err) {
      console.error(`[review] ${safeInline(err instanceof Error ? err.message : String(err))}`);
      setExit(CLI_EXIT.RUNTIME);
    }
  };
  const DECISION_EXIT_HELP = 'Exit codes: 0 decision recorded, 2 usage error (no pending review, unknown requirement, empty note), 5 runtime failure, 7 corrupt log.';
  review
    .command('approve <goal-id>')
    .description('record a human approval for one parked requirement')
    .requiredOption('--requirement <id>', 'pending requirement id to decide')
    .requiredOption('--note <text>', 'human evidence note (required, bounded)')
    .option('--reviewer <name>', 'reviewer identity recorded in the audit (default: human)')
    .option('--json', 'print the versioned ReviewDecisionReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis review approve <goal-id> --requirement r1 --note "verified manually in the terminal"
One requirement per call; undecided requirements stay parked. Any resulting completion is produced by decideVerdict on the recorded human evidence.
${DECISION_EXIT_HELP}`)
    .action(async (goalId: string, options: { requirement: string; note: string; reviewer?: string; json?: boolean }) => {
      await runDecision('approve', goalId, options);
    });
  review
    .command('reject <goal-id>')
    .description('record a human rejection for one parked requirement')
    .requiredOption('--requirement <id>', 'pending requirement id to decide')
    .requiredOption('--note <text>', 'human evidence note (required, bounded)')
    .option('--reviewer <name>', 'reviewer identity recorded in the audit (default: human)')
    .option('--json', 'print the versioned ReviewDecisionReport JSON contract')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  jarvis review reject <goal-id> --requirement r1 --note "does not match the accepted behavior"
${DECISION_EXIT_HELP}`)
    .action(async (goalId: string, options: { requirement: string; note: string; reviewer?: string; json?: boolean }) => {
      await runDecision('reject', goalId, options);
    });

  const a0 = program.command('a0')
    .description('run the frozen A0 evaluation corpus, or replay its observations (observation-only)');
  a0.action(() => a0.help());
  a0
    .command('run')
    .description('execute every case three times against a verifier model; writes immutable observations + manifest')
    .option('--corpus <path>', `corpus JSONL path (default: ${DEFAULT_A0_CORPUS})`)
    .option('--prompt <path>', `verifier prompt file bound into the run manifest (default: ${DEFAULT_A0_PROMPT})`)
    .option('--model <id>', 'verifier model id recorded in the manifest (default: ARK_MODEL / ARK_VERIFIER_MODEL)')
    .option('--out <dir>', 'output directory for observations.jsonl and its manifest', 'data/a0/run')
    .option('--json', 'print the versioned JSON result')
    .allowExcessArguments(false)
    .action(async (options: { corpus?: string; prompt?: string; model?: string; out: string; json?: boolean }) => {
      try {
        const envFile = join(extracted.cwd, '.env');
        if (existsSync(envFile)) process.loadEnvFile(envFile);
        const promptPath = options.prompt ?? DEFAULT_A0_PROMPT;
        const { result, exitCode } = await runA0Command({
          cwd: extracted.cwd,
          corpusPath: options.corpus ?? DEFAULT_A0_CORPUS,
          promptPath,
          outputDir: resolve(extracted.cwd, options.out),
          model: options.model ?? process.env.ARK_VERIFIER_MODEL,
        });
        if (options.json) {
          console.log(JSON.stringify({
            schemaVersion: 1,
            authority: A0_AUTHORITY,
            mode: 'run',
            observationsPath: safeInline(result.observationsPath),
            manifestPath: safeInline(result.manifestPath),
            manifest: sanitizeA0Manifest(result.manifest),
            report: result.report,
            parseFailures: result.parseFailures.map(safeInline),
          }, null, 2));
        } else {
          process.stdout.write(formatA0RunResult(result));
        }
        setExit(exitCode);
      } catch (err) {
        console.error(`[a0] ${safeInline(err instanceof Error ? err.message : String(err))}`);
        setExit(a0CommandErrorExitCode(err));
      }
    });
  a0
    .command('report')
    .description('replay recorded observations through the pure report; verifies the run manifest when present')
    .requiredOption('--observations <path>', 'observations JSONL written by a0 run')
    .option('--corpus <path>', `corpus JSONL path (default: ${DEFAULT_A0_CORPUS})`)
    .option('--json', 'print the versioned JSON result')
    .allowExcessArguments(false)
    .action(async (options: { observations: string; corpus?: string; json?: boolean }) => {
      try {
        const { result, exitCode } = await reportA0Command({
          cwd: extracted.cwd,
          corpusPath: options.corpus ?? DEFAULT_A0_CORPUS,
          observationsPath: options.observations,
        });
        if (options.json) {
          console.log(JSON.stringify({
            schemaVersion: 1,
            authority: A0_AUTHORITY,
            mode: 'report',
            report: result.report,
            manifest: result.manifest === null ? null : sanitizeA0Manifest(result.manifest),
            provenanceIssues: result.provenanceIssues.map(safeInline),
          }, null, 2));
        } else {
          process.stdout.write(formatA0ReportResult(result));
        }
        setExit(exitCode);
      } catch (err) {
        console.error(`[a0] ${safeInline(err instanceof Error ? err.message : String(err))}`);
        setExit(a0CommandErrorExitCode(err));
      }
    });

  program.hook('preAction', (_command, actionCommand) => {
    if (extracted.noTui && !['jarvis', 'run', 'resume'].includes(actionCommand.name())) {
      console.error('[jarvis] --no-tui is supported only for run and resume');
      throw new CommanderError(CLI_EXIT.USAGE, 'jarvis.noTuiUnsupported', '--no-tui unsupported for this command');
    }
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

function formatFileRewindPreview(prepared: PreparedFileRewind): string {
  const visible = prepared.restore.changedPaths.slice(0, 50);
  const lines = [
    'File rewind preview (completion authority: none)',
    `checkpoint: ${safeCheckpointInline(prepared.conversation.checkpointId)}`,
    `target shadow ref: ${safeCheckpointInline(prepared.restore.targetRef)}`,
    `preflight ref: ${safeCheckpointInline(prepared.restore.preflightRef)}`,
    `changed paths: ${prepared.restore.changedPaths.length}`,
    ...visible.map((path) => `  ${safeCheckpointInline(path)}`),
  ];
  if (prepared.restore.changedPaths.length > visible.length) {
    lines.push(`  ... ${prepared.restore.changedPaths.length - visible.length} more path(s)`);
  }
  lines.push(
    `after-checkpoint effects: managed-writes=${prepared.conversation.afterCheckpoint.managedFileWrites}`
      + ` external=${prepared.conversation.afterCheckpoint.external}`,
    'External effects cannot be rewound. Type allow-once to apply this exact file restore.',
    '',
  );
  return lines.join('\n');
}

async function askFileRewindApproval(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('allow-once> ');
    return answer.trim() === 'allow-once';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function safeCheckpointInline(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return safeInline(text).slice(0, 1_024);
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

export function extractGlobalCwd(
  argv: string[],
  baseCwd: string,
): { argv: string[]; cwd: string; headless: boolean; noTui: boolean; config: ConfigCliOptions } {
  const rest: string[] = [];
  let selected: string | undefined;
  let headless = false;
  let noTui = false;
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
    if (arg === '--no-tui') {
      if (noTui) throw new Error('--no-tui may only be supplied once');
      noTui = true;
      continue;
    }
    rest.push(arg);
  }
  const config = extractConfigCliOptions(rest);
  return { argv: config.argv, cwd: resolve(baseCwd, selected ?? '.'), headless, noTui, config: config.options };
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
const CONFIG_TARGETS = new Set<ForwardTarget>(['index', 'goal-cli', 'loop-cli']);

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
