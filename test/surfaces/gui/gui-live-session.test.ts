import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { Message, ToolCall } from '../../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import { GuiSessionHost, type GuiTaskDefinition } from '../../../src/surfaces/gui/live-session.js';
import { applyGuiEvent } from '../../../src/surfaces/gui/live-projection.js';
import { createGuiServer } from '../../../src/surfaces/gui/gui-server.js';
import type { GuiLiveSnapshot } from '../../../src/surfaces/gui/live-types.js';
import { loadSession } from '../../../src/runtime/session/session-store.js';

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

async function fixture(provider: ModelProvider, objective = '为模块提供导出的值，并用真实语法检查验收') {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-p3-test-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, 'package.json'), '{"type":"module","scripts":{"verify":"node --check answer.mjs"}}\n', 'utf8');
  for (const command of ['git init -q', 'git add -- seed.txt package.json', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    expect(result.code, result.output).toBe(0);
  }
  const task: GuiTaskDefinition = { objective, cwd, requirements: ['文件包含经过调整的实际交付内容'], writePaths: ['answer.mjs'],
    checkCommands: ['node --check answer.mjs'], maxRounds: 1, maxTurns: 6, wallClockMs: 30_000,
    pricing: { inputCnyPerMillion: 1, outputCnyPerMillion: 2, source: 'deterministic fixture rate' } };
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

describe('GUI real Runtime connection (deterministic provider, real tools and persistence)', () => {
  it('keeps a large SSE snapshot open after backpressure instead of treating drain as disconnection', async () => {
    const { host, task, cwd } = await fixture(model(() => 'large-output '.repeat(8000)));
    const server = createGuiServer({ cwd, dataDir: join(cwd, 'data'), liveHost: host });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const controller = new AbortController();
    try {
      const started = await host.start(task.objective);
      await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'blocked');
      const stream = await fetch(`http://127.0.0.1:${address.port}/api/live/${started.id}/events`, { signal: controller.signal });
      const reader = stream.body!.getReader();
      let frame = '';
      while (!frame.endsWith('\n\n')) {
        const item = await reader.read();
        expect(item.done).toBe(false);
        frame += new TextDecoder().decode(item.value);
      }
      expect(frame.length).toBeGreaterThan(64_000);
      const closed = await Promise.race([reader.read().then((item) => item.done), new Promise<string>((resolve) => setTimeout(() => resolve('open'), 150))]);
      expect(closed).toBe('open');
      controller.abort();
    } finally { controller.abort(); await host.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30_000);
  it('rejects approval of evidence changed after checks instead of verifying a stale review', async () => {
    const { host, task, cwd } = await fixture(model((_messages, wave) => wave === 0
      ? [call('write', 'write', { path: 'answer.mjs', content: 'export const value=2;', createOnly: true })]
      : wave === 1 ? [call('claim', 'update_goal', { status: 'complete' })] : '等待验收'));
    try {
      const started = await host.start(task.objective);
      const pending = await until(host, started.id, (s) => s.approval !== null);
      await host.decision(started.id, pending.approval!.requestId, 'allow-once');
      await until(host, started.id, (s) => !s.capabilities.stop && s.review !== null);
      await writeFile(join(cwd, 'answer.mjs'), 'invalid syntax {{{', 'utf8');
      // Re-read the page right before submitting: settle events may advance the sequence between
      // the wait and the call, and the guard under test is the evidence fingerprint, not paging.
      const fresh = await host.snapshot(started.id);
      await expect(host.review(started.id, [{ requirementId: 'R1', decision: 'approve', note: '旧页面上的同意' }],
        { sequence: fresh.sequence, evidenceToken: fresh.evidenceToken! })).rejects.toThrow('证据已变化');
      expect((await host.snapshot(started.id)).completion.granted).toBe(false);
      expect((await host.snapshot(started.id)).status).toBe('blocked');
    } finally { await host.dispose(); }
  }, 30_000);

  it('preserves the user Git index and detects an oracle change relative to the private baseline', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { host, task, cwd } = await fixture(model(async (_messages, wave) => {
      if (wave === 0) return [call('write', 'write', { path: 'answer.mjs', content: 'export const value=2;', createOnly: true })];
      if (wave === 1) { await held; return [call('claim', 'update_goal', { status: 'complete' })]; }
      return '等待检查';
    }));
    const indexBefore = await readFile(join(cwd, '.git', 'index'));
    try {
      const started = await host.start(task.objective);
      const pending = await until(host, started.id, (s) => s.approval !== null);
      await host.decision(started.id, pending.approval!.requestId, 'allow-once');
      await until(host, started.id, (s) => s.tools.some((tool) => tool.status === 'committed'));
      await writeFile(join(cwd, 'package.json'), '{"type":"module","scripts":{"verify":"exit 0"}}\n', 'utf8');
      release();
      const blocked = await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'blocked');
      expect(blocked.completion).toMatchObject({ granted: false, verdict: 'rejected' });
      expect(await readFile(blocked.sources.goal, 'utf8')).toContain('weakened-or-deleted');
      expect(await readFile(join(cwd, '.git', 'index'))).toEqual(indexBefore);
    } finally { release(); await host.dispose(); }
  }, 30_000);

  it('uses the original absolute deadline when a near-expiry active session resumes', async () => {
    const original = await fixture(model(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return 'source'; }));
    const started = await original.host.start(original.task.objective);
    await until(original.host, started.id, (s) => s.status === 'running');
    const recoveredData = join(original.cwd, 'deadline-copy');
    await cp(original.options.dataDir, recoveredData, { recursive: true });
    await original.host.dispose();
    const journalPath = join(recoveredData, 'gui', `${started.id}.jsonl`);
    const lines = (await readFile(journalPath, 'utf8')).trimEnd().split('\n');
    const created = JSON.parse(lines[0]) as { at: string; task: GuiTaskDefinition };
    // Synthetic copied fixture only: simulate a crash just before the immutable deadline.
    created.at = new Date(Date.now() - created.task.wallClockMs + 300).toISOString();
    lines[0] = JSON.stringify(created);
    await writeFile(journalPath, `${lines.join('\n')}\n`, 'utf8');
    const host = new GuiSessionHost({ ...original.options, dataDir: recoveredData, provider: model(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return [call('late-write', 'write', { path: 'answer.mjs', content: 'late', createOnly: true })];
    }) });
    try {
      await host.control(started.id, 'resume');
      const blocked = await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'blocked');
      expect(blocked.phase).toContain('总时限');
      expect(blocked.tools).toEqual([]);
      expect(existsSync(join(original.cwd, 'answer.mjs'))).toBe(false);
      expect(blocked.completion.granted).toBe(false);
    } finally { await host.dispose(); }
  }, 30_000);
  it('serializes concurrent recovery of an active crash snapshot without losing persisted messages', async () => {
    const original = await fixture(model(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return 'interrupted source'; }));
    const started = await original.host.start(original.task.objective);
    await until(original.host, started.id, (snapshot) => snapshot.status === 'running');
    const recoveredData = join(original.cwd, 'crash-copy');
    await cp(original.options.dataDir, recoveredData, { recursive: true });
    await original.host.dispose();
    let modelCalls = 0;
    const host = new GuiSessionHost({ ...original.options, dataDir: recoveredData, provider: model(() => { modelCalls++; return '没有完成授权的正常回答'; }) });
    try {
      const restored = await host.snapshot(started.id);
      expect(restored.status).toBe('recoverable');
      const answers = await Promise.allSettled([host.control(started.id, 'resume'), host.control(started.id, 'resume')]);
      expect(answers.filter((answer) => answer.status === 'fulfilled')).toHaveLength(1);
      const rejected = answers.find((answer) => answer.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason.status : null).toBe(409);
      const finished = await until(host, started.id, (snapshot) => !snapshot.capabilities.stop && snapshot.status === 'blocked');
      expect(modelCalls).toBe(1);
      expect(finished.messages.filter((message) => message.role === 'user')).toHaveLength(1);
      expect(finished.completion.granted).toBe(false);
      expect(new Set(finished.messages.map((message) => message.id)).size).toBe(finished.messages.length);
    } finally { await host.dispose(); }
  }, 30_000);
  it('routes a reasoned denial into the next execution, persists evidence and grants only via existing human review', async () => {
    let receivedCorrection = false;
    const provider = model((messages, wave) => {
      if (wave === 0) return [call('write-1', 'write', { path: 'answer.mjs', content: 'export const value = 1;\n', createOnly: true })];
      if (wave === 1) {
        receivedCorrection = messages.some((message) => message.role === 'tool' && message.content.includes('请改为 2'));
        return [call('write-2', 'write', { path: 'answer.mjs', content: `export const value = ${receivedCorrection ? 2 : 1};\n`, createOnly: true })];
      }
      if (wave === 2) return [call('claim', 'update_goal', { status: 'complete' })];
      return '交付物已写入，等待 Runtime 和用户验收';
    });
    const { host, options, cwd, task } = await fixture(provider);
    try {
      const started = await host.start(task.objective);
      const first = await until(host, started.id, (s) => s.approval !== null);
      expect(first.completion.granted).toBe(false);
      await host.decision(started.id, first.approval!.requestId, 'deny', '请改为 2');
      const second = await until(host, started.id, (s) => s.approval !== null && s.approval.requestId !== first.approval!.requestId);
      expect(receivedCorrection).toBe(true);
      expect(existsSync(join(cwd, 'answer.mjs'))).toBe(false);
      await expect(host.decision(started.id, first.approval!.requestId, 'allow-once')).rejects.toThrow('失效');
      await host.decision(started.id, second.approval!.requestId, 'allow-once');
      const parked = await until(host, started.id, (s) => !s.capabilities.stop && s.review !== null);
      expect(parked.completion).toMatchObject({ granted: false, verdict: 'couldNotVerify' });
      expect(await readFile(join(cwd, 'answer.mjs'), 'utf8')).toBe('export const value = 2;\n');
      expect(parked.checks).toMatchObject([{ command: 'node --check answer.mjs', code: 0 }]);
      const approved = await host.review(started.id, [{ requirementId: 'R1', decision: 'approve', note: '核对实际文件与语法检查，确为 value=2' }], { sequence: parked.sequence, evidenceToken: parked.evidenceToken! });
      expect(approved.completion).toMatchObject({ granted: true, verdict: 'verified' });
      const reloaded = await new GuiSessionHost(options).snapshot(started.id);
      expect(reloaded.messages).toEqual(approved.messages);
      expect(reloaded.tools).toEqual(approved.tools);
      expect(reloaded.completion.granted).toBe(true);
      expect(reloaded.usage.inputTokens).toBe(60);
      const session = await loadSession(approved.sources.session, { validateIntegrity: true, requireHeader: true });
      expect(session.pendingTools).toEqual([]);
      expect(session.messages.some((message) => message.role === 'tool' && message.content.includes('请改为 2'))).toBe(true);
    } finally { await host.dispose(); }
  }, 30_000);

  it('stops a pending write, invalidates approvals and preserves the interrupted scene across reload', async () => {
    const { host, options, task, cwd } = await fixture(model(() => [call('write-stop', 'write', { path: 'answer.mjs', content: 'export const value=3;', createOnly: true })]));
    try {
      const started = await host.start(task.objective);
      const approval = await until(host, started.id, (s) => s.approval !== null);
      await host.control(started.id, 'stop', '测试终止待审批副作用');
      const stopped = await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'interrupted');
      expect(existsSync(join(cwd, 'answer.mjs'))).toBe(false);
      expect(stopped.completion.granted).toBe(false);
      await expect(host.decision(started.id, approval.approval!.requestId, 'allow-once')).rejects.toThrow('失效');
      const reloaded = await new GuiSessionHost(options).snapshot(started.id);
      expect(reloaded.status).toBe('interrupted');
      expect(reloaded.messages).toEqual(stopped.messages);
      expect(reloaded.capabilities.resume).toBe(false);
      await expect(host.control(started.id, 'resume')).rejects.toThrow('active');
    } finally { await host.dispose(); }
  }, 30_000);

  it('pauses only at the model boundary, retains queued input, and never treats model final as completion', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let waveCount = 0;
    let sawInput = false;
    const { host, task } = await fixture(model(async (messages, wave) => {
      waveCount++;
      if (wave === 0) { await held; return [call('read', 'read', { path: 'seed.txt' })]; }
      sawInput = messages.some((message) => message.role === 'user' && message.content === '补充真实输入');
      return '我已完成';
    }));
    try {
      const started = await host.start(task.objective);
      await until(host, started.id, (s) => s.status === 'running');
      await host.control(started.id, 'pause');
      release();
      const paused = await until(host, started.id, (s) => s.status === 'paused');
      expect(paused.capabilities.continue).toBe(true);
      expect(waveCount).toBe(1);
      await host.input(started.id, '补充真实输入');
      await host.control(started.id, 'continue');
      const stopped = await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'blocked');
      expect(sawInput).toBe(true);
      expect(stopped.completion.granted).toBe(false);
      expect(stopped.pendingInputs).toEqual([]);
      const unchanged = structuredClone(stopped);
      applyGuiEvent(unchanged, { type: 'future.event', outcome: 'verified' });
      expect(unchanged.status).toBe('blocked');
      expect(unchanged.completion.granted).toBe(false);
      expect(unchanged.warnings.at(-1)).toContain('future.event');
    } finally { release(); await host.dispose(); }
  }, 30_000);

  it('applies existing HTTP mutation guard and sends an idempotent full SSE projection', async () => {
    const { host, task, cwd } = await fixture(model(() => '没有授权的完成声明'));
    const server = createGuiServer({ cwd, dataDir: join(cwd, 'data'), liveHost: host });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const rejected = await fetch(`${base}/api/live/start`, { method: 'POST', body: JSON.stringify({ text: task.objective }) });
      expect(rejected.status).toBe(403);
      const started = await host.start(task.objective);
      const stopped = await until(host, started.id, (s) => !s.capabilities.stop && s.status === 'blocked');
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const stream = await fetch(`${base}/api/live/${started.id}/events`, { signal: controller.signal, headers: { 'Last-Event-ID': `${started.id}:${stopped.sequence}` } });
        const reader = stream.body!.getReader();
        const chunk = new TextDecoder().decode((await reader.read()).value);
        expect(chunk).toContain(`id: ${started.id}:${stopped.sequence}`);
        expect(chunk).toContain('event: snapshot');
        expect(chunk).toContain('"granted":false');
        controller.abort();
      }
    } finally { await host.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30_000);
});
