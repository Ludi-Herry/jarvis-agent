import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startRepl } from '../../src/surfaces/cli/repl.js';
import { SkillRegistry, SKILL_REGISTRY_ADDENDUM_SOURCE } from '../../src/capabilities/index.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { readTool, writeTool } from '../../src/core/tools/builtins.js';
import { readFile } from 'node:fs/promises';
import { FileSessionStore, createSessionComposition, loadSession } from '../../src/runtime/session/session-store.js';
import { AgentEventWriter } from '../../src/runtime/agent-events.js';
import type { Message, ToolCall } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';

interface Step {
  text?: string;
  toolCalls?: ToolCall[];
  error?: Error;
}
const composition = createSessionComposition({
  root: 'repl',
  runtimeVersion: 'test',
  permissionMode: 'interactive',
});
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
      if (step.error !== undefined) throw step.error;
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
  it('captures the durable prefix before a user prompt and again before provider I/O', async () => {
    const captures: Array<{ phase: string; contents: string[] }> = [];
    const { provider } = fakeModel([{ text: 'done' }]);

    await startRepl({
      model: provider,
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 1,
      input: inputOf(['question']),
      output: sink().stream,
      checkpoints: {
        capture: async (phase, messages) => {
          captures.push({
            phase,
            contents: messages.map((message) => 'content' in message ? message.content ?? '' : ''),
          });
          return { checkpointId: `cp-${phase}` };
        },
      },
    });

    expect(captures).toEqual([
      { phase: 'before-user-prompt', contents: ['SYS'] },
      { phase: 'before-model-wave', contents: ['SYS', 'question'] },
    ]);
  });

  it('creates a manual checkpoint without sending a model request', async () => {
    const manual: string[] = [];
    const model = fakeModel([{ text: 'must not run' }]);
    const out = sink();

    await startRepl({
      model: model.provider,
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 1,
      input: inputOf(['/checkpoint', '/exit']),
      output: out.stream,
      checkpoints: {
        capture: async (phase) => {
          manual.push(phase);
          return { checkpointId: 'cp-manual' };
        },
      },
    });

    expect(manual).toEqual(['manual']);
    expect(model.seen).toEqual([]);
    expect(out.text()).toContain('cp-manual');
  });

  it('runs one headless prompt, emits a terminal event, and never grants conversational completion', async () => {
    const lines: string[] = [];
    const writer = new AgentEventWriter({
      invocationId: 'session-headless',
      defaultSessionId: 'session-headless',
      root: 'run',
      cwd: dir,
      writeLine: (line) => lines.push(line),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    writer.sessionStarted({ sessionId: 'session-headless', resumed: false, model: 'fake-model' });

    const exitCode = await startRepl({
      model: fakeModel([{ text: 'done' }]).provider,
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 1,
      sessionId: 'session-headless',
      initialPrompt: 'run once',
      singlePrompt: true,
      agentEvents: writer,
      approver: async () => 'deny',
      input: inputOf([]),
      output: sink().stream,
    });

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exitCode).toBe(0);
    expect(records.map((record) => record.type)).toEqual([
      'session.started', 'model.started', 'model.finished', 'run.finished',
    ]);
    expect(records.at(-1)).toMatchObject({
      status: 'completed',
      exitCode: 0,
      completion: { granted: false, authority: 'none' },
    });
  });

  it('closes a single-prompt model timeout as failed with runtime exit 5', async () => {
    const lines: string[] = [];
    const writer = new AgentEventWriter({
      invocationId: 'session-timeout',
      defaultSessionId: 'session-timeout',
      root: 'run',
      cwd: dir,
      writeLine: (line) => lines.push(line),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    writer.sessionStarted({ sessionId: 'session-timeout', resumed: false, model: 'hanging-model' });
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
        await new Promise<never>(() => undefined);
        yield* [];
        return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'completed', rawFinishReason: 'stop' };
      },
      withThinking: () => provider,
      withMaxCompletionTokens: () => provider,
    };

    vi.useFakeTimers();
    try {
      const pending = startRepl({
        model: provider,
        tools: new InMemoryToolRegistry(),
        cwd: dir,
        modelName: 'hanging-model',
        systemPrompt: 'sys',
        maxTurns: 1,
        sessionId: 'session-timeout',
        initialPrompt: 'run once',
        singlePrompt: true,
        agentEvents: writer,
        approver: async () => 'deny',
        input: inputOf([]),
        output: sink().stream,
      });
      await vi.advanceTimersByTimeAsync(120_000);

      expect(await pending).toBe(5);
    } finally {
      vi.useRealTimers();
    }

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.type)).toEqual([
      'session.started', 'model.started', 'model.finished', 'run.finished',
    ]);
    expect(records[2]).toMatchObject({ type: 'model.finished', status: 'timed-out' });
    expect(records.at(-1)).toMatchObject({
      type: 'run.finished',
      status: 'failed',
      exitCode: 5,
      completion: { granted: false, authority: 'none' },
    });
  });

  it('single-lines control sequences in the model banner', async () => {
    const attack = `model${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[31m\r\nFORGED-BANNER`;
    const out = sink();

    await startRepl({
      model: fakeModel([{ text: '' }]).provider,
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: attack,
      systemPrompt: 'sys',
      maxTurns: 1,
      input: inputOf(['/exit']),
      output: out.stream,
    });

    expect(out.text()).not.toContain(String.fromCharCode(27));
    expect(out.text()).not.toContain('\r');
    expect(out.text()).not.toContain('\nFORGED-BANNER');
    expect(out.text()).toContain('Jarvis-Agent · model [2J [31m FORGED-BANNER');
  });

  it('single-lines control sequences in provider run errors', async () => {
    const attack = `provider${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[31m\r\nFORGED-REPL-LINE`;
    const { provider } = fakeModel([{ error: new Error(attack) }]);
    const out = sink();

    await startRepl({
      model: provider,
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 1,
      input: inputOf(['trigger', '/exit']),
      output: out.stream,
    });

    expect(out.text()).not.toContain(String.fromCharCode(27));
    expect(out.text()).not.toContain('\r');
    expect(out.text()).not.toContain('\nFORGED-REPL-LINE');
    expect(out.text()).toContain('出错: provider [2J [31m FORGED-REPL-LINE');
  });

  it('runs an initial prompt before reading interactive input', async () => {
    const tools = new InMemoryToolRegistry();
    const { provider, seen } = fakeModel([{ text: 'initial answer' }]);
    const out = sink();

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      initialPrompt: 'initial question',
      input: inputOf(['/exit']),
      output: out.stream,
    });

    expect(seen).toEqual([2]);
    expect(out.text()).toContain('initial answer');
  });

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

  it('runs SessionStart/SessionEnd once for the whole REPL session', async () => {
    const tools = new InMemoryToolRegistry();
    const { provider } = fakeModel([{ text: 'one' }, { text: 'two' }]);
    const out = sink();
    const calls: string[] = [];

    await startRepl({
      model: provider,
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'sys',
      maxTurns: 5,
      input: inputOf(['hello', 'again', '/exit']),
      output: out.stream,
      hooks: {
        preToolUse: async () => ({ blocked: false, reason: '' }),
        postToolUse: async () => undefined,
        sessionStart: async () => {
          calls.push('session-start');
        },
        sessionEnd: async () => {
          calls.push('session-end');
        },
        roundStart: async () => undefined,
        roundEnd: async () => undefined,
      },
    });

    expect(calls).toEqual(['session-start', 'session-end']);
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
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"note.txt","content":"approved","createOnly":true}' }] },
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
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"blocked.txt","content":"x","createOnly":true}' }] },
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
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"eof.txt","content":"x","createOnly":true}' }] },
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
    await store1.writeHeader({ id: 'sess', model: 'fake', cwd: dir, startedAt: 'now', composition });
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
    const store2 = new FileSessionStore(path, loaded.messages.length, {
      format: loaded.format,
      initialSequence: loaded.lastSequence,
    });
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

  it('persists skill addendum receipts that the same dynamic composition can prove on resume', async () => {
    const path = join(dir, 'dynamic-session.jsonl');
    const skills = new SkillRegistry([{
      name: 'git-commit',
      description: 'write a commit',
      triggers: ['commit'],
      body: 'FULL-COMMIT-RULES',
    }]);
    const dynamicComposition = createSessionComposition({
      root: 'repl',
      runtimeVersion: 'test',
      permissionMode: 'interactive',
      toolSchemas: [],
      systemPrompt: 'SYS',
      dynamicAddendum: { source: SKILL_REGISTRY_ADDENDUM_SOURCE, manifest: skills.list() },
    });
    const store = new FileSessionStore(path);
    await store.writeHeader({ id: 'dynamic', model: 'fake', cwd: dir, startedAt: 'now', composition: dynamicComposition });
    const { provider } = fakeModel([{ text: 'done' }]);

    await startRepl({
      model: provider,
      tools: new InMemoryToolRegistry(),
      skills,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 5,
      input: inputOf(['please commit this']),
      output: sink().stream,
      store,
    });

    await expect(loadSession(path, {
      requireHeader: true,
      resume: {
        expectedComposition: dynamicComposition,
        resolveDynamicAddendum: (activationText) => skills.systemAddendum(activationText),
      },
    })).resolves.toMatchObject({ requests: [expect.objectContaining({ systemAddendumHash: expect.stringMatching(/^sha256\./) })] });
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
