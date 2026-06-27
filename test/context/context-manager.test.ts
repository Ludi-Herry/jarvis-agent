import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultContextManager, SUMMARY_MARKER } from '../../src/core/context/context-manager.js';
import type { Message } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';

/** A summarizer that returns a fixed text (no streaming) and records what it was asked to
 *  summarize, so tests can assert the prefix — not the tail — was sent. */
function fakeSummarizer(summary: string): { provider: ModelProvider; lastPrompt: () => string } {
  let prompt = '';
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: false,
      imageIn: false,
      videoIn: false,
    },
    // eslint-disable-next-line require-yield
    async *call(messages: Message[]): AsyncGenerator<ModelDelta, ModelResult> {
      prompt = messages.map((m) => ('content' in m ? m.content : '')).join('\n');
      return {
        text: summary,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return { provider, lastPrompt: () => prompt };
}

const asstTool: Message = {
  role: 'assistant',
  toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }],
};
const toolMsg: Message = { role: 'tool', toolCallId: 't1', content: 'file' };

describe('DefaultContextManager.shouldCompact', () => {
  it('compares input tokens against the EFFECTIVE budget (window − output)', () => {
    const cm = new DefaultContextManager({
      summarizer: fakeSummarizer('x').provider,
      maxContextTokens: 1000,
      maxOutputTokens: 100, // effective budget 900; threshold 0.83 → 747
    });
    expect(cm.shouldCompact({ inputTokens: 740, outputTokens: 0 })).toBe(false);
    expect(cm.shouldCompact({ inputTokens: 750, outputTokens: 0 })).toBe(true);
  });
});

describe('DefaultContextManager.compact', () => {
  it('replaces the old prefix with one summary message, preserving system + recent tail', async () => {
    const sum = fakeSummarizer('SUMMARY-TEXT');
    const cm = new DefaultContextManager({
      summarizer: sum.provider,
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      keepRecent: 2,
    });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    await cm.compact(messages);

    // [sys, summary, q2, a2]
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages[1].role).toBe('user');
    expect(messages[1]).toMatchObject({ content: expect.stringContaining(SUMMARY_MARKER) });
    expect(messages[1]).toMatchObject({ content: expect.stringContaining('SUMMARY-TEXT') });
    expect(messages[2]).toEqual({ role: 'user', content: 'q2' });
    expect(messages[3]).toEqual({ role: 'assistant', content: 'a2' });
    // only the prefix was summarized, never the tail
    expect(sum.lastPrompt()).toContain('q1');
    expect(sum.lastPrompt()).not.toContain('q2');
  });

  it('keeps a tool call and its result together in the tail', async () => {
    const cm = new DefaultContextManager({
      summarizer: fakeSummarizer('S').provider,
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      keepRecent: 2,
    });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      asstTool,
      toolMsg,
    ];
    await cm.compact(messages);

    const aiIdx = messages.findIndex((m) => m.role === 'assistant' && m.toolCalls);
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(messages[aiIdx + 1]).toEqual(toolMsg); // result still immediately follows its call
  });

  it('is a no-op when no safe cut summarizes anything', async () => {
    const cm = new DefaultContextManager({
      summarizer: fakeSummarizer('S').provider,
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      keepRecent: 1,
    });
    const messages: Message[] = [{ role: 'system', content: 'sys' }, asstTool, toolMsg];
    const before = structuredClone(messages);
    await cm.compact(messages);
    expect(messages).toEqual(before);
  });
});

describe('DefaultContextManager.budgetToolResult', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-budget-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a small tool result through unchanged', async () => {
    const cm = new DefaultContextManager({
      summarizer: fakeSummarizer('S').provider,
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      maxToolResultChars: 1000,
      toolResultDir: dir,
    });
    const out = { callId: 'c1', content: 'short' };
    expect(await cm.budgetToolResult(out)).toBe(out);
  });

  it('truncates an oversized result and offloads the full text to disk', async () => {
    const cm = new DefaultContextManager({
      summarizer: fakeSummarizer('S').provider,
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      maxToolResultChars: 1000,
      toolResultDir: dir,
    });
    const big = 'x'.repeat(6000);
    const out = await cm.budgetToolResult({ callId: 'big1', content: big });

    expect(out.content).toContain('truncated');
    expect(out.content).toContain('big1.txt');
    expect(out.content.length).toBeLessThan(big.length); // context only carries a preview
    const saved = await readFile(join(dir, 'big1.txt'), 'utf8');
    expect(saved).toBe(big); // full text recoverable from disk
  });
});
