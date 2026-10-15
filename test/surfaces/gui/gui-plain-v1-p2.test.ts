/**
 * plain-v1 P2 (docs/PLAN-gui-plain-v1.md): 「这个任务都允许」, composer permission modes and
 * task-scoped 撤销/恢复, end-to-end through GuiSessionHost with a deterministic provider, real
 * tools, a real Git fixture and real persistence. Same harness shape as gui-live-session.test.ts.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { Message, ToolCall } from '../../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import { GuiSessionHost, type GuiTaskDefinition } from '../../../src/surfaces/gui/live-session.js';
import type { GuiLiveSnapshot } from '../../../src/surfaces/gui/live-types.js';

function model(next: (messages: Message[], wave: number) => Promise<ToolCall[] | string> | ToolCall[] | string): ModelProvider {
  let wave = 0;
  const provider: ModelProvider = {
    capability: { maxContextTokens: 100_000, maxOutputTokens: 16_384, thinking: false, toolUse: true, imageIn: false, videoIn: false },
    async *call(messages): AsyncGenerator<ModelDelta, ModelResult> {
      const answer = await next(messages, wave++);
      const text = typeof answer === 'string' ? answer : '正在执行任务';
      yield { type: 'text', text };
      return { text, toolCalls: typeof answer === 'string' ? [] : answer, usage: { inputTokens: 15, outputTokens: 5 }, finishReason: typeof answer === 'string' ? 'completed' : 'tool_calls', rawFinishReason: typeof answer === 'string' ? 'stop' : 'tool_calls' };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall { return { id, name, arguments: JSON.stringify(args) }; }

async function fixture(provider: ModelProvider, overrides: Partial<GuiTaskDefinition> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-plain-v1-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, 'package.json'), '{"type":"module","scripts":{"verify":"node --check answer.mjs"}}\n', 'utf8');
  // autocrlf off keeps the byte-level assertions independent of the machine's global Git config.
  for (const command of ['git init -q', 'git config core.autocrlf false', 'git add -- seed.txt package.json', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    expect(result.code, result.output).toBe(0);
  }
  const task: GuiTaskDefinition = { objective: '为模块提供导出的值，并用真实语法检查验收', cwd, requirements: ['文件包含经过调整的实际交付内容'], writePaths: ['answer.mjs'],
    checkCommands: ['node --check answer.mjs'], maxRounds: 1, maxTurns: 6, wallClockMs: 30_000,
    pricing: { inputCnyPerMillion: 1, outputCnyPerMillion: 2, source: 'deterministic fixture rate' }, ...overrides };
  const options = { cwd, dataDir: join(cwd, 'data'), task, provider };
  return { cwd, task, options, host: new GuiSessionHost(options) };
}

async function until(host: GuiSessionHost, id: string, predicate: (snapshot: GuiLiveSnapshot) => boolean): Promise<GuiLiveSnapshot> {
  const start = Date.now();
  let latest: GuiLiveSnapshot;
  do {
    latest = await host.snapshot(id);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() - start < 12_000);
  throw new Error(`state wait expired: ${JSON.stringify({ status: latest!.status, phase: latest!.phase, warnings: latest!.warnings })}`);
}

/** The pinned --task-file contract registers as 待启动 at first access. */
async function registered(host: GuiSessionHost): Promise<string> {
  const pending = (await host.overview()).sessions.at(-1);
  if (!pending) throw new Error('pinned task was not registered');
  return pending.id;
}

const settled = (s: GuiLiveSnapshot) => !s.capabilities.stop && s.status === 'blocked';

