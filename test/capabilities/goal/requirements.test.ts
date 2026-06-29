import { describe, expect, it } from 'vitest';
import {
  derivePinnedRequirements,
  parseRequirementList,
} from '../../../src/capabilities/goal/requirements.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';

/** A fake provider whose single completion returns `text` (or throws if `throws`). */
function fakeProvider(text: string, opts: { throws?: boolean } = {}): ModelProvider {
  const p: ModelProvider = {
    capability: { maxContextTokens: 1000, maxOutputTokens: 100, thinking: false, toolUse: false, imageIn: false, videoIn: false },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      if (opts.throws) throw new Error('model down');
      yield* [];
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'completed', rawFinishReason: 'stop' };
    },
    withThinking: () => p,
    withMaxCompletionTokens: () => p,
  };
  return p;
}

describe('parseRequirementList (pure, lenient)', () => {
  it('parses a bare JSON array of strings', () => {
    expect(parseRequirementList('["a", "b", "c"]')).toEqual(['a', 'b', 'c']);
  });

  it('parses an object with a requirements array', () => {
    expect(parseRequirementList('{"requirements": ["x", "y"]}')).toEqual(['x', 'y']);
  });

  it('extracts from a fenced block amid prose', () => {
    expect(parseRequirementList('Here:\n```json\n["one","two"]\n```\n')).toEqual(['one', 'two']);
  });

  it('extracts the array from surrounding prose', () => {
    expect(parseRequirementList('sure → ["only"] ← done')).toEqual(['only']);
  });

  it('trims, drops empties and non-strings', () => {
    expect(parseRequirementList('["  a  ", "", "  ", "b", 3, null]')).toEqual(['a', 'b']);
  });

  it('caps the count at 12', () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `r${i}`));
    expect(parseRequirementList(many)).toHaveLength(12);
  });

  it('returns [] for unusable output (the fail-closed signal)', () => {
    expect(parseRequirementList('no json here at all')).toEqual([]);
    expect(parseRequirementList('[]')).toEqual([]);
  });
});

describe('derivePinnedRequirements', () => {
  it('assigns sequential ids r1.. to the parsed requirement texts', async () => {
    const pinned = await derivePinnedRequirements('build X', fakeProvider('["A", "B"]'));
    expect(pinned).toEqual([
      { id: 'r1', text: 'A' },
      { id: 'r2', text: 'B' },
    ]);
  });

  it('returns [] when the model call throws (caller fail-closes on empty)', async () => {
    expect(await derivePinnedRequirements('build X', fakeProvider('', { throws: true }))).toEqual([]);
  });

  it('returns [] when the model output is unusable', async () => {
    expect(await derivePinnedRequirements('build X', fakeProvider('I cannot help with that'))).toEqual([]);
  });
});
