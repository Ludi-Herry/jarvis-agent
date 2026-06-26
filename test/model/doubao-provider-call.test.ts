import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { DoubaoProvider } from '../../src/core/model/doubao-provider.js';
import type { DoubaoConfig, ModelDelta, ModelResult } from '../../src/core/model/types.js';
import type { StreamChunk } from '../../src/core/model/stream.js';

const config: DoubaoConfig = {
  provider: 'doubao',
  apiKey: 'test-key-not-used-offline',
  model: 'doubao-seed-2-1-pro-260628',
};

/** A fake OpenAI client: chat.completions.create either throws or returns an async
 *  iterable of the given chunks — lets us exercise call() offline via the injected
 *  client seam (no network, no token spend). */
function makeClient(opts: { chunks?: StreamChunk[]; error?: unknown }): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          if (opts.error) throw opts.error;
          const chunks = opts.chunks ?? [];
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  } as unknown as OpenAI;
}

/** Drive the generator to completion: collect yielded deltas + the returned result. */
async function drain(
  gen: AsyncGenerator<ModelDelta, ModelResult>,
): Promise<{ deltas: ModelDelta[]; result: ModelResult }> {
  const deltas: ModelDelta[] = [];
  let next = await gen.next();
  while (!next.done) {
    deltas.push(next.value);
    next = await gen.next();
  }
  return { deltas, result: next.value };
}

describe('DoubaoProvider.call (injected client, offline)', () => {
  it('streams text deltas and returns an aggregated ModelResult', async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ];
    const provider = new DoubaoProvider(config, makeClient({ chunks }));
    const { deltas, result } = await drain(provider.call([{ role: 'user', content: 'hi' }], []));

    expect(deltas).toContainEqual({ type: 'text', text: 'Hel' });
    expect(result.text).toBe('Hello');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(result.finishReason).toBe('completed');
    expect(result.toolCalls).toEqual([]);
  });

  it('routes an SDK error through describeModelError (bad key -> readable error)', async () => {
    const provider = new DoubaoProvider(
      config,
      makeClient({ error: { status: 401, message: 'Invalid Authentication' } }),
    );
    const gen = provider.call([{ role: 'user', content: 'hi' }], []);
    // The error throws at create(), before any yield, so the first .next() rejects.
    await expect(gen.next()).rejects.toThrow(/ARK_API_KEY/);
    await expect(provider.call([{ role: 'user', content: 'hi' }], []).next()).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it('rethrows the original error on a deliberate abort (not wrapped as a failure)', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortErr = new Error('Request was aborted.');
    const provider = new DoubaoProvider(config, makeClient({ error: abortErr }));
    const gen = provider.call([{ role: 'user', content: 'hi' }], [], controller.signal);
    await expect(gen.next()).rejects.toBe(abortErr); // original identity preserved
  });
});
