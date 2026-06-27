/**
 * A3 milestone demo — "it can compact".
 *
 * Proves the ContextManager end-to-end against REAL Doubao: we seed an ongoing conversation,
 * give the manager a deliberately TINY window budget (so a short demo trips the 83% threshold
 * a real session would only hit after thousands of tokens), then ask a question that needs a
 * tool. After the tool turn the loop compacts — Doubao itself writes the structured summary,
 * the old chatter collapses into it, the tool call/result group is preserved, and the
 * conversation continues to a correct answer. This is the §5.2 acceptance, live.
 *
 * Run:  npm run demo:a3   (needs ARK_API_KEY in the environment)
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultContextManager,
  SUMMARY_MARKER,
  buildDefaultRegistry,
  createProvider,
  loadDoubaoConfig,
  runAgent,
  type Message,
} from '../src/core/index.js';
import { InMemoryEventBus, type Event } from '../src/runtime/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const FACT = '项目的幸运数字是 4724。';
const QUESTION = '读取当前目录下的 fact.txt，告诉我项目的幸运数字是多少。';

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  const provider = createProvider(config).withThinking('off');
  const tools = buildDefaultRegistry();

  // Deliberately tiny budget: any real prompt (~700 tokens) dwarfs an effective budget of
  // 150, so compaction fires after the first tool turn instead of after a huge session.
  const context = new DefaultContextManager({
    summarizer: provider,
    maxContextTokens: 200,
    maxOutputTokens: 50,
    keepRecent: 2,
  });

  const dir = await mkdtemp(join(tmpdir(), 'a3-demo-'));
  await writeFile(join(dir, 'fact.txt'), FACT, 'utf8');

  let compacted = false;
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
        process.stdout.write(`[tool_result] ${preview(e.out.content)}\n`);
        break;
      case 'state':
        if (e.phase === 'compacting') {
          compacted = true;
          process.stdout.write(`\n[state] compacting…\n`);
        }
        break;
      case 'final':
        process.stdout.write(`\n[final] ${e.text}\n`);
        break;
      default:
        break;
    }
  });

  // An ongoing session: a few exchanges of chatter, then the real question. The chatter is
  // what gets summarized away; the question + tool turn stay in the verbatim tail.
  const messages: Message[] = [
    { role: 'system', content: '你是一个能调用文件工具（read/write/grep）的助手，回答需要文件内容时先调用工具。' },
    { role: 'user', content: '我们在做一个 agent-harness 项目。' },
    { role: 'assistant', content: '好的，我了解了。' },
    { role: 'user', content: 'A1 阶段做了 ModelProvider，A2 做了工具循环。' },
    { role: 'assistant', content: '明白，进度已记下。' },
    { role: 'user', content: QUESTION },
  ];

  console.log(`model: ${config.model}`);
  console.log(`seeded messages: ${messages.length}`);
  console.log(`planted fact.txt: ${FACT}`);
  console.log('--- running (compaction will fire after the tool turn) ---');

  try {
    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 6 },
      context,
    });

    const summaryMsg = messages.find(
      (m): m is Extract<Message, { role: 'user' }> =>
        m.role === 'user' && m.content.startsWith(SUMMARY_MARKER),
    );

    console.log('\n--- compaction result ---');
    console.log(`compacting event fired: ${compacted}`);
    console.log(`messages after: ${messages.length} (was 6 + this run's turns)`);
    console.log(`tool group intact: ${toolGroupIntact(messages)}`);
    if (summaryMsg) {
      console.log('\n--- Doubao-written summary now in context ---');
      console.log(summaryMsg.content);
    }
    console.log('\n--- outcome ---');
    console.log(JSON.stringify(outcome, null, 2));

    // Objective close-out: compaction really happened AND the answer still used the file fact.
    const ok = compacted && Boolean(summaryMsg) && (outcome.finalText?.includes('4724') ?? false);
    console.log(`\nA3 closed loop (compacted + summary in context + answer correct): ${ok}`);
    if (!ok) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** True if every tool message is immediately preceded by an assistant that made tool calls —
 *  i.e. compaction never tore a result from its call. */
function toolGroupIntact(messages: Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      const prev = messages[i - 1];
      if (!prev || prev.role !== 'assistant' || !prev.toolCalls?.length) return false;
    }
  }
  return true;
}

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
