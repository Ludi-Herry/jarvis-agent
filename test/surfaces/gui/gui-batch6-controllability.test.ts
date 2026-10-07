import { writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { Message, ToolCall } from '../../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import { GuiSessionHost, type GuiTaskDefinition } from '../../../src/surfaces/gui/live-session.js';
import { applyGuiEvent } from '../../../src/surfaces/gui/live-projection.js';
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

async function sessionFixture(provider: ModelProvider) {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b6-test-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), 'data/\n', 'utf8');
  for (const command of ['git init -q', 'git add -- seed.txt .gitignore', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    expect(result.code, result.output).toBe(0);
  }
  const task: GuiTaskDefinition = { objective: '为模块提供导出的值，并用真实语法检查验收', cwd, requirements: ['文件包含经过调整的实际交付内容'], writePaths: ['answer.mjs'],
    checkCommands: ['node --check answer.mjs'], maxRounds: 1, maxTurns: 6, wallClockMs: 30_000 };
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
  throw new Error(`state wait expired: ${JSON.stringify({ status: latest!.status, phase: latest!.phase, warnings: latest!.warnings, completion: latest!.completion })}`);
}

/** Pinned --task-file contracts register as 待启动 at first access; start goes through startTask(id). */
async function startPinned(host: GuiSessionHost): Promise<GuiLiveSnapshot> {
  const overview = await host.overview();
  const pending = overview.sessions.at(-1);
  if (!pending) throw new Error('pinned task was not registered');
  return host.startTask(pending.id);
}

function bareSnapshot(): GuiLiveSnapshot {
  return {
    id: 'gui-b6', sequence: 0, objective: 'o', cwd: 'H:\\tmp', model: 'm', sessionId: 'gui-b6', goalId: 'gui-b6',
    status: 'idle', phase: '', nextAction: '', startedAt: '2026-10-07T00:00:00Z', elapsedMs: 0,
    messages: [], tools: [], approval: null, approvalHistory: [], pendingInputs: [],
    completion: { granted: false, verdict: 'none', rationale: '' }, evidenceToken: null, review: null,
    checks: [], diff: '', artifacts: [], usage: { inputTokens: 0, outputTokens: 0, costCny: null, costNote: '' },
    limits: { maxRounds: 1, maxTurns: 6, turnTimeoutMs: 120_000, wallClockMs: 30_000 },
    sources: { session: 's', goal: 'g', approvals: 'a', events: 'e' }, warnings: [],
    capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
  };
}

describe('批6 gui_input_withdrawn 投影折叠（journal 确定性）', () => {
  it('splices a valid index, ignores out-of-range, and stays consistent under consumed', () => {
    const snapshot = bareSnapshot();
    applyGuiEvent(snapshot, { type: 'gui_input_queued', text: 'A' });
    applyGuiEvent(snapshot, { type: 'gui_input_queued', text: 'B' });
    expect(snapshot.pendingInputs).toEqual(['A', 'B']);
    applyGuiEvent(snapshot, { type: 'gui_input_withdrawn', index: 0, text: 'A' });
    expect(snapshot.pendingInputs).toEqual(['B']);
    // 越界与非法索引一律 no-op：边界竞态或旧 journal 不会弄坏队列
    applyGuiEvent(snapshot, { type: 'gui_input_withdrawn', index: 5, text: 'X' });
    applyGuiEvent(snapshot, { type: 'gui_input_withdrawn', index: -1, text: 'X' });
    applyGuiEvent(snapshot, { type: 'gui_input_withdrawn', index: 'not-a-number', text: 'X' });
    expect(snapshot.pendingInputs).toEqual(['B']);
    applyGuiEvent(snapshot, { type: 'gui_inputs_consumed', count: 1 });
    expect(snapshot.pendingInputs).toEqual([]);
  });

  it('queued → withdrawn → consumed replays deterministically from a fresh state', () => {
    const events = [
      { type: 'gui_input_queued', text: 'A' },
      { type: 'gui_input_queued', text: 'B' },
      { type: 'gui_input_withdrawn', index: 0, text: 'A' },
      { type: 'gui_input_queued', text: 'C' },
      { type: 'gui_inputs_consumed', count: 1 },
    ];
    const live = bareSnapshot();
    const replayed = bareSnapshot();
    for (const event of events) {
      applyGuiEvent(live, event);
      applyGuiEvent(replayed, event);
    }
    expect(replayed.pendingInputs).toEqual(['C']);
    expect(replayed.pendingInputs).toEqual(live.pendingInputs);
  });
});

describe('批6 withdrawInput 服务端边界（§可控：已送达不可撤回）', () => {
  it('splices the queue, 409s out-of-range, and 409s again after the run settles', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { host } = await sessionFixture(model(async (_messages, wave) => {
      // A tool-call first wave forces the next beforeModelWave boundary where pause engages.
      if (wave === 0) { await held; return [call('read', 'read', { path: 'seed.txt' })]; }
      return '我已完成';
    }));
    try {
      const started = await startPinned(host);
      await until(host, started.id, (s) => s.status === 'running');
      await host.control(started.id, 'pause');
      release();
      await until(host, started.id, (s) => s.status === 'paused');
      await host.input(started.id, 'A');
      expect((await host.snapshot(started.id)).pendingInputs).toEqual(['A']);
      const withdrawn = await host.withdrawInput(started.id, 0);
      expect(withdrawn.pendingInputs).toEqual([]);
      await expect(host.withdrawInput(started.id, 3)).rejects.toMatchObject({ status: 409 });
      await host.control(started.id, 'continue');
      await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'blocked');
      await expect(host.withdrawInput(started.id, 0)).rejects.toMatchObject({ status: 409 });
      expect((await host.snapshot(started.id)).pendingInputs).toEqual([]);
    } finally { release(); await host.dispose(); }
  }, 30_000);

  it('withdrawn input never reaches the model across the next processing boundary', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const delivered: string[] = [];
    const { host } = await sessionFixture(model(async (messages, wave) => {
      if (wave === 0) { await held; return [call('read', 'read', { path: 'seed.txt' })]; }
      for (const message of messages) {
        if (message.role === 'user' && typeof message.content === 'string') delivered.push(message.content);
      }
      return '我已完成';
    }));
    try {
      const started = await startPinned(host);
      await until(host, started.id, (s) => s.status === 'running');
      await host.control(started.id, 'pause');
      release();
      await until(host, started.id, (s) => s.status === 'paused');
      await host.input(started.id, 'A');
      expect((await host.snapshot(started.id)).pendingInputs).toEqual(['A']);
      await host.withdrawInput(started.id, 0);
      await host.control(started.id, 'continue');
      const stopped = await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'blocked');
      expect(delivered).not.toContain('A');
      expect(stopped.pendingInputs).toEqual([]);
    } finally { release(); await host.dispose(); }
  }, 30_000);
});
