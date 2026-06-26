/**
 * A1 milestone demo — "it can speak".
 *
 * Asks Doubao one line, streams the answer through the EventBus (the day-1 path a
 * GUI will later subscribe to), and prints the aggregated ModelResult. This is the
 * acceptance check from plan §5 / §3.1: live streaming deltas + a real ModelResult
 * with non-zero usage and a normalized finishReason.
 *
 * Run:  npm run demo:a1   (needs ARK_API_KEY in the environment)
 */
import { existsSync } from 'node:fs';
import { createProvider, loadDoubaoConfig } from '../src/core/index.js';
import { InMemoryEventBus, type Event } from '../src/runtime/index.js';

// Make the documented setup path real: if a .env file exists, load it before reading
// config. `npm run demo:a1` runs via tsx, which does NOT auto-load .env. (Node >=20.12)
if (existsSync('.env')) process.loadEnvFile('.env');

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  // Thinking off so the tool loop stays clean and we don't pay hidden reasoning tokens.
  const provider = createProvider(config).withThinking('off');

  const bus = new InMemoryEventBus();
  bus.subscribe((e: Event) => {
    switch (e.type) {
      case 'message_delta':
        process.stdout.write(e.text);
        break;
      case 'usage':
        process.stdout.write(`\n\n[usage] input=${e.inputTokens} output=${e.outputTokens}\n`);
        break;
      case 'final':
        process.stdout.write(`[final] ${e.text.length} chars\n`);
        break;
      default:
        break;
    }
  });

  console.log(`model: ${config.model}`);
  console.log('prompt: 用一句话介绍你自己。\n--- streaming ---');

  // The AgentLoop (A2) will own this translation; here the demo plays that role:
  // provider deltas -> EventBus events.
  const gen = provider.call([{ role: 'user', content: '用一句话介绍你自己。' }], []);
  let next = await gen.next();
  while (!next.done) {
    const delta = next.value;
    if (delta.type === 'text') bus.emit({ type: 'message_delta', text: delta.text });
    next = await gen.next();
  }
  const result = next.value;

  bus.emit({
    type: 'usage',
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });
  bus.emit({ type: 'final', text: result.text });

  console.log('--- aggregated ModelResult ---');
  console.log(
    JSON.stringify(
      {
        textPreview: result.text.slice(0, 80),
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason,
        usage: result.usage,
        toolCalls: result.toolCalls.length,
        hasReasoning: result.reasoning !== undefined,
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
