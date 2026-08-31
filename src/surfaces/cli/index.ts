/**
 * surfaces/cli — the terminal entry point (A4).
 *
 * Composition root: read config, build the provider + tools + context manager, and hand them
 * to the {@link startRepl} shell. commander gives `--help` / `--version` and a place for
 * future options without bloating the REPL itself. The REPL subscribes to the EventBus and
 * renders the stream — exactly the "add a surface = add a subscriber" path A1 wired.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Command } from 'commander';
import {
  DefaultContextManager,
  assertKeyNotInLaunchEnv,
  buildDefaultRegistry,
  createBashTool,
  createProvider,
  createVisionComplete,
  createVisionTool,
  defaultShellPath,
  loadDoubaoConfig,
  resolveVisionConfig,
  scrubProviderKeyFromEnv,
  type Message,
} from '../../core/index.js';
import {
  SkillRegistry,
  SKILL_REGISTRY_ADDENDUM_SOURCE,
  ShadowGit,
  delegateToolSchema,
  loadRoster,
  loadRuleLayers,
  resolveHooks,
  type ReadText,
} from '../../capabilities/index.js';
import {
  createSessionComposition,
  createHistorySearchTool,
  createHistoryTurnTool,
  buildConfigPermissionPolicy,
  FileCheckpointAuditStore,
  FileSessionStore,
  latestSessionPath,
  resolveSessionFilePath,
  SessionCompositionMismatchError,
  SessionCheckpointRecorder,
  type SessionFileResolution,
} from '../../runtime/index.js';
import { safeInline } from './approval.js';
import { extractConfigCliOptions, type ConfigCliOptions } from './config-options.js';
import {
  appendConfigPermissionBoundary,
  loadCliConfig,
  reportConfigWarnings,
} from './config.js';
import { loadResumeSessionForCli } from './repl-resume.js';
import { startRepl } from './repl.js';
import { buildSystemPrompt } from './system-prompt.js';
import { JARVIS_VERSION } from './package-info.js';
import { CLI_EXIT } from './exit-codes.js';
import {
  createProcessAgentEventWriter,
  isHeadlessAgentEventMode,
  scrubHeadlessAgentEventEnv,
} from './headless-events.js';
import { selectCliSurface } from './tui-surface.js';
import { canConstructTuiHost } from './tui-host.js';
import { startTuiRepl } from './tui-repl.js';

// Capture BEFORE the runtime .env load: a key here came from the shell LAUNCH env (in /proc/environ on
// Linux); one appearing only after came from .env (runtime, /proc-clean). Used by assertKeyNotInLaunchEnv.
const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;
// JARVIS_HOOKS is a TRUSTED, launch-controlled source: capture it BEFORE loading .env so an in-repo
// .env (attacker-authored on an untrusted repo) can't set it and enable repo-authored hook commands.
const JARVIS_HOOKS_LAUNCH = process.env.JARVIS_HOOKS;
// tsx does not auto-load .env; mirror the demos so `npm run dev` works from a .env too.
if (existsSync('.env')) process.loadEnvFile('.env');

/** Tokens held back from the window for the model's reply when deciding to compact. These models'
 *  absolute max output is huge (384K on the DeepSeek-V4 default, 128K on Doubao); reserving a
 *  realistic reply size lets a session actually USE the window before compaction kicks in. */
const OUTPUT_RESERVE_TOKENS = 16_384;
const DEFAULT_RUN_MAX_TURNS = 24;
const INSPECT_RUN_MAX_TURNS = 8;
let entryConfigOptions: ConfigCliOptions = { strict: false, ignoreUser: false };

const program = new Command();

