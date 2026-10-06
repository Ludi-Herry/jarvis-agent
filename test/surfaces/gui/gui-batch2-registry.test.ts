import { mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { Message, ToolCall } from '../../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import {
  buildForkExcerpt,
  GUI_DERIVED_REQUIREMENT,
  GuiLiveError,
  GuiSessionHost,
  type GuiTaskDefinition,
} from '../../../src/surfaces/gui/live-session.js';
import { createGuiServer } from '../../../src/surfaces/gui/gui-server.js';
import type { GuiGitStatus, GuiLiveSnapshot, GuiMessage, GuiWorkspaceInfo } from '../../../src/surfaces/gui/live-types.js';

function model(next: (messages: Message[], wave: number) => Promise<ToolCall[] | string> | ToolCall[] | string, thinking = false): ModelProvider {
  let wave = 0;
  const provider: ModelProvider = {
    capability: { maxContextTokens: 100_000, maxOutputTokens: 16_384, thinking, toolUse: true, imageIn: false, videoIn: false },
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

function counted(provider: ModelProvider): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  const wrapped: ModelProvider = {
    capability: provider.capability,
    call: (messages, tools, signal) => { calls++; return provider.call(messages, tools, signal); },
    withThinking: () => wrapped,
    withMaxCompletionTokens: () => wrapped,
  };
  return { provider: wrapped, calls: () => calls };
}

function freeContract(cwd: string, patch: Partial<GuiTaskDefinition> = {}): GuiTaskDefinition {
  return {
    objective: '为模块提供导出的值，并用真实语法检查验收', cwd,
    requirements: ['文件包含经过调整的实际交付内容'], writePaths: ['answer.mjs'],
    checkCommands: ['node --check answer.mjs'], maxRounds: 1, maxTurns: 6, wallClockMs: 30_000,
    ...patch,
  };
}

/** Git-initialized temp workspace; dataDir is .gitignore'd so git-status tests see a clean tree. */
async function workspace(initGit = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b2-test-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), 'data/\n', 'utf8');
  if (initGit) {
    for (const command of ['git init -q', 'git add -- seed.txt .gitignore', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
      const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
      expect(result.code, result.output).toBe(0);
    }
  }
  return { cwd, dataDir: join(cwd, 'data') };
}

