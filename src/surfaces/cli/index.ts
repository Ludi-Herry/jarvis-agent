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
  buildDefaultRegistry,
  createBashTool,
  createProvider,
  loadDoubaoConfig,
  type Message,
} from '../../core/index.js';
import { SkillRegistry, loadRuleLayers, type ReadText } from '../../capabilities/index.js';
import {
  defaultPolicy,
  FileSessionStore,
  loadSession,
  latestSessionPath,
} from '../../runtime/index.js';
import { startRepl } from './repl.js';

// tsx does not auto-load .env; mirror the demos so `npm run dev` works from a .env too.
if (existsSync('.env')) process.loadEnvFile('.env');

/** Tokens held back from the window for the model's reply when deciding to compact. The
 *  256K-context model's absolute max output is huge; reserving a realistic reply size lets
 *  a session actually USE the window before compaction kicks in. */
const OUTPUT_RESERVE_TOKENS = 16_384;

const SYSTEM_PROMPT = [
  '你是一个在终端里运行的编码助手。你可以调用这些工具:',
  'read(读文件)、write(写文件)、grep(按正则搜内容)、bash(运行 shell 命令)。',
  '路径都相对当前工作目录。回答需要文件内容时先调用工具读取,再据此作答;',
  '需要构建/测试/查看 git 等用 bash。危险或涉及密钥的操作会被权限闸门拦下或需用户批准——',
  '被拒绝时如实说明,不要绕过。不要编造文件内容。回答简洁。',
].join('\n');

const program = new Command();

program
  .name('jarvis-agent')
  .description('Jarvis-Agent — a minimal coding agent in the terminal (Phase A).')
  .version('0.0.0')
  .option('--cwd <dir>', 'base directory tool paths resolve against', process.cwd())
  .option('--max-turns <n>', 'max model turns per message', (v) => Number.parseInt(v, 10), 24)
  .option('--resume [id]', 'resume the latest session (or a specific <id>) from data/sessions/')
  .action(async (opts: { cwd: string; maxTurns: number; resume?: string | boolean }) => {
    let config;
    try {
      config = loadDoubaoConfig();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    // Thinking off keeps the tool loop clean and avoids hidden reasoning-token cost.
    const provider = createProvider(config).withThinking('off');
    // bash is safe to register here because the REPL always runs it behind the PermissionGate (B4).
    const tools = buildDefaultRegistry();
    tools.register(createBashTool());
    const context = new DefaultContextManager({
      summarizer: provider,
      maxContextTokens: provider.capability.maxContextTokens,
      maxOutputTokens: OUTPUT_RESERVE_TOKENS,
    });
    const skills = await SkillRegistry.load('skills');

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

    // Persistence: resume a prior session, or start (and log) a new one.
    const sessionsDir = join(opts.cwd, 'data', 'sessions');
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
      const loaded = await loadSession(path);
      initialMessages = loaded.messages;
      store = new FileSessionStore(path, loaded.messages.length);
      console.log(`已恢复会话 ${loaded.header?.id ?? path}(${loaded.messages.length} 条消息)\n`);
    } else {
      const id = new Date().toISOString().replace(/[:.]/g, '-');
      store = new FileSessionStore(join(sessionsDir, `${id}.jsonl`));
      await store.writeHeader({ id, model: config.model, cwd: opts.cwd, startedAt: new Date().toISOString() });
    }

    await startRepl({
      model: provider,
      tools,
      context,
      skills,
      cwd: opts.cwd,
      modelName: config.model,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: opts.maxTurns,
      policy,
      store,
      initialMessages,
    });
  });

program.parseAsync().catch((err: unknown) => {
  console.error('[cli] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
