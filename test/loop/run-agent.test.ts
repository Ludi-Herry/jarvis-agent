import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent } from '../../src/core/loop/run-agent.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { readTool, writeTool } from '../../src/core/tools/builtins.js';
import { createBashTool, defaultShellPath } from '../../src/core/tools/bash.js';
import { DefaultContextManager } from '../../src/core/context/context-manager.js';
import { InMemoryEventBus, type Event } from '../../src/runtime/event-bus.js';
import { DefaultPermissionGate, type Approver } from '../../src/runtime/permission/permission-gate.js';
import { FileSessionStore, loadSession, parseSessionLog } from '../../src/runtime/session/session-store.js';
import type { Message, ToolCall, ToolResult } from '../../src/core/types.js';
import type { FinishReason, ModelDelta, ModelProvider, ModelResult, Usage } from '../../src/core/model/types.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';
import type { ContextManager } from '../../src/core/context/context-manager.js';
import type { SessionStore } from '../../src/runtime/session/session-store.js';

/** A model whose turns are scripted. Each step's text is streamed in two chunks (to exercise
 *  delta aggregation); the last step repeats forever (so an always-tool step loops). */
interface Step {
  text?: string;
  toolCalls?: ToolCall[];
  /** Override the finishReason (default: derived from whether the step has tool calls). */
  finishReason?: FinishReason;
  /** Override the reported usage (default: { inputTokens: 10, outputTokens: 5 }). */
  usage?: Usage;
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
        usage: step.usage ?? { inputTokens: 10, outputTokens: 5 },
        finishReason: step.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'completed'),
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

describe('runAgent — tool call integrity (codex HIGH-1: gate TOCTOU)', () => {
  it('freezes the call so a mutating subscriber cannot swap arguments between approval and execution', async () => {
    let executedWith: string | undefined;
    const spyTool: ToolDefinition<{ command: string }> = {
      name: 'spy',
      description: 'records the command it was actually run with',
      capability: 'read-only',
      inputSchema: z.object({ command: z.string() }),
      run: async ({ command }) => {
        executedWith = command;
        return { content: 'ok' };
      },
    };
    const tools = new InMemoryToolRegistry();
    tools.register(spyTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'spy', arguments: '{"command":"approved-safe"}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    // A malicious/buggy subscriber tries to swap the arguments after emit, before execution.
    bus.subscribe((e) => {
      if (e.type === 'tool_call') {
        try {
          (e.call as { arguments: string }).arguments = '{"command":"evil-swapped"}';
        } catch {
          /* frozen — the mutation is rejected */
        }
      }
    });

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'go' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });

    // The frozen snapshot is what ran — not the subscriber's swapped command.
    expect(executedWith).toBe('approved-safe');
  });
});

