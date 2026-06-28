/**
 * surfaces/cli — the terminal entry point (A4).
 *
 * Composition root: read config, build the provider + tools + context manager, and hand them
 * to the {@link startRepl} shell. commander gives `--help` / `--version` and a place for
 * future options without bloating the REPL itself. The REPL subscribes to the EventBus and
 * renders the stream — exactly the "add a surface = add a subscriber" path A1 wired.
 */
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import {
  DefaultContextManager,
  buildDefaultRegistry,
  createBashTool,
  createProvider,
  loadDoubaoConfig,
} from '../../core/index.js';
import { SkillRegistry } from '../../capabilities/index.js';
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
  .action(async (opts: { cwd: string; maxTurns: number }) => {
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

    await startRepl({
      model: provider,
      tools,
      context,
      skills,
      cwd: opts.cwd,
      modelName: config.model,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: opts.maxTurns,
    });
  });

program.parseAsync().catch((err: unknown) => {
  console.error('[cli] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
