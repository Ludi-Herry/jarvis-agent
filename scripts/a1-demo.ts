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
import { createProvider, loadDoubaoConfig } from '../src/core/index.js';
import { InMemoryEventBus, type AnyEvent } from '../src/runtime/index.js';

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  // Thinking off so the tool loop stays clean and we don't pay hidden reasoning tokens.
  const provider = createProvider(config).withThinking('off');

  const bus = new InMemoryEventBus();
  bus.subscribe((e: AnyEvent) => {
    switch (e.type) {
      case 'message_delta':
        process.stdout.write(String(e.text));
        break;
      case 'usage':
        process.stdout.write(
          `\n\n[usage] input=${e.inputTokens} output=${e.outputTokens}\n`,
        );
        break;
      case 'final':
        process.stdout.write(`[final] ${String(e.text).length} chars\n`);
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