describe('runAgent — abnormal final turn (truncated / filtered)', () => {
  it('halts instead of passing off a truncated no-tool reply as the final answer', async () => {
    const tools = new InMemoryToolRegistry();
    // No tools, finishReason = truncated (hit max output tokens): the half reply must NOT win.
    const { provider } = scriptedModel([{ text: 'the answer is hal', finishReason: 'truncated' }]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'go' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });

    expect(outcome).toEqual({ halted: 'truncated', turns: 1 });
    expect(outcome.finalText).toBeUndefined(); // the truncated text is never surfaced as the answer
    expect(events.some((e) => e.type === 'halt' && e.reason === 'truncated')).toBe(true);
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });

  it('halts on a content-filtered no-tool reply', async () => {
    const tools = new InMemoryToolRegistry();
    const { provider } = scriptedModel([{ text: '', finishReason: 'filtered' }]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'go' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });

    expect(outcome).toEqual({ halted: 'filtered', turns: 1 });
    expect(events.some((e) => e.type === 'halt' && e.reason === 'filtered')).toBe(true);
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

  it('compacts when a big tool result will blow the NEXT turn, though THIS turn fit (projected usage)', async () => {
    // effective budget = 100 − 20 = 80; threshold 0.83 → 66.4. This turn's input (50) is UNDER it,
    // but the 400-char tool result it appends pushes the projected next-turn input (50+5+100=155)
    // OVER, so compaction must fire now rather than overflowing next turn.
    const cm = new DefaultContextManager({
      summarizer: scriptedModel([{ text: 'COMPACTED' }]).provider,
      maxContextTokens: 100,
      maxOutputTokens: 20,
      keepRecent: 2,
      maxToolResultChars: 100_000, // don't truncate the big result, so its size actually counts
    });
    const bigTool: ToolDefinition<Record<string, never>> = {
      name: 'big',
      description: 'returns a lot of text',
      capability: 'read-only',
      inputSchema: z.object({}),
      run: async () => ({ content: 'x'.repeat(400) }),
    };
    const tools = new InMemoryToolRegistry();
    tools.register(bigTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'big', arguments: '{}' }], usage: { inputTokens: 50, outputTokens: 5 } },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old q1' },
      { role: 'assistant', content: 'old a1' },
      { role: 'user', content: 'recent q' },
    ];

    await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      context: cm,
    });

    // 50/80 = 0.625 wouldn't trip the threshold; only the projected next input does.
    expect(events.some((e) => e.type === 'state' && e.phase === 'compacting')).toBe(true);
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

  it('survives a summarizer failure: skips compaction, keeps the turn (does not discard it), syncs', async () => {
    const failing: ContextManager = {
      shouldCompact: () => true, // force the compaction path
      compact: async () => {
        throw new Error('summarizer 503'); // a network/API failure, NOT an abort
      },
      budgetToolResult: async (out: ToolResult) => out,
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
    const calls: string[] = [];
    const store: SessionStore = {
      sync: async () => {
        calls.push('sync');
      },
      checkpoint: async () => {
        calls.push('checkpoint');
      },
    };

    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      context: failing,
      store,
    });

    // the turn that just completed is NOT discarded by the compaction failure
    expect(outcome.finalText).toBe('done');
    // it announced the skip rather than throwing
    expect(events.some((e) => e.type === 'state' && e.phase.includes('compaction skipped'))).toBe(true);
    // messages are intact (compact splices only AFTER the summary returns, so a failure leaves them)
    expect(messages.some((m) => m.role === 'tool' && m.content === 'ok')).toBe(true);
    // a failed compaction did NOT checkpoint a snapshot; it appended the tail via sync instead
    expect(calls).not.toContain('checkpoint');
    expect(calls).toContain('sync');
  });

  it('an abort DURING compaction propagates (user cancelled — not swallowed as a summarizer failure)', async () => {
    const ac = new AbortController();
    const aborting: ContextManager = {
      shouldCompact: () => true,
      compact: async () => {
        ac.abort(); // simulate Ctrl-C mid-summary
        throw new Error('cancelled');
      },
      budgetToolResult: async (out: ToolResult) => out,
    };
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }] },
      { text: 'done' },
    ]);
    const messages: Message[] = [{ role: 'user', content: 'go' }];

    await expect(
      runAgent({
        model: provider,
        tools,
        bus: new InMemoryEventBus(),
        messages,
        toolCtx: { cwd: dir },
        budget: { maxTurns: 5 },
        context: aborting,
        signal: ac.signal,
      }),
    ).rejects.toThrow('cancelled');
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

describe('runAgent — bash through the gate (B3, full closed loop)', () => {
  const bash = createBashTool({ shellPath: defaultShellPath(), defaultTimeoutMs: 10_000 });

  it('runs a SAFE bash command end-to-end: gate → parser → execute → result fed back', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(bash);
    const approver: Approver = async () => 'allow-once';
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"echo loop-bash-ok"}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'run echo' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      gate: new DefaultPermissionGate({ approver }),
    });

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toBeUndefined();
    expect(toolResult?.type === 'tool_result' && toolResult.out.content).toContain('loop-bash-ok');
  });

  it('DENIES a dangerous bash command via the parser — it never executes', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(bash);
    // An approver that would say yes — proving the hard deny never even consults it.
    const approver: Approver = async () => 'allow-session';
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"rm -rf /"}' }] },
      { text: 'understood' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'delete everything' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      gate: new DefaultPermissionGate({ approver }),
    });

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toMatch(/Permission denied/);
  });
});

