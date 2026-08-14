import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildSystemPrompt } from '../../src/surfaces/cli/system-prompt.js';
import { startRepl } from '../../src/surfaces/cli/repl.js';
import { buildDefaultRegistry } from '../../src/core/tools/index.js';
import { createBashTool } from '../../src/core/tools/bash.js';
import { defaultShellPath } from '../../src/core/tools/run-command.js';
import { TASK_TOOL_NAME } from '../../src/capabilities/subagents/index.js';
import type { AgentRole } from '../../src/capabilities/subagents/index.js';
import type { Message } from '../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../src/core/model/types.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';

/** The behaviour guardrails that must survive every change to the tool list. */
const BEHAVIOUR_SENTENCES = [
  '路径都相对当前工作目录。回答需要文件内容时先调用工具读取,再据此作答;',
  '修改已有文件时先 read,再把返回的 version 作为 write.expectedVersion; 新建文件使用 createOnly:true。',
  '需要构建/测试/查看 git 等用 bash。危险或涉及密钥的操作会被权限闸门拦下或需用户批准——',
  '被拒绝时如实说明,不要绕过。不要编造文件内容。回答简洁。',
];

const fakeTool: ToolDefinition<Record<string, never>> = {
  name: 'weather',
  description: 'a tool that did not exist when the prompt was written',
  capability: 'read-only',
  inputSchema: z.object({}),
  run: async () => ({ content: 'sunny' }),
};

function fakeModel(): { provider: ModelProvider; seen: Message[][] } {
  const seen: Message[][] = [];
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
      seen.push([...messages]);
      yield { type: 'text', text: 'done' };
      return {
        text: 'done',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return { provider, seen };
}

function inputOf(lines: string[]): Readable {
  const r = new Readable({ read() {} });
  r.push(lines.map((l) => `${l}\n`).join(''));
  r.push(null);
  return r;
}

function sink(): Writable {
  return new Writable({
    write(_chunk: Buffer, _enc, cb): void {
      cb();
    },
  });
}

describe('buildSystemPrompt', () => {
  it('lists every tool name the default CLI registry offers the model', () => {
    const registry = buildDefaultRegistry();
    registry.register(createBashTool({ shellPath: defaultShellPath() }));
    const names = registry.schemasForModel().map((s) => s.name);

    const prompt = buildSystemPrompt(names);

    expect(names).toContain('bash'); // the registry really is the source (not an empty list)
    for (const name of names) expect(prompt).toContain(name);
  });

  it('picks up a newly registered tool — the drift the hardcoded list could not', () => {
    const registry = buildDefaultRegistry();
    const before = buildSystemPrompt(registry.schemasForModel().map((s) => s.name));
    expect(before).not.toContain('weather');

    registry.register(fakeTool);
    const after = buildSystemPrompt(registry.schemasForModel().map((s) => s.name));

    expect(after).toContain('weather');
    expect(after).not.toEqual(before);
  });

  it('keeps the behaviour guardrails verbatim whatever the tool list is', () => {
    for (const prompt of [buildSystemPrompt(['read']), buildSystemPrompt(['a', 'b', 'c'])]) {
      for (const sentence of BEHAVIOUR_SENTENCES) expect(prompt).toContain(sentence);
    }
  });

  it('states the truth instead of a dangling list when no tool is registered', () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain('当前没有注册任何工具');
    expect(prompt).not.toContain('你可以调用这些工具:');
    for (const sentence of BEHAVIOUR_SENTENCES) expect(prompt).toContain(sentence);
  });
});

describe('startRepl systemPrompt builder', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-sysprompt-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('derives the prompt AFTER the roster-dependent task tool is registered', async () => {
    const tools = buildDefaultRegistry();
    const { provider, seen } = fakeModel();
    const roster: AgentRole[] = [
      { name: 'scout', description: 'read-only explorer', systemPrompt: 'you scout' },
    ];

    await startRepl({
      model: provider,
      tools,
      roster,
      cwd: dir,
      modelName: 'fake-model',
      systemPrompt: buildSystemPrompt,
      maxTurns: 3,
      input: inputOf(['hi']),
      output: sink(),
    });

    const system = seen[0]?.[0];
    expect(system?.role).toBe('system');
    const text = typeof system?.content === 'string' ? system.content : '';
    expect(text).toContain(TASK_TOOL_NAME); // the registration the old hardcoded list missed
    for (const name of ['read', 'write', 'grep']) expect(text).toContain(name);
  });
});