describe('GUI plain-v1 P2: allow-session, permission modes, task-scoped undo', () => {
  it('「这个任务都允许」 (allow-session) lets the rest of this task\'s contract writes through without asking again', async () => {
    const { host, cwd } = await fixture(model((_messages, wave) => wave === 0
      ? [call('w1', 'write', { path: 'answer.mjs', content: 'export const value = 1;\n', createOnly: true })]
      : wave === 1 ? [call('w2', 'write', { path: 'extra.mjs', content: 'export const extra = 2;\n', createOnly: true })]
      : '两个文件都写好了'), { writePaths: ['answer.mjs', 'extra.mjs'] });
    try {
      const id = (await host.startTask(await registered(host))).id;
      const pending = await until(host, id, (s) => s.approval !== null);
      expect(pending.approval!.sessionScope).toBe('tool');
      await expect(host.decision(id, pending.approval!.requestId, 'allow-forever')).rejects.toThrow('allow-session');
      await host.decision(id, pending.approval!.requestId, 'allow-session');
      const done = await until(host, id, settled);
      expect(await readFile(join(cwd, 'answer.mjs'), 'utf8')).toBe('export const value = 1;\n');
      expect(await readFile(join(cwd, 'extra.mjs'), 'utf8')).toBe('export const extra = 2;\n');
      expect(done.approvalHistory.map((item) => item.decision)).toEqual(['allow-session']);
      expect(done.completion.granted).toBe(false);
    } finally { await host.dispose(); }
  }, 30_000);

  it('只讨论 (discuss) refuses writes without asking and tells the model why', async () => {
    let sawReason = false;
    const { host, cwd } = await fixture(model((messages, wave) => {
      if (wave === 0) return [call('w', 'write', { path: 'answer.mjs', content: 'export const value = 1;\n', createOnly: true })];
      sawReason = messages.some((message) => message.role === 'tool' && message.content.includes('只讨论'));
      return '方案：新建 answer.mjs 导出 value = 1。等你切到「改之前问我」再动手。';
    }));
    try {
      const id = await registered(host);
      await host.setPermissionMode(id, 'discuss');
      await host.startTask(id);
      const done = await until(host, id, settled);
      expect(sawReason).toBe(true);
      expect(existsSync(join(cwd, 'answer.mjs'))).toBe(false);
      expect(done.approvalHistory).toEqual([]);
      expect(done.permissionMode).toBe('discuss');
    } finally { await host.dispose(); }
  }, 30_000);

  it('自动 (auto) applies contract writes without an approval and still refuses files outside the contract', async () => {
    const { host, cwd } = await fixture(model((_messages, wave) => wave === 0
      ? [call('w1', 'write', { path: 'answer.mjs', content: 'export const value = 1;\n', createOnly: true })]
      : wave === 1 ? [call('w2', 'write', { path: 'outside.mjs', content: 'export const no = 0;\n', createOnly: true })]
      : '写好了'));
    try {
      const id = await registered(host);
      await host.setPermissionMode(id, 'auto');
      await host.startTask(id);
      const done = await until(host, id, settled);
      expect(await readFile(join(cwd, 'answer.mjs'), 'utf8')).toBe('export const value = 1;\n');
      expect(existsSync(join(cwd, 'outside.mjs'))).toBe(false);
      expect(done.approvalHistory).toEqual([]);
    } finally { await host.dispose(); }
  }, 30_000);

  it('自动 (auto) still asks before a shell command, and its allow-session is command-scoped', async () => {
    const { host } = await fixture(model((_messages, wave) => wave === 0
      ? [call('sh', 'bash', { command: 'node --version' })]
      : '命令跑完了'), { shellCommands: ['node --version'] });
    try {
      const id = await registered(host);
      await host.setPermissionMode(id, 'auto');
      await host.startTask(id);
      const pending = await until(host, id, (s) => s.approval !== null);
      expect(pending.approval!.capability).toBe('executes-code');
      expect(pending.approval!.sessionScope).toBe('command');
      await host.decision(id, pending.approval!.requestId, 'allow-once');
      await until(host, id, settled);
    } finally { await host.dispose(); }
  }, 30_000);

  it('journals the mode, rejects unknown modes and keeps the mode across reload', async () => {
    const { host, options } = await fixture(model(() => '不会启动'));
    try {
      const id = await registered(host);
      await expect(host.setPermissionMode(id, 'yolo')).rejects.toMatchObject({ status: 400 });
      expect((await host.snapshot(id)).permissionMode).toBeUndefined();
      const first = await host.setPermissionMode(id, 'auto');
      const again = await host.setPermissionMode(id, 'auto');
      expect(again.sequence).toBe(first.sequence); // an unchanged mode appends nothing
      expect(again.permissionMode).toBe('auto');
      expect((await new GuiSessionHost(options).snapshot(id)).permissionMode).toBe('auto');
    } finally { await host.dispose(); }
  }, 30_000);

  it('撤销 restores the contract files to the task-start baseline, 恢复 brings them back, and the user index is untouched', async () => {
    const { host, cwd, options } = await fixture(model((_messages, wave) => wave === 0
      ? [call('w', 'write', { path: 'answer.mjs', content: 'export const value = 1;\n', createOnly: true })]
      : '写好了'), { writePaths: ['answer.mjs', 'seed.txt'] });
    const indexBefore = await readFile(join(cwd, '.git', 'index'));
    try {
      const id = (await host.startTask(await registered(host))).id;
      const pending = await until(host, id, (s) => s.approval !== null);
      const busy = await host.undoPlan(id);
      expect(busy).toMatchObject({ available: false, token: null });
      expect(busy.reason).toContain('进行中');
      await host.decision(id, pending.approval!.requestId, 'allow-once');
      await until(host, id, settled);

      // A hand edit of another contract file after the task is part of what undo shows and restores.
      await writeFile(join(cwd, 'seed.txt'), 'edited after the task\n', 'utf8');
      const plan = await host.undoPlan(id);
      expect(plan).toMatchObject({ kind: 'undo', available: true, files: [{ path: 'answer.mjs', change: 'added' }, { path: 'seed.txt', change: 'modified' }] });

      // Confirming a stale view is refused; nothing on disk changes.
      await writeFile(join(cwd, 'seed.txt'), 'edited again\n', 'utf8');
      await expect(host.undo(id, 'undo', plan.token!)).rejects.toMatchObject({ status: 409 });
      expect(existsSync(join(cwd, 'answer.mjs'))).toBe(true);

      const fresh = await host.undoPlan(id);
      const undone = await host.undo(id, 'undo', fresh.token!);
      expect(existsSync(join(cwd, 'answer.mjs'))).toBe(false);
      expect(await readFile(join(cwd, 'seed.txt'), 'utf8')).toBe('fixture baseline\n');
      expect(undone.undo).toMatchObject({ state: 'undone' });
      expect(undone.diff.trim()).toBe('');
      expect((await host.undoPlan(id)).kind).toBe('redo');

      const redoPlan = await host.undoPlan(id);
      expect(redoPlan.available).toBe(true);
      const redone = await host.undo(id, 'redo', redoPlan.token!);
      expect(await readFile(join(cwd, 'answer.mjs'), 'utf8')).toBe('export const value = 1;\n');
      expect(await readFile(join(cwd, 'seed.txt'), 'utf8')).toBe('edited again\n');
      expect(redone.undo).toMatchObject({ state: 'redone' });
      expect((await new GuiSessionHost(options).snapshot(id)).undo).toMatchObject({ state: 'redone' });
      expect(await readFile(join(cwd, '.git', 'index'))).toEqual(indexBefore);
    } finally { await host.dispose(); }
  }, 30_000);
});
