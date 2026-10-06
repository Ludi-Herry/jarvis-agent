import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { Message, ToolCall } from '../../../src/core/types.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import {
  GuiLiveError,
  GuiSessionHost,
  MAX_CONCURRENT_RUNS,
  type GuiTaskDefinition,
} from '../../../src/surfaces/gui/live-session.js';
import type { GuiLiveSnapshot } from '../../../src/surfaces/gui/live-types.js';

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

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
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
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b3-test-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), 'data/\n', 'utf8');
  for (const command of ['git init -q', 'git add -- seed.txt .gitignore', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    expect(result.code, result.output).toBe(0);
  }
  return { cwd, dataDir: join(cwd, 'data') };
}

function freeHost(cwd: string, provider: ModelProvider, options: { task?: GuiTaskDefinition } = {}): GuiSessionHost {
  return new GuiSessionHost({ cwd, dataDir: join(cwd, 'data'), provider, ...(options.task ? { task: options.task } : {}) });
}

function held(): { hold: Promise<void>; release: () => void } {
  let release!: () => void;
  return { hold: new Promise<void>((resolve) => { release = resolve; }), release };
}

async function until(host: GuiSessionHost, id: string, predicate: (snapshot: GuiLiveSnapshot) => boolean): Promise<GuiLiveSnapshot> {
  const start = Date.now();
  let latest: GuiLiveSnapshot;
  do {
    latest = await host.snapshot(id);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() - start < 15_000);
  throw new Error(`state wait expired: ${JSON.stringify({ status: latest!.status, phase: latest!.phase, warnings: latest!.warnings })}`);
}

async function settle(host: GuiSessionHost, id: string): Promise<GuiLiveSnapshot> {
  return until(host, id, (snapshot) => !snapshot.capabilities.stop && ['blocked', 'complete', 'interrupted'].includes(snapshot.status));
}

async function expectConflict(promise: Promise<unknown>, fragment: string): Promise<void> {
  const error = await promise.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(GuiLiveError);
  expect((error as GuiLiveError).status).toBe(409);
  expect((error as GuiLiveError).message).toContain(fragment);
}