function freeHost(cwd: string, provider: ModelProvider, options: { modelName?: string } = {}): GuiSessionHost {
  return new GuiSessionHost({ cwd, dataDir: join(cwd, 'data'), provider, ...(options.modelName ? { modelName: options.modelName } : {}) });
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

async function withHttpServer(host: GuiSessionHost, cwd: string, run: (base: string) => Promise<void>): Promise<void> {
  const server = createGuiServer({ cwd, dataDir: join(cwd, 'data'), liveHost: host });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

const CSRF = { 'x-jarvis-gui': '1' };

async function post(base: string, path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: CSRF, body: JSON.stringify(payload) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('批2 会话元数据（gui_meta：rename/pin/archive 折叠与重启读回）', () => {
  it('folds rename/pin/archive into snapshot and overview, and replays them after a host restart', async () => {
    const { cwd } = await workspace();
    const provider = model(() => '元数据测试回复');
    const host = freeHost(cwd, provider);
    try {
      const created = await host.createTask(freeContract(cwd));
      expect(created.status).toBe('idle');
      const renamed = await host.setMeta(created.id, { title: '我的任务甲' });
      expect(renamed.title).toBe('我的任务甲');
      const pinned = await host.setMeta(created.id, { pinned: true });
      expect(pinned.pinned).toBe(true);
      const second = await host.createTask(freeContract(cwd, { objective: '第二个任务，排序与归档对照' }));
      const overview = await host.overview();
      const first = overview.sessions.find((session) => session.id === created.id)!;
      expect(first.title).toBe('我的任务甲');
      expect(first.pinned).toBe(true);
      expect(first.archived).toBe(false);
      expect(first.workspaceId).toBe(overview.workspaces[0].id);
      expect(Date.parse(first.updatedAt)).toBeGreaterThan(0);
      expect(first.lastMessage).toBe('');
      // pinned sorts ahead of the newer unpinned task
      expect(overview.sessions[0].id).toBe(created.id);
      const archived = await host.setMeta(second.id, { archived: true });
      expect(archived.archived).toBe(true);
      const sorted = await host.overview();
      expect(sorted.sessions.at(-1)!.id).toBe(second.id);
      expect(sorted.sessions.at(-1)!.archived).toBe(true);
    } finally { await host.dispose(); }
    // host restart: meta must fold back out of the task's own journal
    const reloaded = freeHost(cwd, provider);
    try {
      const overview = await reloaded.overview();
      const first = overview.sessions.find((session) => session.title === '我的任务甲')!;
      expect(first.pinned).toBe(true);
      expect(overview.sessions.at(-1)!.archived).toBe(true);
      const snapshot = await reloaded.snapshot(first.id);
      expect(snapshot.title).toBe('我的任务甲');
      expect(snapshot.pinned).toBe(true);
      expect(snapshot.status).toBe('idle');
    } finally { await reloaded.dispose(); }
  });

  it('rejects malformed meta bodies with 400 and keeps the journal untouched', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      const created = await host.createTask(freeContract(cwd));
      for (const body of [{}, { pinned: 'yes' }, { title: '' }, { title: '长'.repeat(121) }, { archived: 1 }]) {
        const error = await host.setMeta(created.id, body).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(GuiLiveError);
        expect((error as GuiLiveError).status).toBe(400);
      }
      const snapshot = await host.snapshot(created.id);
      expect(snapshot.title).toBeUndefined();
      expect(snapshot.pinned).toBeUndefined();
      expect(snapshot.sequence).toBe(0);
    } finally { await host.dispose(); }
  });
});

describe('批2 工作区注册表（默认登记、持久读回、新建校验）', () => {
  it('auto-registers the host cwd as the default workspace on first overview and persists workspaces.json', async () => {
    const { cwd, dataDir } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      const overview = await host.overview();
      expect(overview.workspaces).toHaveLength(1);
      expect(overview.workspaces[0].archived).toBe(false);
      expect(overview.workspaces[0].name.length).toBeGreaterThan(0);
      const file = join(dataDir, 'gui', 'workspaces.json');
      expect(existsSync(file)).toBe(true);
      const persisted = JSON.parse(await readFile(file, 'utf8')) as { version: number; workspaces: GuiWorkspaceInfo[] };
      expect(persisted.version).toBe(1);
      expect(persisted.workspaces[0].id).toBe(overview.workspaces[0].id);
    } finally { await host.dispose(); }
    // second host instance reads the same registry back instead of registering anew
    const reloaded = freeHost(cwd, model(() => 'x'));
    try {
      const first = await freeHost(cwd, model(() => 'x')).overview();
      const again = await reloaded.overview();
      expect(again.workspaces.map((workspace) => workspace.id)).toEqual(first.workspaces.map((workspace) => workspace.id));
    } finally { await reloaded.dispose(); }
  });

  it('reads an archived workspace flag back from disk', async () => {
    const { cwd, dataDir } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      await host.overview();
      const file = join(dataDir, 'gui', 'workspaces.json');
      const persisted = JSON.parse(await readFile(file, 'utf8')) as { version: number; workspaces: GuiWorkspaceInfo[] };
      persisted.workspaces[0].archived = true;
      await writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    } finally { await host.dispose(); }
    const reloaded = freeHost(cwd, model(() => 'x'));
    try {
      const overview = await reloaded.overview();
      expect(overview.workspaces[0].archived).toBe(true);
    } finally { await reloaded.dispose(); }
  });

  it('rejects relative, missing, symlinked and non-git workspace paths with honest field errors', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      await host.overview();
      for (const [body, fragment] of [
        [{ cwd: 'relative/path' }, '绝对路径'],
        [{ cwd: join(cwd, '不存在目录') }, '不存在'],
        [{ cwd: (await workspace(false)).cwd }, 'git'],
      ] as const) {
        const error = await host.createWorkspace(body).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(GuiLiveError);
        expect((error as GuiLiveError).status).toBe(409);
        expect((error as GuiLiveError).message).toContain(fragment);
      }
      const target = await workspace();
      const link = join(cwd, 'workspace-link');
      await symlink(target.cwd, link, 'junction');
      const linked = await host.createWorkspace({ cwd: link }).catch((err: unknown) => err);
      expect(linked).toBeInstanceOf(GuiLiveError);
      expect((linked as GuiLiveError).status).toBe(409);
      expect((linked as GuiLiveError).message).toContain('符号链接');
    } finally { await host.dispose(); }
  });

  it('registers a real second workspace and binds a task to it', async () => {
    const { cwd } = await workspace();
    const other = await workspace();
    const host = freeHost(cwd, model(() => '工作区乙回复'));
    try {
      const { workspaces } = await host.createWorkspace({ cwd: other.cwd, name: '工作区乙' });
      expect(workspaces).toHaveLength(2);
      const created = await host.createTask(freeContract(other.cwd, { workspaceId: workspaces[1].id, objective: '在工作区乙里交付' }));
      const overview = await host.overview();
      const item = overview.sessions.find((session) => session.id === created.id)!;
      expect(item.workspaceId).toBe(workspaces[1].id);
      const mismatch = await host.createTask(freeContract(cwd, { workspaceId: workspaces[1].id })).catch((err: unknown) => err);
      expect(mismatch).toBeInstanceOf(GuiLiveError);
      expect((mismatch as GuiLiveError).status).toBe(409);
      expect((mismatch as GuiLiveError).message).toContain('不一致');
    } finally { await host.dispose(); }
  });
});

