import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTuiRepl } from '../../src/surfaces/cli/tui-repl.js';
import { loadTuiActionAudit } from '../../src/surfaces/cli/tui-audit.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { writeTool } from '../../src/core/tools/builtins.js';
import type { Message, ToolCall } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';

interface Step {
  text?: string;
  toolCalls?: ToolCall[];
  error?: Error;
}

function fakeModel(steps: Step[]): ModelProvider {
  let index = 0;
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
      expect(messages.length).toBeGreaterThan(0);
      const step = steps[Math.min(index, steps.length - 1)];
      index++;
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
  return provider;
}

class FakeInput extends Readable {
  public readonly isTTY = true;
  public setRawMode(): this {
    return this;
  }
  _read(): void {
    // push-driven; nothing to pull
  }
}

class FakeOutput extends Writable {
  public readonly isTTY = true;
  public columns = 80;
  public rows = 24;
  private readonly chunks: string[] = [];
  public _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  public text(): string {
    return this.chunks.join('');
  }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met before deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-tui-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('startTuiRepl', () => {
  it('runs a submitted prompt through the shared runner and exits 130 on idle Ctrl-C', async () => {
    const captures: string[] = [];
    const hooks: string[] = [];
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = startTuiRepl({
      model: fakeModel([{ text: 'tui answer' }]),
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 3,
      sessionId: 'tui-run-1',
      input,
      output,
      columns: 80,
      rows: 24,
      checkpoints: {
        capture: async (phase) => {
          captures.push(phase);
          return { checkpointId: `cp-${phase}` };
        },
      },
      hooks: {
        preToolUse: async () => ({ blocked: false, reason: '' }),
        postToolUse: async () => undefined,
        sessionStart: async () => {
          hooks.push('session-start');
        },
        sessionEnd: async () => {
          hooks.push('session-end');
        },
        roundStart: async () => undefined,
        roundEnd: async () => undefined,
      },
    });

    input.push(Buffer.from('hello tui\r'));
    await until(() => output.text().includes('tui answer'));
    // The user's submission is echoed into the message flow.
    expect(output.text()).toContain('hello tui');
    await wait(80); // let the run settle into runClosed/idle before interrupting

    input.push(Buffer.from('\x03'));
    await expect(pending).resolves.toBe(130);

    // Same shared-runner responsibilities as the line REPL: durable-prefix checkpoints and the
    // session hooks run exactly once per session.
    expect(captures).toEqual(['before-user-prompt', 'before-model-wave']);
    expect(hooks).toEqual(['session-start', 'session-end']);
    expect(output.text()).toContain('\x1b[?25h'); // terminal restored on exit
  });

  it('answers a gated write via the y key and refuses an ineligible session grant', async () => {
    const tools = new InMemoryToolRegistry();
    tools.register(writeTool);
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = startTuiRepl({
      model: fakeModel([
        { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"note.txt","content":"approved","createOnly":true}' }] },
        { text: 'written' },
      ]),
      tools,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 5,
      sessionId: 'tui-run-2',
      input,
      output,
      columns: 80,
      rows: 24,
    });

    input.push(Buffer.from('write the note\r'));
    await until(() => output.text().includes('approval-pending'));

    // 's' on a writes-files call must be refused (session grants are executes-code only) and
    // re-asked — never silently downgraded or locked in.
    input.push(Buffer.from('s'));
    await until(() => output.text().includes('session grant is shell-only'));

    input.push(Buffer.from('y'));
    await until(() => output.text().includes('written'));
    await wait(80);
    input.push(Buffer.from('\x03'));
    await expect(pending).resolves.toBe(130);

    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('approved');
  });

  it('records bounded action audit records without prompt bodies', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = startTuiRepl({
      model: fakeModel([{ text: 'done' }]),
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 3,
      sessionId: 'tui-run-3',
      input,
      output,
      columns: 80,
      rows: 24,
    });
    input.push(Buffer.from('secret prompt body\r'));
    await until(() => output.text().includes('done'));
    await wait(80);
    input.push(Buffer.from('\x03'));
    await expect(pending).resolves.toBe(130);

    const audit = await loadTuiActionAudit({ cwd: dir, sessionId: 'tui-run-3' });
    const kinds = audit.records.map((record) => record.detail.kind);
    expect(kinds).toContain('submit');
    expect(kinds).toContain('interrupt');
    expect(JSON.stringify(audit.records)).not.toContain('secret prompt body');
  });

  it('exits cleanly on /exit with code 0 and never consults the model', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = startTuiRepl({
      model: fakeModel([{ text: 'must not run' }]),
      tools: new InMemoryToolRegistry(),
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: 'SYS',
      maxTurns: 3,
      sessionId: 'tui-run-4',
      input,
      output,
      columns: 80,
      rows: 24,
    });
    input.push(Buffer.from('/exit\r'));
    await expect(pending).resolves.toBe(0);
    expect(output.text()).not.toContain('must not run');
  });
});
