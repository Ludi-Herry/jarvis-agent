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
import { join } from 'node:path';
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
  delegateToolSchema,
  loadRoster,
  loadRuleLayers,
  resolveHooks,
  type ReadText,
} from '../../capabilities/index.js';
import {
  createSessionComposition,
  diffSessionComposition,
  defaultPolicy,
  FileSessionStore,
  loadSession,
  latestSessionPath,
} from '../../runtime/index.js';
import { startRepl } from './repl.js';
import { buildSystemPrompt } from './system-prompt.js';
import { JARVIS_VERSION } from './package-info.js';
import { CLI_EXIT } from './exit-codes.js';

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

const program = new Command();

program
  .name('jarvis')
  .description('Jarvis-Agent interactive coding-agent session.')
  .version(JARVIS_VERSION)
  .option('--cwd <dir>', 'base directory tool paths resolve against', process.cwd())
  .option('--max-turns <n>', 'max model turns per message', (v) => Number.parseInt(v, 10), 24)
  .option('--resume [id]', 'resume the latest session (or a specific <id>) from data/sessions/')
  .option('-p, --prompt <text>', 'run this prompt before entering interactive input')
  .action(async (opts: { cwd: string; maxTurns: number; resume?: string | boolean; prompt?: string }) => {
    let config;
    try {
      assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV); // /proc safety: refuse a launch-env key on Linux
      config = loadDoubaoConfig();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    // Thinking off keeps the tool loop clean and avoids hidden reasoning-token cost.
    const provider = createProvider(config).withThinking('off');
    // The provider captured the key; remove it from the env so the model-facing bash can't read it back
    // via /proc/<pid>/environ (Linux). Done before registering bash below.
    scrubProviderKeyFromEnv();
    // bash is safe to register here because the REPL always runs it behind the PermissionGate (B4).
    const tools = buildDefaultRegistry();
    tools.register(createBashTool());
    // Vision (Phase E multimodal): register the `vision` tool ONLY when ARK_VISION_MODEL names a vision
    // model — heterogeneous delegation, a single stateless VLM call returning structured text (the main
    // model stays text-only). Unset → no vision tool (text-only harness), like leg 3 is opt-in.
    const vision = resolveVisionConfig(process.env, config);
    if (vision.enabled) tools.register(createVisionTool(createVisionComplete(vision.config)));
    const context = new DefaultContextManager({
      summarizer: provider,
      maxContextTokens: provider.capability.maxContextTokens,
      maxOutputTokens: OUTPUT_RESERVE_TOKENS,
    });
    const skills = await SkillRegistry.load('skills');
    // Phase C: load agent roles from agents/ (capability-dispatch subagents). Empty → no task tool.
    const roster = await loadRoster(join(opts.cwd, 'agents'));
    const toolSchemas = [
      ...tools.schemasForModel(),
      ...(roster.length > 0 ? [delegateToolSchema(roster)] : []),
    ];
    const systemPrompt = buildSystemPrompt(toolSchemas.map((schema) => schema.name));

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
    const policy = { ...defaultPolicy(), rules: resolved.rules };

    // Hooks: trusted sources only — user-home default first, then launch-captured JARVIS_HOOKS.
    // Every source is realpath-canonicalized and refused if it lands inside cwd.
    const { hooks, warning: hookWarning } = await resolveHooks({
      hooksPath: JARVIS_HOOKS_LAUNCH,
      cwd: opts.cwd,
      shellPath: defaultShellPath(),
    });
    if (hookWarning) console.error(`[hooks] ${hookWarning}`);

    // Persistence: resume a prior session, or start (and log) a new one.
    const sessionsDir = join(opts.cwd, 'data', 'sessions');
    const sessionComposition = createSessionComposition({
      root: 'repl',
      runtimeVersion: JARVIS_VERSION,
      permissionMode: 'interactive',
      toolSchemas,
      systemPrompt,
    });
    let store: FileSessionStore;
    let initialMessages: Message[] | undefined;
    if (opts.resume) {
      const path =
        typeof opts.resume === 'string'
          ? join(sessionsDir, `${opts.resume}.jsonl`)
          : await latestSessionPath(sessionsDir);
      if (path === null) {
        console.error('没有可恢复的会话(data/sessions/ 为空)。');
        process.exitCode = 1;
        return;
      }
      let loaded;
      try {
        loaded = await loadSession(path, { requireHeader: true });
      } catch (err) {
        console.error(`[resume] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = CLI_EXIT.STATE_CORRUPT;
        return;
      }
      if (loaded.pendingTools.length > 0) {
        const pending = loaded.pendingTools[0];
        console.error(
          `[resume] session has ${loaded.pendingTools.length} unresolved tool execution(s); ` +
          `first=${pending.toolName}/${pending.callId} reason=${pending.reason}. Inspect the workspace before continuing.`,
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
        if (loaded.header.composition.coverage !== 'full' || sessionComposition.coverage !== 'full') {
          console.error('[resume] session composition coverage is partial; fork into a fully recorded v2 session before continuing.');
          process.exitCode = CLI_EXIT.NEEDS_HUMAN;
          return;
        }
        const differences = diffSessionComposition(loaded.header.composition, sessionComposition);
        if (differences.length > 0) {
          console.error(`[resume] session composition changed: ${differences.map((item) => `${item.field}=${item.recorded ?? '-'}->${item.current ?? '-'}`).join(', ')}`);
          process.exitCode = CLI_EXIT.NEEDS_HUMAN;
          return;
        }
      } else {
        console.error('[resume] legacy v1 session: tool-receipt and composition coverage are unavailable.');
      }
      initialMessages = loaded.messages;
      store = new FileSessionStore(path, loaded.messages.length, {
        format: loaded.format,
        initialSequence: loaded.lastSequence,
      });
      console.log(`已恢复会话 ${loaded.header?.id ?? path}(${loaded.messages.length} 条消息)\n`);
    } else {
      const id = new Date().toISOString().replace(/[:.]/g, '-');
      store = new FileSessionStore(join(sessionsDir, `${id}.jsonl`));
      await store.writeHeader({
        id,
        model: config.model,
        cwd: opts.cwd,
        startedAt: new Date().toISOString(),
        composition: sessionComposition,
      });
    }

    await startRepl({
      model: provider,
      tools,
      context,
      skills,
      roster,
      cwd: opts.cwd,
      modelName: config.model,
      // Precomputed from the same final schemas hashed into the session composition.
      systemPrompt,
      maxTurns: opts.maxTurns,
      policy,
      hooks,
      store,
      initialMessages,
      initialPrompt: opts.prompt,
    });
  });

program.parseAsync().catch((err: unknown) => {
  console.error('[cli] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