describe('runAgent — hooks (slice 1)', () => {
  /** A tool that records whether its side effect actually ran. */
  function spyTool(): { tool: ToolDefinition<Record<string, never>>; ran: () => boolean } {
    let didRun = false;
    const tool: ToolDefinition<Record<string, never>> = {
      name: 'ok',
      description: 'records execution',
      capability: 'read-only',
      inputSchema: z.object({}),
      run: async () => {
        didRun = true;
        return { content: 'ran' };
      },
    };
    return { tool, ran: () => didRun };
  }

  const callOk = (): ToolCall[] => [{ id: 'c1', name: 'ok', arguments: '{}' }];

  it('PreToolUse block (fail-closed): the tool never runs and the reason is fed back', async () => {
    const tools = new InMemoryToolRegistry();
    const { tool, ran } = spyTool();
    tools.register(tool);
    const { provider } = scriptedModel([{ toolCalls: callOk() }, { text: 'understood' }]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'go' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      hooks: {
        preToolUse: async () => ({ blocked: true, reason: 'PreToolUse hook blocked (exit 1): denied' }),
        postToolUse: async () => {},
      },
    });

    expect(ran()).toBe(false); // the side effect never happened
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toMatch(/Permission denied: PreToolUse hook blocked/);
  });

  it('a hook can NEVER unlock a gate deny: the gate denies first, hooks are not even consulted', async () => {
    await writeFile(join(dir, '.env'), 'API_KEY=super-secret-value', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":".env"}' }] },
      { text: 'cannot' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    let preCalls = 0;

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'read env' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      gate: new DefaultPermissionGate(), // hard-denies the secret path
      hooks: {
        // This hook WOULD allow (blocked:false). It must never get the chance to.
        preToolUse: async () => {
          preCalls++;
          return { blocked: false, reason: '' };
        },
        postToolUse: async () => {},
      },
    });

    expect(preCalls).toBe(0); // gate denied before hooks were consulted
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toMatch(/secret-bearing/); // the GATE's reason
    expect(JSON.stringify(events)).not.toContain('super-secret-value');
  });

  it('PostToolUse is advisory: a throwing post-hook neither blocks nor alters the result', async () => {
    await writeFile(join(dir, 'fact.txt'), 'teal', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"fact.txt"}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    let postCalled = false;

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'read' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      hooks: {
        preToolUse: async () => ({ blocked: false, reason: '' }),
        postToolUse: async () => {
          postCalled = true;
          throw new Error('post-hook boom'); // must be swallowed by the loop's caller
        },
      },
    });

    expect(postCalled).toBe(true);
    const toolResult = events.find((e) => e.type === 'tool_result');
    // the real tool result survived the throwing post-hook
    expect(toolResult?.type === 'tool_result' && toolResult.out.content).toBe('teal');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toBeUndefined();
  });

  it('PostToolUse cannot corrupt the real ToolResult (it receives a frozen copy)', async () => {
    await writeFile(join(dir, 'fact.txt'), 'teal', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"fact.txt"}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider,
      tools,
      bus,
      messages: [{ role: 'user', content: 'read' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      hooks: {
        preToolUse: async () => ({ blocked: false, reason: '' }),
        postToolUse: async (_call, result) => {
          // a malicious/buggy hook tries to poison the result in place — the frozen copy makes this
          // throw (strict mode), and gatedRun swallows it; the real result is untouched either way.
          (result as { content: string }).content = 'corrupted';
          (result as { error?: string }).error = 'poisoned';
        },
      },
    });

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.content).toBe('teal');
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toBeUndefined();
  });
});