describe('批3 并发上限（§A1–A4：同工作区互斥、全局上限 2、activeIds）', () => {
  it('exposes MAX_CONCURRENT_RUNS = 2 as the contract constant', () => {
    expect(MAX_CONCURRENT_RUNS).toBe(2);
  });

  it('rejects a second start in the same workspace for both workspaceId-bound and cwd-bound tasks', async () => {
    // 甲：workspaceId 绑定（createTask 写入 workspaceId）；顶针任务：--task-file pinned，合同无 workspaceId（cwd 绑定）。
    // 运行顶针后启动甲仍必须 409 —— workspaceId 只是绑定目录的别名，混合绑定在物理目录上相撞。
    const { cwd } = await workspace();
    const holdPinned = held();
    const provider = model(async () => { await holdPinned.hold; return '顶针回复'; });
    const host = freeHost(cwd, provider, { task: freeContract(cwd, { objective: '顶针：cwd 绑定任务保持运行' }) });
    try {
      const overview = await host.overview();
      const pinned = overview.sessions.at(-1)!;
      await host.startTask(pinned.id);
      await until(host, pinned.id, (snapshot) => snapshot.status === 'running');
      const free = await host.createTask(freeContract(cwd, { objective: '甲：workspaceId 绑定任务' }));
      await expectConflict(host.startTask(free.id), '该工作区已有运行中的任务');
      // 也在反方向补一条：pinned 已是 run，工作区键按目录归一后仍只有它能跑。
      const second = await host.createTask(freeContract(cwd, { objective: '甲二：同工作区第二个自由任务' }));
      await expectConflict(host.startTask(second.id), '该工作区已有运行中的任务');
    } finally { holdPinned.release(); await host.dispose(); }
  }, 30_000);

  it('runs two tasks concurrently across workspaces with independent snapshots and honest activeIds', async () => {
    const wsA = await workspace();
    const wsB = await workspace();
    const holdA = held();
    const holdB = held();
    const provider = model(async (messages) => {
      const objective = messages.find((message) => message.role === 'user')?.content ?? '';
      if (objective.includes('任务甲')) { await holdA.hold; return '甲的独立回复'; }
      if (objective.includes('任务乙')) { await holdB.hold; return '乙的独立回复'; }
      return '其它任务的回复';
    });
    const host = freeHost(wsA.cwd, provider);
    try {
      const { workspaces } = await host.createWorkspace({ cwd: wsB.cwd, name: '工作区乙' });
      const createdA = await host.createTask(freeContract(wsA.cwd, { objective: '任务甲：在工作区甲运行' }));
      const createdB = await host.createTask(freeContract(wsB.cwd, { workspaceId: workspaces[1].id, objective: '任务乙：在工作区乙运行' }));
      await host.startTask(createdA.id);
      await until(host, createdA.id, (snapshot) => snapshot.status === 'running');
      // 乙与甲并存启动：不是排队，不是互斥拒绝
      await host.startTask(createdB.id);
      await until(host, createdB.id, (snapshot) => snapshot.status === 'running');
      // 同时活着：甲没有因为乙的启动而退场
      expect((await host.snapshot(createdA.id)).status).toBe('running');
      const overview = await host.overview();
      expect([...overview.activeIds].sort()).toEqual([createdA.id, createdB.id].sort());
      expect([createdA.id, createdB.id]).toContain(overview.activeId);
      holdA.release();
      holdB.release();
      const settledA = await settle(host, createdA.id);
      const settledB = await settle(host, createdB.id);
      // 各自 snapshot 独立：甲只有甲的回复，乙只有乙的回复
      expect(settledA.messages.some((message) => message.text.includes('甲的独立回复'))).toBe(true);
      expect(settledA.messages.some((message) => message.text.includes('乙的独立回复'))).toBe(false);
      expect(settledB.messages.some((message) => message.text.includes('乙的独立回复'))).toBe(true);
      expect(settledB.messages.some((message) => message.text.includes('甲的独立回复'))).toBe(false);
      expect((await host.overview()).activeIds).toEqual([]);
    } finally { holdA.release(); holdB.release(); await host.dispose(); }
  }, 60_000);

  it('rejects a third concurrent run with the cap message, and same-workspace conflicts keep precedence', async () => {
    const wsA = await workspace();
    const wsB = await workspace();
    const wsC = await workspace();
    const holdA = held();
    const holdB = held();
    const provider = model(async (messages) => {
      const objective = messages.find((message) => message.role === 'user')?.content ?? '';
      if (objective.includes('任务甲')) { await holdA.hold; return '甲回复'; }
      if (objective.includes('任务乙')) { await holdB.hold; return '乙回复'; }
      return '丙回复';
    });
    const host = freeHost(wsA.cwd, provider);
    try {
      const workspacesB = await host.createWorkspace({ cwd: wsB.cwd, name: '工作区乙' });
      const workspacesC = await host.createWorkspace({ cwd: wsC.cwd, name: '工作区丙' });
      const createdA = await host.createTask(freeContract(wsA.cwd, { objective: '任务甲' }));
      const createdB = await host.createTask(freeContract(wsB.cwd, { workspaceId: workspacesB.workspaces[1].id, objective: '任务乙' }));
      const sameWs = await host.createTask(freeContract(wsA.cwd, { objective: '任务丙同区' }));
      const thirdWs = await host.createTask(freeContract(wsC.cwd, { workspaceId: workspacesC.workspaces[2].id, objective: '任务丙异区' }));
      await host.startTask(createdA.id);
      await host.startTask(createdB.id);
      await until(host, createdB.id, (snapshot) => snapshot.status === 'running');
      // 全局两席已满：同工作区冲突优先于上限报文；异区第三并发撞上如实上限
      await expectConflict(host.startTask(sameWs.id), '该工作区已有运行中的任务');
      await expectConflict(host.startTask(thirdWs.id), `并发上限已满（${MAX_CONCURRENT_RUNS}）`);
      // 释放一席后，异区任务可以启动（上限报文不是粘滞状态）
      holdA.release();
      await settle(host, createdA.id);
      await host.startTask(thirdWs.id);
      const settledThird = await settle(host, thirdWs.id);
      expect(settledThird.messages.some((message) => message.text.includes('丙回复'))).toBe(true);
    } finally { holdA.release(); holdB.release(); await host.dispose(); }
  }, 60_000);

  it('shares the same gate for resume: workspace conflict first, then the global cap', async () => {
    // host1 持有旧运行并让宿主"死于"运行中；host2 重放成 recoverable，再在工作区/上限两种占位下验证 resume 409。
    const wsT = await workspace();
    const wsU = await workspace();
    const wsV = await workspace();
    const holdT = held();
    const host1 = freeHost(wsT.cwd, model(async () => { await holdT.hold; return '旧运行回复'; }));
    let host2: GuiSessionHost | undefined;
    const holdU = held();
    const holdV = held();
    try {
      const createdT = await host1.createTask(freeContract(wsT.cwd, { objective: '旧任务：宿主退出后待恢复' }));
      await host1.startTask(createdT.id);
      await until(host1, createdT.id, (snapshot) => snapshot.status === 'running');
      host2 = freeHost(wsT.cwd, model(async (messages) => {
        const objective = messages.find((message) => message.role === 'user')?.content ?? '';
        if (objective.includes('占位甲')) { await holdU.hold; return '占位甲回复'; }
        if (objective.includes('占位乙')) { await holdV.hold; return '占位乙回复'; }
        return '占位回复';
      }));
      const replayed = await host2.snapshot(createdT.id);
      expect(replayed.status).toBe('recoverable');
      expect(replayed.capabilities.resume).toBe(true);
      // 一、同工作区占位：resume 撞工作区互斥而非全局上限
      const holdSame = held();
      const host2Provider = model(async () => { await holdSame.hold; return '同区占位回复'; });
      await host2.dispose();
      host2 = freeHost(wsT.cwd, host2Provider);
      const sameWs = await host2.createTask(freeContract(wsT.cwd, { objective: '同区占位任务' }));
      await host2.startTask(sameWs.id);
      await until(host2, sameWs.id, (snapshot) => snapshot.status === 'running');
      await expectConflict(host2.control(createdT.id, 'resume'), '该工作区已有运行中的任务');
      await host2.control(sameWs.id, 'stop');
      holdSame.release();
      await settle(host2, sameWs.id);
      // 二、两席占满：resume 撞并发上限
      const workspacesU = await host2.createWorkspace({ cwd: wsU.cwd, name: '占位区甲' });
      const workspacesV = await host2.createWorkspace({ cwd: wsV.cwd, name: '占位区乙' });
      const host2Full = freeHost(wsT.cwd, model(async (messages) => {
        const objective = messages.find((message) => message.role === 'user')?.content ?? '';
        if (objective.includes('占位甲')) { await holdU.hold; return '占位甲回复'; }
        if (objective.includes('占位乙')) { await holdV.hold; return '占位乙回复'; }
        return '其它';
      }));
      try {
        const slotU = await host2Full.createTask(freeContract(wsU.cwd, { workspaceId: workspacesU.workspaces[1].id, objective: '占位甲' }));
        const slotV = await host2Full.createTask(freeContract(wsV.cwd, { workspaceId: workspacesV.workspaces[2].id, objective: '占位乙' }));
        await host2Full.startTask(slotU.id);
        await host2Full.startTask(slotV.id);
        await until(host2Full, slotV.id, (snapshot) => snapshot.status === 'running');
        expect((await host2Full.overview()).activeIds).toHaveLength(2);
        await expectConflict(host2Full.control(createdT.id, 'resume'), `并发上限已满（${MAX_CONCURRENT_RUNS}）`);
      } finally { holdU.release(); holdV.release(); await host2Full.dispose(); }
    } finally { holdT.release(); await host1.dispose(); await host2?.dispose(); }
  }, 90_000);
});

