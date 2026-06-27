/**
 * A2 milestone demo — "it can act".
 *
 * Proves the tool loop end-to-end against the REAL Doubao endpoint: we plant a fact in a
 * file the model has never seen, then ask a question it can ONLY answer by reading that
 * file. The model decides on its own to call `read`, the loop runs the real tool, feeds the
 * content back, and the model answers from it. This is the §5.1 acceptance check — a tool
 * actually ran, its result round-tripped, and the answer used the file's content.
 *
 * Everything streams through the EventBus (the day-1 path a CLI/GUI subscribes to): you see
 * the model's text, its tool_call, the tool_result, usage, and the final answer live.
 *
 * Run:  npm run demo:a2   (needs ARK_API_KEY in the environment)
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDefaultRegistry,
  createProvider,
  loadDoubaoConfig,
  runAgent,
  type Message,
} from '../src/core/index.js';
import { InMemoryEventBus, type Event } from '../src/runtime/index.js';

// Match a1-demo: tsx does not auto-load .env, so load it ourselves if present (Node >=20.12).
if (existsSync('.env')) process.loadEnvFile('.env');

const FACT = '项目代号是 Hanako，幸运数字是 4724。';
const QUESTION = '读取当前目录下的 fact.txt，然后告诉我项目代号和幸运数字分别是什么。';

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  // Thinking off keeps the tool loop clean and avoids paying hidden reasoning tokens.
  const provider = createProvider(config).withThinking('off');
  const tools = buildDefaultRegistry();

  // Plant the fact in a scratch dir the model can't have memorized; that dir is the tool cwd.
  const dir = await mkdtemp(join(tmpdir(), 'a2-demo-'));
  await writeFile(join(dir, 'fact.txt'), FACT, 'utf8');

  const bus = new InMemoryEventBus();
  bus.subscribe((e: Event) => {
    switch (e.type) {
      case 'message_delta':
        process.stdout.write(e.text);
        break;
      case 'tool_call':
        process.stdout.write(`\n[tool_call] ${e.call.name}(${e.call.arguments})\n`);
        break;
      case 'tool_result':
        process.stdout.write(
          `[tool_result] ${e.out.error ? `ERROR: ${e.out.error}` : preview(e.out.content)}\n`,
        );
        break;
      case 'usage':
        process.stdout.write(`\n[usage] input=${e.inputTokens} output=${e.outputTokens}\n`);
        break;
      case 'final':
        process.stdout.write(`\n[final] ${e.text}\n`);
        break;
      case 'halt':
        process.stdout.write(`\n[halt] ${e.reason}\n`);
        break;
      default:
        break;
    }
  });

  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是一个能调用文件工具（read/write/grep）的助手。当回答需要文件内容时，先调用工具读取，再据此回答。',
    },
    { role: 'user', content: QUESTION },
  ];

  console.log(`model: ${config.model}`);
  console.log(`tools: ${tools.schemasForModel().map((t) => t.name).join(', ')}`);
  console.log(`planted fact.txt: ${FACT}`);
  console.log(`prompt: ${QUESTION}\n--- running ---`);

  try {
    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 6 },
    });

    console.log('\n--- outcome ---');
    console.log(JSON.stringify(outcome, null, 2));

    // Objective close-loop assertion (not "looks right"): the answer must contain the lucky
    // number that lived ONLY in the file, proving the tool result actually reached the model.
    const usedFile = outcome.finalText?.includes('4724') ?? false;
    console.log(`\nclosed loop (final answer contains the file-only fact "4724"): ${usedFile}`);
    if (!usedFile) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