describe('批2 自由任务 validate/create/start（dry-run 不落盘、创建零消耗、启动互斥）', () => {
  it('returns per-field structured errors for an invalid contract', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      const result = await host.validateTask({
        cwd,
        requirements: [], writePaths: ['../escape.ts', 'C:/abs/path.ts'],
        checkCommands: [], maxRounds: 99, maxTurns: 0, wallClockMs: 10,
      });
      expect(result.ok).toBe(false);
      const fields = result.errors.map((error) => error.field);
      for (const field of ['objective', 'requirements', 'writePaths', 'checkCommands', 'maxRounds', 'maxTurns', 'wallClockMs']) {
        expect(fields).toContain(field);
      }
      for (const error of result.errors) expect(error.message.length).toBeGreaterThan(0);
      const probe = await host.validateTask({ ...freeContract(cwd), checkCommands: ['definitely-not-a-real-binary-xyz --check answer.mjs'] });
      expect(probe.ok).toBe(false);
      expect(probe.errors.some((error) => error.field === 'checkCommands' && error.message.includes('definitely-not-a-real-binary-xyz'))).toBe(true);
      const unregistered = await workspace();
      expect((await host.validateTask(freeContract(unregistered.cwd))).errors.some((error) => error.field === 'cwd')).toBe(true);
    } finally { await host.dispose(); }
  });

  it('passes a valid contract dry-run with derived defaults and writes no journal', async () => {
    const { cwd, dataDir } = await workspace();
    const counter = counted(model(() => 'x'));
    const host = freeHost(cwd, counter.provider);
    try {
      const withoutRequirements: Record<string, unknown> = { ...freeContract(cwd), requirements: undefined };
      const result = await host.validateTask(withoutRequirements);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.task!.requirements).toEqual([GUI_DERIVED_REQUIREMENT]);
      expect(result.task!.workspaceId).toBe((await host.overview()).workspaces[0].id);
      expect(counter.calls()).toBe(0);
      const dir = join(dataDir, 'gui');
      const names = existsSync(dir) ? await readdir(dir) : [];
      expect(names.filter((name) => name.startsWith('gui-'))).toEqual([]);
    } finally { await host.dispose(); }
  });

  it('creates a 待启动 task without consuming the model, starts it through the deterministic chain and rejects a parallel start', async () => {
    const { cwd } = await workspace();
    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
    const counter = counted(model(async (_messages, wave) => {
      if (wave === 0) await heldA;
      return '任务甲回复';
    }));
    const host = freeHost(cwd, counter.provider);
    try {
      const createdA = await host.createTask(freeContract(cwd, { objective: '任务甲：保持运行中' }));
      expect(createdA.status).toBe('idle');
      expect(counter.calls()).toBe(0);
      const createdB = await host.createTask(freeContract(cwd, { objective: '任务乙：等待互斥' }));
      expect(counter.calls()).toBe(0);
      // created journal persisted, still no model consumption
      const journal = await readFile(join(cwd, 'data', 'gui', `${createdA.id}.jsonl`), 'utf8');
      expect(JSON.parse(journal.trimEnd().split('\n')[0])).toMatchObject({ type: 'gui_created', sequence: 0, model: 'deterministic-test' });
      const startedA = await host.startTask(createdA.id);
      await until(host, startedA.id, (snapshot) => snapshot.status === 'running');
      // creating further tasks is unrestricted while one runs; only starting is mutually exclusive
      const createdC = await host.createTask(freeContract(cwd, { objective: '任务丙：运行中创建' }));
      expect(createdC.status).toBe('idle');
      expect((await host.startTask(createdC.id).catch((err: unknown) => err) as GuiLiveError).status).toBe(409);
      const conflict = await host.startTask(createdB.id).catch((err: unknown) => err);
      expect(conflict).toBeInstanceOf(GuiLiveError);
      expect((conflict as GuiLiveError).status).toBe(409);
      expect((conflict as GuiLiveError).message).toContain('已有运行中的任务');
      releaseA();
      const settledA = await until(host, startedA.id, (snapshot) => !snapshot.capabilities.stop && snapshot.status === 'blocked');
      expect(settledA.messages.some((message) => message.role === 'assistant' && message.text.includes('任务甲回复'))).toBe(true);
      expect(counter.calls()).toBeGreaterThan(0);
      const startedB = await host.startTask(createdB.id);
      const settledB = await until(host, startedB.id, (snapshot) => !snapshot.capabilities.stop && snapshot.status === 'blocked');
      expect(settledB.messages.some((message) => message.role === 'assistant')).toBe(true);
      const restart = await host.startTask(createdA.id).catch((err: unknown) => err);
      expect((restart as GuiLiveError).status).toBe(409);
      expect((restart as GuiLiveError).message).toContain('不自动重复消耗');
    } finally { releaseA(); await host.dispose(); }
  });

  it('serves validate/create/start/meta over HTTP with the frozen shapes', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd, model(() => 'HTTP 链路回复'));
    try {
      await withHttpServer(host, cwd, async (base) => {
        const bad = await post(base, '/api/live/task/validate', { cwd });
        expect(bad.status).toBe(200);
        expect(bad.body.ok).toBe(false);
        expect(Array.isArray(bad.body.errors)).toBe(true);
        const noCsrf = await fetch(`${base}/api/live/task`, { method: 'POST', body: JSON.stringify(freeContract(cwd)) });
        expect(noCsrf.status).toBe(403);
        const created = await post(base, '/api/live/task', freeContract(cwd, { objective: 'HTTP 创建的任务' }));
        expect(created.status).toBe(200);
        const id = (created.body as unknown as GuiLiveSnapshot).id;
        expect((created.body as unknown as GuiLiveSnapshot).status).toBe('idle');
        const meta = await post(base, `/api/live/${id}/meta`, { title: 'HTTP 标题' });
        expect(meta.status).toBe(200);
        expect((meta.body as unknown as GuiLiveSnapshot).title).toBe('HTTP 标题');
        const badMeta = await post(base, `/api/live/${id}/meta`, { pinned: 'yes' });
        expect(badMeta.status).toBe(400);
        const started = await post(base, `/api/live/${id}/start`, {});
        expect(started.status).toBe(200);
        await until(host, id, (snapshot) => !snapshot.capabilities.stop && snapshot.status === 'blocked');
        const models = await fetch(`${base}/api/live/models`);
        expect(models.status).toBe(200);
        const listed = (await models.json()) as { models: Array<{ id: string; thinkingLevels: string[] }>; defaultModel: string };
        expect(listed.defaultModel).toBe('deterministic-test');
        expect(listed.models).toHaveLength(1);
        expect(listed.models[0].thinkingLevels).toEqual(['off']);
        const missing = await fetch(`${base}/api/live/${id}/nope`, { method: 'POST', headers: CSRF, body: '{}' });
        expect(missing.status).toBe(404);
        const badWorkspace = await post(base, '/api/live/workspaces', { cwd: 'relative' });
        expect(badWorkspace.status).toBe(409);
      });
    } finally { await host.dispose(); }
  }, 30_000);
});

