import { describe, expect, it } from 'vitest';
import { buildChatParams, sanitizeToolCallId } from '../../src/core/model/request.js';
import type { Message, ToolSchema } from '../../src/core/types.js';

const base = {
  model: 'doubao-seed-2-1-pro-260628',
  messages: [{ role: 'user', content: 'hi' }] as Message[],
  tools: [] as ToolSchema[],
  maxOutputCap: 1000,
};

describe('buildChatParams', () => {
  it('always streams with usage and omits optional fields by default', () => {
    const p = buildChatParams(base);
    expect(p.stream).toBe(true);
    expect(p.stream_options).toEqual({ include_usage: true });
    expect(p.thinking).toBeUndefined(); // no thinking key => server default (Doubao: ON)
    expect(p.max_tokens).toBeUndefined(); // no cap => server decides
    expect(p.tools).toBeUndefined();
  });

  it('thinking "off" disables thinking; any other effort enables it', () => {
    expect(buildChatParams({ ...base, thinking: 'off' }).thinking).toEqual({ type: 'disabled' });
    expect(buildChatParams({ ...base, thinking: 'high' }).thinking).toEqual({ type: 'enabled' });
    expect(buildChatParams({ ...base, thinking: 'low' }).thinking).toEqual({ type: 'enabled' });
  });

  it('clamps an explicit max output to the cap', () => {
    expect(buildChatParams({ ...base, maxCompletionTokens: 50 }).max_tokens).toBe(50);
    expect(buildChatParams({ ...base, maxCompletionTokens: 9999 }).max_tokens).toBe(1000);
  });

  it('converts tools to the OpenAI function wire shape', () => {
    const tools: ToolSchema[] = [
      { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } },
    ];
    const p = buildChatParams({ ...base, tools });
    expect(p.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } },
      },
    ]);
  });

  it('round-trips assistant reasoning + tool calls and truncates long ids', () => {
    const longId = 'x'.repeat(80);
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'calling',
        reasoning: 'because',
        toolCalls: [{ id: longId, name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: longId, content: 'file body' },
    ];
    const p = buildChatParams({ ...base, messages });
    const assistant = p.messages[0];
    const tool = p.messages[1];
    expect(assistant).toMatchObject({ role: 'assistant', content: 'calling', reasoning_content: 'because' });
    expect(assistant.role === 'assistant' && assistant.tool_calls?.[0].id).toBe('x'.repeat(64));
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'x'.repeat(64), content: 'file body' });
  });
});

describe('sanitizeToolCallId', () => {
  it('truncates to 64 chars and leaves short ids alone', () => {
    expect(sanitizeToolCallId('abc')).toBe('abc');
    expect(sanitizeToolCallId('y'.repeat(100))).toHaveLength(64);
  });
});
