import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent } from '../../src/core/loop/run-agent.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { readTool } from '../../src/core/tools/builtins.js';
import { InMemoryEventBus, type Event } from '../../src/runtime/event-bus.js';
import type { Message, ToolCall } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';

/** A model whose turns are scripted. Each step's text is streamed in two chunks (to exercise
 *  delta aggregation); the last step repeats forever (so an always-tool step loops). */
interface Step {
  text?: string;
  toolCalls?: ToolCall[];
}
function scriptedModel(steps: Step[]): { provider: ModelProvider; calls: () => number } {
  let count = 0;
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      const step = steps[Math.min(count, steps.length - 1)];
      count++;
      const text = step.text ?? '';
      if (text.length > 0) {
        // stream in two halves so message_delta aggregation across chunks is real
        const mid = Math.ceil(text.length / 2);
        yield { type: 'text', text: text.slice(0, mid) };
        yield { type: 'text', text: text.slice(mid) };
      }
      const toolCalls = step.toolCalls ?? [];
      return {
        text,
        toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'completed',
        rawFinishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return { provider, calls: () => count };
}

const okTool: ToolDefinition<Record<string, never>> = {
  name: 'ok',
  description: 'always succeeds',
  capability: 'read-only',
  inputSchema: z.object({}),
  run: async () => ({ content: 'ok' }),
};

function record(bus: InMemoryEventBus): Event[] {
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-loop-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runAgent — tool loop', () => {
  it('runs a model-requested tool, feeds the result back, and stops on the no-tool turn', async () => {
    await writeFile(join(dir, 'fact.txt'), 'the sky is teal', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = scriptedModel([
      { text: 'Let me check.', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"fact.txt"}' }] },
      { text: 'Per the file, the sky is teal.' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const messages: Message[] = [{ role: 'user', content: 'what does fact.txt say?' }];

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });

    // the REAL tool ran and its content came back on the bus
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ type: 'tool_result', out: { content: 'the sky is teal' } });
    // the result round-tripped into the conversation as a tool message
    expect(
      messages.some((m) => m.role === 'tool' && m.content === 'the sky is teal'),
    ).toBe(true);
    // and the loop stopped naturally on the second (no-tool) turn
    expect(outcome).toEqual({ finalText: 'Per the file, the sky is teal.', turns: 2 });
  });

  it('emits events in message_delta → tool_call → tool_result → final order, plus usage', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([
      { text: 'thinking', toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'go' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });

    const order = events
      .map((e) => e.type)
      .filter((t) => t === 'message_delta' || t === 'tool_call' || t === 'tool_result' || t === 'final');
    const firstDelta = order.indexOf('message_delta');
    const toolCall = order.indexOf('tool_call');
    const toolResult = order.indexOf('tool_result');
    const final = order.lastIndexOf('final');
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(firstDelta).toBeLessThan(toolCall);
    expect(toolCall).toBeLessThan(toolResult);
    expect(toolResult).toBeLessThan(final);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });

  it('stops on turn 1 when the model asks for no tools (no tool events)', async () => {
    const tools = new InMemoryToolRegistry();
    const { provider, calls } = scriptedModel([{ text: 'hello' }]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'hi' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });

    expect(outcome).toEqual({ finalText: 'hello', turns: 1 });
    expect(calls()).toBe(1);
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events.find((e) => e.type === 'final')).toMatchObject({ text: 'hello' });
  });
});

describe('runAgent — guardrail', () => {
  it('trips the maxTurns halt when the model never stops calling tools', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    // single step that always asks for a tool → would loop forever without the guardrail
    const { provider, calls } = scriptedModel([
      { toolCalls: [{ id: 'loop', name: 'ok', arguments: '{}' }] },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'go' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 3 },
    });

    // ran EXACTLY maxTurns turns — proves withinBudget actually READS turn (not dead code):
    // a guardrail that only incremented would never exit and this test would hang.
    expect(calls()).toBe(3);
    expect(outcome).toEqual({ halted: 'maxTurns', turns: 3 });
    expect(events.some((e) => e.type === 'halt' && e.reason === 'maxTurns')).toBe(true);
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });
});
