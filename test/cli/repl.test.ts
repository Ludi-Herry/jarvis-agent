import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startRepl } from '../../src/surfaces/cli/repl.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { readTool, writeTool } from '../../src/core/tools/builtins.js';
import { readFile } from 'node:fs/promises';
import { FileSessionStore, loadSession } from '../../src/runtime/session/session-store.js';
import type { Message, ToolCall } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';

interface Step {
  text?: string;
  toolCalls?: ToolCall[];
}
/** A scripted model that also records the message-history length it saw on each call, so a
 *  test can prove the conversation persisted across REPL turns. */
function fakeModel(steps: Step[]): { provider: ModelProvider; seen: number[] } {
  const seen: number[] = [];
  let i = 0;
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(messages: Message[]): AsyncGenerator<ModelDelta, ModelResult> {
      seen.push(messages.length);
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      const text = step.text ?? '';
      if (text.length > 0) yield { type: 'text', text };
      const toolCalls = step.toolCalls ?? [];
      return {
        text,
        toolCalls,
        usage: { inputTokens: 5, outputTokens: 3 },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return { provider, seen };
}

const okTool: ToolDefinition<Record<string, never>> = {
  name: 'ok',
  description: 'ok',
  capability: 'read-only',
  inputSchema: z.object({}),
  run: async () => ({ content: 'ok' }),
};

function inputOf(lines: string[]): Readable {
  const r = new Readable({ read() {} });
  r.push(lines.map((l) => `${l}\n`).join(''));
  r.push(null);
  return r;
}

function sink(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('startRepl', () => {
  it('prints the banner, streams the answer, and exits when input ends', async () => {
    const tools = new InMemoryToolRegistry();
    const { provider } = fakeModel([{ text: 'hi there' }]);
    const out = sink();

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['hello']),
      output: out.stream,
    });

    const text = out.text();
    expect(text).toContain('Jarvis-Agent · fake-model');
    expect(text).toContain('hi there');
    expect(text).toContain('› '); // prompt was shown
  });

  it('renders a tool call and its result inline', async () => {
    await writeFile(join(dir, 'fact.txt'), 'sky is teal', 'utf8');
    const tools = new InMemoryToolRegistry();
    tools.register(readTool);
    const { provider } = fakeModel([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"fact.txt"}' }] },
      { text: 'it is teal' },
    ]);
    const out = sink();

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['what color?']),
      output: out.stream,
    });

    const text = out.text();
    expect(text).toContain('⏺ read({"path":"fact.txt"})');
    expect(text).toContain('↳ sky is teal');
    expect(text).toContain('it is teal');
  });

  it('keeps one continuous conversation across multiple turns', async () => {
    const tools = new InMemoryToolRegistry();
    const { provider, seen } = fakeModel([{ text: 'a1' }, { text: 'a2' }]);
    const out = sink();

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['q1', 'q2']),
      output: out.stream,
    });

    // turn 1 saw [system, user q1]; turn 2 saw [system, user q1, assistant a1, user q2]
    expect(seen).toEqual([2, 4]);
    expect(out.text()).toContain('a1');
    expect(out.text()).toContain('a2');
  });

  it('prompts for approval on a write and runs it when the user allows (B4)', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(writeTool);
    const { provider } = fakeModel([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"note.txt","content":"approved"}' }] },
      { text: 'wrote it' },
    ]);
    const out = sink();

    // second input line "a" answers the approval prompt the write triggers
    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['write the note', 'a']),
      output: out.stream,
    });

    expect(out.text()).toContain('需要批准'); // the approval prompt was shown
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('approved'); // and the write ran
  });

  it('denies the write when the user says no — the file is never written (B4)', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(writeTool);
    const { provider } = fakeModel([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"blocked.txt","content":"x"}' }] },
      { text: 'ok, skipped' },
    ]);
    const out = sink();

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['write the file', 'd']),
      output: out.stream,
    });

    expect(out.text()).toContain('Permission denied');
    await expect(readFile(join(dir, 'blocked.txt'), 'utf8')).rejects.toThrow(); // never created
  });

  it('fails closed (deny) when no approval answer is given before input ends (B4)', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(writeTool);
    const { provider } = fakeModel([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"eof.txt","content":"x"}' }] },
      { text: 'understood' },
    ]);
    const out = sink();

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['write a file']), // no approval answer → EOF → fail-closed deny
      output: out.stream,
    });

    expect(out.text()).toContain('Permission denied');
    await expect(readFile(join(dir, 'eof.txt'), 'utf8')).rejects.toThrow();
  });

  it('resumes a session: a fresh REPL replays history and the model sees the full context (persistence)', async () => {
    const path = join(dir, 'sess.jsonl');

    // --- session 1: ask q1, store it, then "crash" (input ends) ---
    const m1 = fakeModel([{ text: 'a1' }]);
    const store1 = new FileSessionStore(path);
    await store1.writeHeader({ id: 'sess', model: 'fake', cwd: dir, startedAt: 'now' });
    await startRepl({
      model: m1.provider,
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 5,
      input: inputOf(['q1']),
      output: sink().stream,
      store: store1,
    });

    // --- session 2: resume from disk in a NEW store (simulating a fresh process) ---
    const loaded = await loadSession(path);
    const m2 = fakeModel([{ text: 'a2' }]);
    const store2 = new FileSessionStore(path, loaded.messages.length);
    await startRepl({
      model: m2.provider,
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 5,
      input: inputOf(['q2']),
      output: sink().stream,
      store: store2,
      initialMessages: loaded.messages,
    });

    // the resumed turn saw the FULL prior context: [system SYS, q1, a1, q2] = 4 messages
    expect(m2.seen[0]).toBe(4);
    // and the log now replays to the whole continuous conversation
    const final = await loadSession(path);
    expect(final.messages.map((m) => ('content' in m ? m.content : ''))).toEqual(['SYS', 'q1', 'a1', 'q2', 'a2']);
  });

  it('ignores blank lines and exits on /exit', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(okTool);
    const { provider, seen } = fakeModel([{ text: 'only once' }]);
    const out = sink();

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['', '  ', 'real question', '/exit', 'never seen']),
      output: out.stream,
    });

    expect(seen).toEqual([2]); // only the one real question reached the model
    expect(out.text()).toContain('only once');
  });
});