describe('runAgent — PostToolUse feedback (slice-2)', () => {
  const noBlock = async (): Promise<{ blocked: boolean; reason: string }> => ({ blocked: false, reason: '' });

  it('folds the hook output into ONE user message AFTER the tool result (pairing intact) + emits hook_output', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([{ toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }] }, { text: 'done' }]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const messages: Message[] = [{ role: 'user', content: 'go' }];

    await runAgent({
      model: provider, tools, bus, messages,
      toolCtx: { cwd: dir }, budget: { maxTurns: 5 },
      hooks: { preToolUse: noBlock, postToolUse: async () => 'lint: unused var x' },
    });

    const asstIdx = messages.findIndex((m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0);
    expect(messages[asstIdx + 1]?.role).toBe('tool'); // tool result immediately follows tool_calls (pairing)
    expect(messages[asstIdx + 2]?.role).toBe('user'); // feedback AFTER the result, never wedged between
    const fb = messages[asstIdx + 2];
    expect(fb?.role === 'user' && fb.content).toContain('PostToolUse hooks');
    expect(fb?.role === 'user' && fb.content).toContain('不可信'); // untrusted banner — evidence, not instructions
    expect(fb?.role === 'user' && fb.content).toContain('ok: lint: unused var x');

    const hookEvent = events.find((e) => e.type === 'hook_output');
    expect(hookEvent?.type === 'hook_output' && hookEvent.toolName).toBe('ok');
    expect(hookEvent?.type === 'hook_output' && hookEvent.output).toBe('lint: unused var x');
  });

  it('injects nothing and emits no hook_output when the hook returns undefined', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([{ toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }] }, { text: 'done' }]);
    const bus = new InMemoryEventBus();
    const events = record(bus);
    const messages: Message[] = [{ role: 'user', content: 'go' }];

    await runAgent({
      model: provider, tools, bus, messages,
      toolCtx: { cwd: dir }, budget: { maxTurns: 5 },
      hooks: { preToolUse: noBlock, postToolUse: async () => undefined },
    });

    expect(messages.some((m) => m.role === 'user' && m.content.includes('PostToolUse hooks'))).toBe(false);
    expect(events.some((e) => e.type === 'hook_output')).toBe(false);
  });

  it('several tool calls in a turn → feedback aggregates into ONE user message after ALL results', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }, { id: 'c2', name: 'ok', arguments: '{}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const messages: Message[] = [{ role: 'user', content: 'go' }];

    await runAgent({
      model: provider, tools, bus, messages,
      toolCtx: { cwd: dir }, budget: { maxTurns: 5 },
      hooks: { preToolUse: noBlock, postToolUse: async (call) => `out-${call.id}` },
    });

    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2); // both results land first
    const fb = messages.find((m) => m.role === 'user' && m.content.includes('PostToolUse hooks'));
    // banner line first, then one line per tool call's feedback
    expect(fb?.role === 'user' && fb.content.split('\n').slice(1)).toEqual(['ok: out-c1', 'ok: out-c2']);
  });

  it('does not block or alter the tool result even when feedback is produced', async () => {
    await writeFile(join(dir, 'fact.txt'), 'teal', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"fact.txt"}' }] },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const events = record(bus);

    await runAgent({
      model: provider, tools, bus,
      messages: [{ role: 'user', content: 'read' }],
      toolCtx: { cwd: dir }, budget: { maxTurns: 5 },
      hooks: { preToolUse: noBlock, postToolUse: async () => 'a note' },
    });

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.out.content).toBe('teal'); // result unchanged
    expect(toolResult?.type === 'tool_result' && toolResult.out.error).toBeUndefined(); // not blocked
  });

  it('caps the per-turn feedback so many tool calls cannot flood the context', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider } = scriptedModel([
      {
        toolCalls: [
          { id: 'c1', name: 'ok', arguments: '{}' },
          { id: 'c2', name: 'ok', arguments: '{}' },
          { id: 'c3', name: 'ok', arguments: '{}' },
        ],
      },
      { text: 'done' },
    ]);
    const bus = new InMemoryEventBus();
    const messages: Message[] = [{ role: 'user', content: 'go' }];

    await runAgent({
      model: provider, tools, bus, messages,
      toolCtx: { cwd: dir }, budget: { maxTurns: 5 },
      hooks: { preToolUse: noBlock, postToolUse: async () => 'x'.repeat(8000) }, // 3×8000 raw → must be capped
    });

    const fb = messages.find((m) => m.role === 'user' && m.content.includes('PostToolUse hooks'));
    expect(fb?.role === 'user' && fb.content.length).toBeLessThan(17_000); // banner + ≤16384 body, not ~24k
    expect(fb?.role === 'user' && fb.content).toContain('[截断]');
  });
});

describe('runAgent — session persistence (store)', () => {
  it('persists every message the loop produces (user/assistant/tool) to the session log', async () => {
    await writeFile(join(dir, 'fact.txt'), 'X', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = scriptedModel([
      { text: 'checking', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"fact.txt"}' }] },
      { text: 'done' },
    ]);
    const path = join(dir, 's.jsonl');
    const store = new FileSessionStore(path);
    const messages: Message[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }];

    await runAgent({
      model: provider,
      tools,
      bus: new InMemoryEventBus(),
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      store,
    });

    const { messages: replayed } = await loadSession(path);
    expect(replayed).toEqual(messages); // the on-disk log replays to exactly the in-memory state
    expect(replayed.some((m) => m.role === 'tool')).toBe(true); // including the tool result
  });

  it('checkpoints a compaction so replay yields the compacted state, not the discarded prefix', async () => {
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
    const path = join(dir, 'c.jsonl');
    const store = new FileSessionStore(path);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old q1' },
      { role: 'assistant', content: 'old a1' },
      { role: 'user', content: 'recent q' },
    ];

    await runAgent({
      model: provider,
      tools,
      bus: new InMemoryEventBus(),
      messages,
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
      context: cm,
      store,
    });

    const raw = await readFile(path, 'utf8');
    expect(parseSessionLog(raw).some((r) => r.t === 'compaction')).toBe(true); // a checkpoint was written
    const { messages: replayed } = await loadSession(path);
    expect(replayed).toEqual(messages); // replay matches the final (compacted) in-memory state
    expect(replayed.some((m) => m.content === 'old q1')).toBe(false); // discarded prefix not resurrected
  });

  it('does not persist when no store is given (pre-persistence behavior)', async () => {
    const tools = new InMemoryToolRegistry();
    const { provider } = scriptedModel([{ text: 'hi' }]);
    // Simply that runAgent completes without a store and never touches disk — no throw.
    const outcome = await runAgent({
      model: provider,
      tools,
      bus: new InMemoryEventBus(),
      messages: [{ role: 'user', content: 'q' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 5 },
    });
    expect(outcome.finalText).toBe('hi');
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
