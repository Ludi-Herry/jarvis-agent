import { describe, expect, it } from 'vitest';
import {
  emptyStreamState,
  finalizeResult,
  foldChunk,
  type StreamChunk,
} from '../../src/core/model/stream.js';

function textChunk(content: string): StreamChunk {
  return { choices: [{ delta: { content } }] };
}

describe('foldChunk + finalizeResult', () => {
  it('accumulates text deltas and yields them', () => {
    const state = emptyStreamState();
    const d1 = foldChunk(state, textChunk('Hel'));
    const d2 = foldChunk(state, textChunk('lo'));
    expect(d1).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(d2).toEqual([{ type: 'text', text: 'lo' }]);
    expect(finalizeResult(state).text).toBe('Hello');
  });

  it('accumulates reasoning_content separately', () => {
    const state = emptyStreamState();
    foldChunk(state, { choices: [{ delta: { reasoning_content: 'think ' } }] });
    foldChunk(state, { choices: [{ delta: { reasoning_content: 'more' } }] });
    foldChunk(state, textChunk('answer'));
    const res = finalizeResult(state);
    expect(res.reasoning).toBe('think more');
    expect(res.text).toBe('answer');
  });

  it('buffers tool_calls by index and concatenates arguments across chunks', () => {
    const state = emptyStreamState();
    foldChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }],
    });
    foldChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }],
    });
    foldChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'grep', arguments: '{}' } }] } }],
    });
    const res = finalizeResult(state);
    expect(res.toolCalls).toEqual([
      { id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      { id: 'call_2', name: 'grep', arguments: '{}' },
    ]);
  });

  it('reads usage from the top level', () => {
    const state = emptyStreamState();
    foldChunk(state, {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
    });
    const res = finalizeResult(state);
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5, cachedInputTokens: 3 });
    expect(res.finishReason).toBe('completed');
    expect(res.rawFinishReason).toBe('stop');
  });

  it('captures usage from the terminal empty-choices chunk (the real ARK include_usage shape)', () => {
    const state = emptyStreamState();
    foldChunk(state, textChunk('hi'));
    foldChunk(state, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    // Final chunk: choices:[] + top-level usage — must be captured even though there is no choice.
    const deltas = foldChunk(state, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } });
    expect(deltas).toEqual([]);
    const res = finalizeResult(state);
    expect(res.text).toBe('hi');
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    expect(res.finishReason).toBe('completed');
  });

  it('falls back to usage stashed inside choices[0].usage', () => {
    const state = emptyStreamState();
    foldChunk(state, {
      choices: [{ delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 2 } }],
    });
    expect(finalizeResult(state).usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it('defaults usage to zero and finish reason to "other" when absent', () => {
    const res = finalizeResult(emptyStreamState());
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(res.finishReason).toBe('other');
    expect(res.rawFinishReason).toBe('');
    expect(res.reasoning).toBeUndefined();
  });
});