program
  .name('jarvis')
  .description('Jarvis-Agent interactive coding-agent session.')
  .version(JARVIS_VERSION)
  .option('--cwd <dir>', 'base directory tool paths resolve against', process.cwd())
  .option('--max-turns <n>', 'max model turns per message', (v) => Number.parseInt(v, 10))
  .option('--resume [id]', 'resume the latest session (or a specific <id>) from data/sessions/')
  .option('--no-recall', 'disable current-session history_search/history_turn tools')
  .option('--no-tui', 'force the line REPL even when stdin/stdout are TTYs')
  .option('--strict-config', 'reject unknown typed-config keys')
  .option('--ignore-user-config', 'skip the user config file')
  .option('--preset <inspect|safe>', 'apply a built-in permission preset')
  .option('--safe', 'shorthand for --preset safe')
  .option('--model <id>', 'override the non-secret builder model id')
  .option('--base-url <url>', 'override the non-secret provider endpoint')
  .option('-p, --prompt <text>', 'run this prompt before entering interactive input')
  .action(async (opts: {
    cwd: string;
    maxTurns?: number;
    resume?: string | boolean;
    recall: boolean;
    tui: boolean;
    prompt?: string;
  }) => {
    const headless = isHeadlessAgentEventMode();
    // The renderer adapter is now constructible whenever the TTY pair holds (contract §5: TTY +
    // registered adapter selects TUI; --no-tui / non-TTY / headless still fall back to line/machine).
    const surface = selectCliSurface({
      headless,
      noTui: !opts.tui,
      inputIsTTY: process.stdin.isTTY === true,
      outputIsTTY: process.stdout.isTTY === true,
      rendererAvailable: opts.tui && canConstructTuiHost(process.stdin, process.stdout),
    });
    if (surface.reason === 'renderer-unavailable') {
      console.error('[tui] renderer unavailable; using the line REPL');
    }
    if (headless && !opts.prompt?.trim()) {
      console.error('[run] --headless requires a non-empty prompt');
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }
    const sessionsDir = join(opts.cwd, 'data', 'sessions');
    let resumeFile: Extract<SessionFileResolution, { status: 'ok' }> | undefined;
    if (opts.resume) {
      let requestedId: string;
      if (typeof opts.resume === 'string') {
        requestedId = opts.resume;
      } else {
        let latest: string | null;
        try {
          latest = await latestSessionPath(sessionsDir);
        } catch (err) {
          console.error(`[resume] cannot inspect data/sessions: ${safeInline(err instanceof Error ? err.message : String(err))}`);
          process.exitCode = CLI_EXIT.STATE_CORRUPT;
          return;
        }
        if (latest === null) {
          console.error('没有可恢复的会话(data/sessions/ 为空)。');
          process.exitCode = CLI_EXIT.USAGE;
          return;
        }
        requestedId = basename(latest, '.jsonl');
      }

      let resolution;
      try {
        resolution = await resolveSessionFilePath({ cwd: opts.cwd, sessionId: requestedId });
      } catch (err) {
        console.error(`[resume] cannot resolve session path: ${safeInline(err instanceof Error ? err.message : String(err))}`);
        process.exitCode = CLI_EXIT.STATE_CORRUPT;
        return;
      }
      if (resolution.status === 'invalid-session-id') {
        console.error(`[resume] ${safeInline(resolution.reason)}`);
        process.exitCode = CLI_EXIT.USAGE;
        return;
      }
      if (resolution.status === 'not-found') {
        console.error(`[resume] session not found: ${safeInline(resolution.sessionId)} (expected ${safeInline(resolution.path)})`);
        process.exitCode = CLI_EXIT.USAGE;
        return;
      }
      if (resolution.status !== 'ok') {
        console.error(`[resume] ${safeInline(resolution.reason)} (${safeInline(resolution.path)})`);
        process.exitCode = CLI_EXIT.STATE_CORRUPT;
        return;
      }
      resumeFile = resolution;
    }
    const sessionId = resumeFile?.sessionId ?? new Date().toISOString().replace(/[:.]/g, '-');

    let effectiveConfig;
    try {
      effectiveConfig = await loadCliConfig({ cwd: opts.cwd, options: entryConfigOptions });
      reportConfigWarnings(effectiveConfig);
    } catch (err) {
      console.error(`[config] ${safeInline(err instanceof Error ? err.message : String(err))}`);
      process.exitCode = CLI_EXIT.STATE_CORRUPT;
      return;
    }

    let config;
    try {
      assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV); // /proc safety: refuse a launch-env key on Linux
      config = loadDoubaoConfig(process.env, {
        model: effectiveConfig.model,
        baseURL: effectiveConfig.baseURL,
      });
    } catch (err) {
      console.error(safeInline(err instanceof Error ? err.message : String(err)));
      process.exitCode = CLI_EXIT.USAGE;
      return;
    }

    const inspectMode = effectiveConfig.preset === 'inspect';
    const maxTurns = opts.maxTurns ?? (inspectMode ? INSPECT_RUN_MAX_TURNS : DEFAULT_RUN_MAX_TURNS);

    // ARK's DeepSeek V4 GA tool mode leaks planning text into `content` when thinking is disabled;
    // enabled mode returns a separate reasoning field that the loop already keeps off the UI stream.
    const thinking = inspectMode && config.model.startsWith('deepseek-v4-') ? 'high' : 'off';
    const provider = createProvider(config).withThinking(thinking);
    // The provider captured the key; remove it from the env so the model-facing bash can't read it back
    // via /proc/<pid>/environ (Linux). Done before registering bash below.
    scrubProviderKeyFromEnv();
    // Inspect narrows the MODEL-FACING surface before planning. The PermissionGate remains the
    // execution backstop, but denied tools do not consume model turns merely to be refused.
    const tools = inspectMode
      ? buildDefaultRegistry().subset(['read', 'grep'])
      : buildDefaultRegistry();
    if (!inspectMode) {
      // bash is safe to register here because the REPL always runs it behind the PermissionGate (B4).
      tools.register(createBashTool());
      if (opts.recall) {
        const historySource = { cwd: opts.cwd, sessionId };
        tools.register(createHistorySearchTool(historySource));
        tools.register(createHistoryTurnTool(historySource));
      }
      // Vision (Phase E multimodal): register only when configured and inspect has not removed network.
      const vision = resolveVisionConfig(process.env, config);
      if (vision.enabled) tools.register(createVisionTool(createVisionComplete(vision.config)));
    }
    const context = new DefaultContextManager({
      summarizer: provider,
      maxContextTokens: provider.capability.maxContextTokens,
      maxOutputTokens: OUTPUT_RESERVE_TOKENS,
    });
    const skills = await SkillRegistry.load(join(opts.cwd, 'skills'));
    const dynamicAddendum = {
      source: SKILL_REGISTRY_ADDENDUM_SOURCE,
      manifest: skills.list(),
    } as const;
    // Inspect keeps evidence gathering in the parent so a blocking task cannot consume the whole
    // wall-clock budget and return no partial evidence. Other modes retain the existing roster.
    const roster = inspectMode ? [] : await loadRoster(join(opts.cwd, 'agents'));
    const toolSchemas = [
      ...tools.schemasForModel(),
      ...(roster.length > 0 ? [delegateToolSchema(roster)] : []),
    ];
    const systemPrompt = appendConfigPermissionBoundary(
      buildSystemPrompt(toolSchemas.map((schema) => schema.name), { inspect: inspectMode }),
      effectiveConfig,
    );

    // B5: merge project-level rule layers into the gate policy. The global ~/AGENTS.md layer is
    // intentionally NOT auto-loaded — pulling private cross-tool config into enforcement should be
    // explicit. With no allow/deny frontmatter present, rules are empty and the gate is unchanged.
    const readText: ReadText = async (p) => {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return null;
      }
    };
    const resolved = await loadRuleLayers(
      [join(opts.cwd, 'AGENTS.md'), join(opts.cwd, '.rules', 'AGENTS.md')],
      readText,
    );
    const policy = buildConfigPermissionPolicy(effectiveConfig, resolved.rules);

    // Hooks: trusted sources only — user-home default first, then launch-captured JARVIS_HOOKS.
    // Every source is realpath-canonicalized and refused if it lands inside cwd.
    const { hooks, warning: hookWarning } = await resolveHooks({
      hooksPath: JARVIS_HOOKS_LAUNCH,
      cwd: opts.cwd,
      shellPath: defaultShellPath(),
    });
    if (hookWarning) console.error(`[hooks] ${safeInline(hookWarning)}`);

    // Persistence: resume a prior session, or start (and log) a new one.
    const sessionComposition = createSessionComposition({
      root: 'repl',
      runtimeVersion: JARVIS_VERSION,
      permissionMode: headless ? 'unattended' : 'interactive',
      toolSchemas,
      systemPrompt,
      dynamicAddendum,
    });
    let store: FileSessionStore;
    let sessionPath: string;
    let checkpointEligible = true;
    let resumed = false;
    let initialMessages: Message[] | undefined;
    if (resumeFile !== undefined) {
      const { path, sessionId: resolvedSessionId } = resumeFile;
      resumed = true;
      const loadResult = await loadResumeSessionForCli(resumeFile, {
        requireHeader: true,
        expectedSessionId: resolvedSessionId,
        resume: {
          expectedComposition: sessionComposition,
          resolveDynamicAddendum: (activationText) => skills.systemAddendum(activationText),
        },
      });
      if (loadResult.status === 'not-found') {
        console.error(`[resume] session not found: ${safeInline(loadResult.sessionId)} (expected ${safeInline(loadResult.path)})`);
        process.exitCode = loadResult.exitCode;
        return;
      }
      if (loadResult.status === 'failed') {
        const error = loadResult.error;
        const recallHint = opts.recall
          && error instanceof SessionCompositionMismatchError
          && error.differences.length > 0
          && error.differences.every(({ field }) => field === 'toolsetHash' || field === 'systemPromptHash')
          ? ' If this session predates Recall, retry with --no-recall; otherwise restore the recorded sources.'
          : '';
        console.error(`[resume] ${safeInline(error instanceof Error ? error.message : String(error))}${recallHint}`);
        process.exitCode = loadResult.exitCode;
        return;
      }
      const loaded = loadResult.loaded;
      if (loaded.pendingTools.length > 0) {
        const pending = loaded.pendingTools[0];
        console.error(
          `[resume] session has ${loaded.pendingTools.length} unresolved tool execution(s); ` +
          `first=${safeInline(pending.toolName)}/${safeInline(pending.callId)} reason=${pending.reason}. `
            + 'Inspect the workspace before continuing.',
        );
        process.exitCode = CLI_EXIT.NEEDS_HUMAN;
        return;
      }
      if (loaded.header?.model !== config.model || loaded.header.cwd !== opts.cwd) {
        console.error('[resume] session model/cwd differs from the current invocation; fork or restore the original composition.');
        process.exitCode = CLI_EXIT.NEEDS_HUMAN;
        return;
      }
      if ('schemaVersion' in loaded.header) {
        console.log(
          `[resume] compatibility: exact; dynamic composition matched: ${safeInline(sessionComposition.dynamicAddendumSource ?? '-')}`
            + ` ${safeInline(sessionComposition.dynamicAddendumManifestHash ?? '-')} (${loaded.requests.length} request receipt(s))`,
        );
      } else {
        console.error('[resume] legacy v1 session: tool-receipt and composition coverage are unavailable.');
      }
      initialMessages = loaded.messages;
      sessionPath = path;
      checkpointEligible = loaded.format === 'v2';
      store = new FileSessionStore(path, loaded.messages.length, {
        format: loaded.format,
        initialSequence: loaded.lastSequence,
      });
      console.log(`已恢复会话 ${safeInline(loaded.header?.id ?? path)}(${loaded.messages.length} 条消息)\n`);
    } else {
      sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
      store = new FileSessionStore(sessionPath);
      await store.writeHeader({
        id: sessionId,
        model: config.model,
        cwd: opts.cwd,
        startedAt: new Date().toISOString(),
        composition: sessionComposition,
      });
    }

    const checkpoints = checkpointEligible
      ? new SessionCheckpointRecorder({
          cwd: opts.cwd,
          sessionId,
          sessionPath,
          auditStore: new FileCheckpointAuditStore({ cwd: opts.cwd, sessionId }),
          shadow: new ShadowGit({
            shellPath: defaultShellPath(),
            cwd: opts.cwd,
            gitDir: join(opts.cwd, 'data', 'checkpoint-shadow', sessionId),
          }),
        })
      : undefined;

    const agentEvents = createProcessAgentEventWriter({
      invocationId: sessionId,
      defaultSessionId: sessionId,
      root: 'run',
      cwd: opts.cwd,
    });
    if (headless) scrubHeadlessAgentEventEnv();
    agentEvents?.sessionStarted({ sessionId, resumed, model: config.model });
    // Surface split: both kinds share the SAME host responsibilities below (approval gate,
    // checkpoints, recall tools, Session persistence, agent-event projection); only the input/
    // rendering layer differs — the TUI drives prompts through the frozen reducer + terminal
    // adapter (tui-repl.ts), the line REPL through readline (repl.ts).
    const replCommon = {
      model: provider,
      tools,
      context,
      skills,
      roster,
      cwd: opts.cwd,
      modelName: config.model,
      // Precomputed from the same final schemas hashed into the session composition.
      systemPrompt,
      maxTurns,
      policy,
      hooks,
      store,
      checkpoints,
      sessionId,
      initialMessages,
      initialPrompt: opts.prompt,
      agentEvents,
    };
    const exitCode = surface.kind === 'tui'
      ? await startTuiRepl({
          ...replCommon,
          input: process.stdin,
          output: process.stdout,
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
        })
      : await startRepl({
          ...replCommon,
          singlePrompt: headless,
          ...(headless ? { approver: async () => 'deny' as const } : {}),
        });
    if (exitCode !== undefined) process.exitCode = exitCode;
  });

try {
  const extractedConfig = extractConfigCliOptions(process.argv.slice(2));
  entryConfigOptions = extractedConfig.options;
  program.parseAsync(['node', 'jarvis', ...extractedConfig.argv]).catch((err: unknown) => {
    console.error('[cli] fatal:', safeInline(err instanceof Error ? err.message : String(err)));
    process.exitCode = CLI_EXIT.RUNTIME;
  });
} catch (err) {
  console.error(`[config] ${safeInline(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = CLI_EXIT.USAGE;
}