describe('批2 讨论分支（forkFrom：来源链、上下文注入、截断、零继承）', () => {
  it('excerpt truncation: per-message 4000 cap, 24000 total budget, round numbering, unknown turnId', () => {
    const messages: GuiMessage[] = [
      { id: 'u1', role: 'user', text: '甲'.repeat(9_000), at: 't1', status: 'complete', toolIds: [] },
      { id: 'a1', role: 'assistant', text: '回复一', at: 't2', status: 'complete', toolIds: [] },
      { id: 'u2', role: 'user', text: '补充二', at: 't3', status: 'complete', toolIds: [] },
      { id: 'a2', role: 'assistant', text: '回复二', at: 't4', status: 'complete', toolIds: [] },
    ];
    const excerpt = buildForkExcerpt(messages, 'a2')!;
    expect(excerpt.round).toBe(2);
    expect(excerpt.messages[0].text.length).toBe(4_000);
    expect(excerpt.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(buildForkExcerpt(messages, 'missing')).toBeNull();
    const crowded: GuiMessage[] = Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`, role: index % 2 === 0 ? 'user' : 'assistant', text: '字'.repeat(3_000), at: 't', status: 'complete', toolIds: [],
    }));
    const bounded = buildForkExcerpt(crowded, 'm9')!;
    expect(bounded.messages.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(24_000);
    expect(bounded.omitted).toBe(true);
    expect(bounded.messages.at(-1)!.text).toBe('字'.repeat(3_000));
    expect(bounded.messages[0].text).toBe('字'.repeat(3_000));
    expect(bounded.messages.length).toBeLessThan(10);
    // a single oversized message is cut by the per-message 4000 cap first; the total budget never engages
    const solo = buildForkExcerpt([{ id: 'x', role: 'assistant', text: '长'.repeat(30_000), at: 't', status: 'complete', toolIds: [] }], 'x')!;
    expect(solo.messages).toHaveLength(1);
    expect(solo.messages[0].text.length).toBe(4_000);
  });

  it('creates a branch with sourceRef, injects the [前情 · …] chain at start and inherits no goal or approvals', async () => {
    const { cwd } = await workspace();
    const provider = model(() => '父任务的确定性回复');
    const host = freeHost(cwd, provider);
    try {
      const parent = await host.createTask(freeContract(cwd, { objective: '父任务：产出第一轮讨论材料' }));
      const parentStarted = await host.startTask(parent.id);
      const parentSettled = await until(host, parentStarted.id, (snapshot) => !snapshot.capabilities.stop && snapshot.status === 'blocked');
      const parentReply = parentSettled.messages.find((message) => message.role === 'assistant')!;
      const branch = await host.createTask({ forkFrom: { parentId: parent.id, turnId: parentReply.id } });
      expect(branch.status).toBe('idle');
      expect(branch.sourceRef).toMatchObject({ parentId: parent.id, turnId: parentReply.id });
      expect(branch.sourceRef!.summary).toContain('父任务：产出第一轮讨论材料');
      expect(branch.sourceRef!.summary).toContain('第 1 轮');
      expect(branch.objective).toContain('承接');
      expect(branch.objective).toContain('第 1 轮的讨论分支');
      // overview exposes the same provenance link
      const overview = await host.overview();
      const item = overview.sessions.find((session) => session.id === branch.id)!;
      expect(item.sourceRef?.parentId).toBe(parent.id);
      // contract cloned from the parent
      const journal = JSON.parse((await readFile(join(cwd, 'data', 'gui', `${branch.id}.jsonl`), 'utf8')).trimEnd().split('\n')[0]) as { task: GuiTaskDefinition; fork: { round: number } };
      expect(journal.task.writePaths).toEqual(['answer.mjs']);
      expect(journal.task.checkCommands).toEqual(['node --check answer.mjs']);
      expect(journal.task.requirements).toEqual([GUI_DERIVED_REQUIREMENT]);
      expect(journal.fork.round).toBe(1);
      const branchStarted = await host.startTask(branch.id);
      const branchSettled = await until(host, branchStarted.id, (snapshot) => !snapshot.capabilities.stop && snapshot.status === 'blocked');
      const users = branchSettled.messages.filter((message) => message.role === 'user');
      expect(users[0].text.startsWith(`[前情 · 来自任务 ${parent.id} 第 1 轮]`)).toBe(true);
      expect(users.some((message) => message.text.includes('[前情 · 用户]') && message.text.includes('父任务：产出第一轮讨论材料'))).toBe(true);
      expect(users.some((message) => message.text.includes('[前情 · 助手]') && message.text.includes('父任务的确定性回复'))).toBe(true);
      expect(users.some((message) => message.text === branch.objective)).toBe(true);
      // zero inheritance: new goal identity, no approvals, no completion
      expect(branchSettled.goalId).toBe(branch.id);
      expect(branchSettled.goalId).not.toBe(parentSettled.goalId);
      expect(branchSettled.approvalHistory).toEqual([]);
      expect(branchSettled.completion.granted).toBe(false);
      expect(existsSync(branchSettled.sources.goal)).toBe(true);
      expect(branchSettled.sources.goal).not.toBe(parentSettled.sources.goal);
    } finally { await host.dispose(); }
  }, 30_000);

  it('rejects forkFrom with an unknown parent or turnId and never dedupes free tasks', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      const parent = await host.createTask(freeContract(cwd));
      const badParent = await host.createTask({ forkFrom: { parentId: 'gui-00000000-0000-0000-0000-000000000000', turnId: 'a' } }).catch((err: unknown) => err);
      expect((badParent as GuiLiveError).status).toBe(400);
      expect((badParent as GuiLiveError).message).toContain('父任务不存在');
      const badTurn = await host.createTask({ forkFrom: { parentId: parent.id, turnId: 'nope' } }).catch((err: unknown) => err);
      expect((badTurn as GuiLiveError).status).toBe(400);
      expect((badTurn as GuiLiveError).message).toContain('turnId');
      const first = await host.createTask(freeContract(cwd, { objective: '同目标自由任务' }));
      const second = await host.createTask(freeContract(cwd, { objective: '同目标自由任务' }));
      expect(second.id).not.toBe(first.id);
    } finally { await host.dispose(); }
  });
});

describe('批2 Git 只读状态与模型目录', () => {
  it('returns parsed branch/uncommitted for a real repository and {unavailable} for a non-repo task', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      const task = await host.createTask(freeContract(cwd));
      const status = await host.gitStatus(task.id);
      expect('unavailable' in status).toBe(false);
      const clean = status as Extract<GuiGitStatus, { branch: string }>;
      expect(clean.branch.length).toBeGreaterThan(0);
      expect(clean.uncommitted).toBe(0);
      expect(clean.worktree).toBe('clean');
      await writeFile(join(cwd, 'answer.mjs'), 'export const value = 1;\n', 'utf8');
      const dirtyResult = await new Promise<GuiGitStatus>((resolveWait) => setTimeout(async () => resolveWait(await host.gitStatus(task.id)), 5_100));
      expect('unavailable' in dirtyResult).toBe(false);
      const dirty = dirtyResult as Extract<GuiGitStatus, { branch: string }>;
      expect(dirty.uncommitted).toBe(1);
      expect(dirty.worktree).toBe('dirty');
    } finally { await host.dispose(); }
  }, 30_000);

  it('degrades honestly for a workspace that is not a git repository', async () => {
    const { cwd } = await workspace(false);
    const host = freeHost(cwd, model(() => 'x'));
    try {
      const task = await host.createTask(freeContract(cwd));
      const status = await host.gitStatus(task.id);
      expect('unavailable' in status).toBe(true);
      expect((status as { unavailable?: string }).unavailable!.length).toBeGreaterThan(0);
      const cached = await host.gitStatus(task.id);
      expect(cached).toBe(status);
    } finally { await host.dispose(); }
  });

  it('reports the injected provider model and thinking levels honestly', async () => {
    const { cwd } = await workspace();
    const plain = freeHost(cwd, model(() => 'x'), { modelName: 'fixture-model-a' });
    try {
      const listed = await plain.listModels();
      expect(listed.defaultModel).toBe('fixture-model-a');
      expect(listed.models).toEqual([{ id: 'fixture-model-a', label: 'fixture-model-a', maxContextTokens: 100_000, thinkingLevels: ['off'] }]);
    } finally { await plain.dispose(); }
    const thinkingHost = freeHost(cwd, model(() => 'x', true), { modelName: 'fixture-model-b' });
    try {
      const listed = await thinkingHost.listModels();
      expect(listed.models[0].thinkingLevels).toEqual(['off', 'low', 'medium', 'high']);
    } finally { await thinkingHost.dispose(); }
  });

  it('records contract model into the created journal and validates thinking against capability', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd, model(() => 'x'));
    try {
      const bad = await host.validateTask(freeContract(cwd, { thinking: 'high' }));
      expect(bad.ok).toBe(false);
      expect(bad.errors.some((error) => error.field === 'thinking')).toBe(true);
      const created = await host.createTask(freeContract(cwd, { model: 'operator-pinned-model' }));
      const journal = JSON.parse((await readFile(join(cwd, 'data', 'gui', `${created.id}.jsonl`), 'utf8')).trimEnd().split('\n')[0]) as { model: string; task: GuiTaskDefinition };
      expect(journal.model).toBe('operator-pinned-model');
      expect(created.model).toBe('operator-pinned-model');
      const invalidThinking = await host.validateTask(freeContract(cwd, { thinking: 'turbo' }));
      expect(invalidThinking.ok).toBe(false);
      expect(invalidThinking.errors.some((error) => error.field === 'thinking')).toBe(true);
    } finally { await host.dispose(); }
  });
});
