import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent } from '../../src/core/loop/run-agent.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { readTool, writeTool } from '../../src/core/tools/builtins.js';
import { DefaultContextManager } from '../../src/core/context/context-manager.js';
import { InMemoryEventBus, type Event } from '../../src/runtime/event-bus.js';
import { DefaultPermissionGate, type Approver } from '../../src/runtime/permission/permission-gate.js';
import type { Message, ToolCall, ToolResult } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';
import type { ContextManager } from '../../src/core/context/context-manager.js';

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

describe('runAgent — compaction (A3)', () => {
  it('compacts in-loop when the window fills, keeps system + tail, then continues', async () => {
    // Tiny effective budget (12 − 2 = 10) so the scripted usage (inputTokens 10) trips it.
    const cm = new DefaultContextManager({
      summarizer: scriptedModel([{ text: 'COMPACTED' }]).provider,
      maxContextTokens: 12,
      maxOutputTokens: 2,
      keepRecent: 2,
    });
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([
      { text: 'working', toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }] },
      { text: 'final answer' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old q1' },
      { role: 'assistant', content: 'old a1' },
      { role: 'user', content: 'recent q' },
    ];

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      context: cm,
    });

    // the loop announced and performed compaction
    expect(events.some((e) => e.type === 'state' && e.phase === 'compacting')).toBe(true);
    // the summary replaced the old prefix, the system prompt survived as the prefix
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages.some((m) => m.role === 'user' && m.content.includes('COMPACTED'))).toBe(true);
    expect(messages.some((m) => m.content === 'old q1')).toBe(false); // old prefix gone
    // and the conversation continued to a natural finish AFTER compacting
    expect(outcome.finalText).toBe('final answer');
  });

  it('budgets each tool result through the context manager before it enters the conversation', async () => {
    // A spy manager: never compacts, but rewrites every tool result so we can see it applied.
    const spy: ContextManager = {
      shouldCompact: () => false,
      compact: async () => {},
      budgetToolResult: async (out: ToolResult) => ({ ...out, content: `BUDGETED:${out.content}` }),
    };
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const messages: Message[] = [{ role: 'user', content: 'go' }];

    await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      context: spy,
    });

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ out: { content: 'BUDGETED:ok' } });
    expect(messages.some((m) => m.role === 'tool' && m.content === 'BUDGETED:ok')).toBe(true);
  });
});

describe('runAgent — permission gate (B1)', () => {
  it('denies a sensitive read: the tool never runs and the model gets the reason fed back', async () => {
    // Plant a real secret. If the gate fails, the secret would leak into the tool result.
    await writeFile(join(dir, '.env'), 'API_KEY=super-secret-value', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = scriptedModel([
      { text: 'reading config', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":".env"}' }] },
      { text: 'I cannot read that file.' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const messages: Message[] = [{ role: 'user', content: 'what is the api key?' }];

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      gate: new DefaultPermissionGate(), // no approver needed: a sensitive path is a hard deny
    });

    const toolResult = events.find((e) => e.type === 'tool_result');
    // the result is a denial, and the SECRET never appears anywhere it reached
    expect(toolResult).toMatchObject({ type: 'tool_result', out: { content: '' } });
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toMatch(/Permission denied/);
    expect(JSON.stringify(events)).not.toContain('super-secret-value');
    expect(messages.some((m) => m.role === 'tool' && m.content.includes('Permission denied'))).toBe(true);
    // and the loop still finished naturally on the model's recovery turn
    expect(outcome.finalText).toBe('I cannot read that file.');
  });

  it('allows a write after the injected approver approves it (the ask lane runs the tool)', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(writeTool);
    const approver: Approver = async () => 'allow-once';
    const { provider } = scriptedModel([
      {
        toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"note.txt","content":"hello"}' }],
      },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'write note.txt' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      gate: new DefaultPermissionGate({ approver }),
    });

    // the tool actually ran (file on disk) and reported success — not a denial
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('hello');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toBeUndefined();
  });

  it('denies the write when no approver is available (fail-closed): the file is never written', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(writeTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"blocked.txt","content":"x"}' }] },
      { text: 'understood' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'write a file' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      gate: new DefaultPermissionGate(), // non-interactive → ask fails closed
    });

    await expect(readFile(join(dir, 'blocked.txt'), 'utf8')).rejects.toThrow(); // never created
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toMatch(/Permission denied/);
  });
});

describe('runAgent — system addendum (A5)', () => {
  /** Captures the system message content the model received on its first call. */
  function capturingModel(): { provider: ModelProvider; systemSeen: () => string } {
    let seen = '';
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
        const first = messages[0];
        seen = first && first.role === 'system' ? first.content : '';
        return {
          text: 'ok',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
      withThinking: () => provider,
      withMaxCompletionTokens: () => provider,
    };
    return { provider, systemSeen: () => seen };
  }

  it('folds the addendum into the system message at send time without persisting it', async () => {
    const { provider, systemSeen } = capturingModel();
    const messages: Message[] = [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'hi' }];

    await runAgent({
      model: provider,
      tools: new InMemoryToolRegistry(),
      bus: new InMemoryEventBus(),
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      systemAddendum: 'SKILL-CATALOG',
    });

    // the model saw base + addendum…
    expect(systemSeen()).toBe('BASE\n\nSKILL-CATALOG');
    // …but the stored conversation's system message is untouched (no persistence/compaction)
    expect(messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('leaves messages exactly as-is when no addendum is given', async () => {
    const { provider, systemSeen } = capturingModel();
    await runAgent({
      model: provider,
      tools: new InMemoryToolRegistry(),
      bus: new InMemoryEventBus(),
      messages: [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'hi' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });
    expect(systemSeen()).toBe('BASE');
  });
});