describe('批3 子智能体接线（§B5–B8：roster 加载、task 工具注册、composition 冻结与重放）', () => {
  const ROLE_MD = ['---', 'name: researcher', 'description: 调研子智能体，用于查证事实', '---', '你是调研子智能体，只读查证并给出结论。', ''].join('\n');

  /** 父模型：首轮委派 task(researcher)，看到 tool 结果后收尾；子模型（同一 provider）收到查证任务即回结论。 */
  function delegatingProvider(): ModelProvider {
    return model((messages) => {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      if (lastUser.includes('查证缓存键')) return '调研结论：缓存键已固定';
      if (messages.some((message) => message.role === 'tool')) return '结合调研完成交付';
      return [call('delegate-1', 'task', { role: 'researcher', task: '查证缓存键' })];
    });
  }

  async function readStartedComposition(cwd: string, id: string): Promise<{ toolsetHash?: string }> {
    const journal = await readFile(join(cwd, 'data', 'gui', `${id}.jsonl`), 'utf8');
    const line = journal.trimEnd().split('\n').map((row) => JSON.parse(row) as { type: string; event?: { type: string; composition?: { toolsetHash?: string } } })
      .find((record) => record.type === 'gui_event' && record.event?.type === 'gui_task_started');
    expect(line, 'gui_task_started must be journaled').toBeDefined();
    return line!.event!.composition!;
  }

  it('registers the task tool from a roster, runs the delegation end-to-end, and replays after restart', async () => {
    const { cwd } = await workspace();
    await mkdir(join(cwd, 'agents', 'researcher'), { recursive: true });
    await writeFile(join(cwd, 'agents', 'researcher', 'ROLE.md'), ROLE_MD, 'utf8');
    const provider = delegatingProvider();
    const host = freeHost(cwd, provider);
    const created = await host.createTask(freeContract(cwd, { objective: '委托调研后给出结论' }));
    const taskId = created.id;
    try {
      await host.startTask(created.id);
      const settled = await settle(host, created.id);
      const delegated = settled.tools.find((tool) => tool.name === 'task');
      expect(delegated, 'task 委派工具必须通过完整闸门链').toBeDefined();
      expect(delegated!.status).toBe('committed');
      expect(delegated!.output).toContain('调研结论：缓存键已固定');
      expect(JSON.parse(delegated!.arguments)).toMatchObject({ role: 'researcher' });
      expect(settled.warnings.some((warning) => warning.includes('roster'))).toBe(false);
      // roster 进 composition：同 fixture 下有无 roster 的 toolsetHash 必须不同（冻结值在 journal 里）。
      const withRoster = await readStartedComposition(cwd, created.id);
      expect(withRoster.toolsetHash).toMatch(/^sha256\.[A-Za-z0-9_-]+$/u);
      const plain = await workspace();
      const plainHost = freeHost(plain.cwd, model(() => '无 roster 回复'));
      try {
        const plainCreated = await plainHost.createTask(freeContract(plain.cwd));
        await plainHost.startTask(plainCreated.id);
        await settle(plainHost, plainCreated.id);
        const withoutRoster = await readStartedComposition(plain.cwd, plainCreated.id);
        expect(withoutRoster.toolsetHash).not.toBe(withRoster.toolsetHash);
      } finally { await plainHost.dispose(); }
    } finally { await host.dispose(); }
    // 宿主重启重放：journal 里的 task 调用与 composition 冻结值原样可见，无谎报
    const reloaded = freeHost(cwd, provider);
    try {
      const snapshot = await reloaded.snapshot(taskId);
      const delegated = snapshot.tools.find((tool) => tool.name === 'task');
      expect(delegated).toBeDefined();
      expect(delegated!.output).toContain('调研结论');
      expect(snapshot.warnings.some((warning) => warning.includes('Session 恢复失败'))).toBe(false);
      expect((await readdir(join(cwd, 'data', 'gui'))).length).toBeGreaterThan(0);
    } finally { await reloaded.dispose(); }
  }, 90_000);

  it('registers no task tool when the roster dir is absent, and the unknown call fails honestly', async () => {
    const { cwd } = await workspace();
    const provider = model((messages) => {
      if (messages.some((message) => message.role === 'tool')) return '已知无法实现委派';
      return [call('delegate-1', 'task', { role: 'researcher', task: '查证缓存键' })];
    });
    const host = freeHost(cwd, provider);
    try {
      const created = await host.createTask(freeContract(cwd, { objective: '没有 roster 时的委派尝试' }));
      await host.startTask(created.id);
      const settled = await settle(host, created.id);
      const delegated = settled.tools.find((tool) => tool.name === 'task');
      expect(delegated).toBeDefined();
      // 未注册的工具在闸门处 fail-closed 拒绝（Denied），不会假装执行成功
      expect(delegated!.status).toBe('denied');
      expect(delegated!.output).toContain('Permission denied');
      expect(delegated!.output).toContain('no declared capability');
      expect(settled.warnings.some((warning) => warning.includes('roster'))).toBe(false);
    } finally { await host.dispose(); }
  }, 60_000);

  it('journals a gui_warning and continues without the delegate tool when the roster dir is corrupted', async () => {
    const { cwd } = await workspace();
    // roster 目录损坏：agents 路径上躺着一个普通文件而不是目录
    await writeFile(join(cwd, 'agents'), 'not a directory\n', 'utf8');
    const host = freeHost(cwd, model(() => '损坏 roster 下的普通回复'));
    try {
      const created = await host.createTask(freeContract(cwd, { objective: '损坏 roster 的启动' }));
      await host.startTask(created.id);
      const settled = await settle(host, created.id);
      expect(settled.warnings.some((warning) => warning.includes('子智能体 roster 目录损坏'))).toBe(true);
      expect(settled.tools.some((tool) => tool.name === 'task')).toBe(false);
    } finally { await host.dispose(); }
  }, 60_000);
});
