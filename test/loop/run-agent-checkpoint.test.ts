import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../src/runtime/event-bus.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { runAgent } from '../../src/core/loop/run-agent.js';
import type { Message } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';
import type { SessionStore } from '../../src/runtime/session/index.js';

describe('runAgent checkpoint boundary', () => {
  it('runs the checkpoint only after durable sync and before provider I/O', async () => {
    const order: string[] = [];
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    const store: SessionStore = {
      sync: async (value) => {
        expect(value).toBe(messages);
        order.push('sync');
      },
      checkpoint: async () => undefined,
    };
    const provider = finalProvider(() => order.push('provider'));

    await runAgent({
      model: provider,
      tools: new InMemoryToolRegistry(),
      bus: new InMemoryEventBus(),
      messages,
      toolCtx: { cwd: process.cwd() },
      budget: { maxTurns: 1 },
      store,
      beforeModelWave: async (value) => {
        expect(value).toBe(messages);
        order.push('checkpoint');
      },
    });

    expect(order.slice(0, 3)).toEqual(['sync', 'checkpoint', 'provider']);
  });

  it('refuses provider I/O when the checkpoint audit fails', async () => {
    let providerCalls = 0;
    const provider = finalProvider(() => providerCalls++);

    await expect(runAgent({
      model: provider,
      tools: new InMemoryToolRegistry(),
      bus: new InMemoryEventBus(),
      messages: [{ role: 'user', content: 'must not send' }],
      toolCtx: { cwd: process.cwd() },
      budget: { maxTurns: 1 },
      beforeModelWave: async () => {
        throw new Error('checkpoint audit failed');
      },
    })).rejects.toThrow(/checkpoint audit failed/u);
    expect(providerCalls).toBe(0);
  });
});

function finalProvider(onCall: () => void): ModelProvider {
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      onCall();
      yield { type: 'text', text: 'done' };
      return {
        text: 'done',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}
