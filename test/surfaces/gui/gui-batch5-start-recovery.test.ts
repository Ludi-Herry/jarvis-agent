import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import { applyGuiEvent, type GuiObservedEvent } from '../../../src/surfaces/gui/live-projection.js';
import { GuiLiveError, GuiSessionHost } from '../../../src/surfaces/gui/live-session.js';
import type { GuiLiveSnapshot, GuiWorkspacePresets } from '../../../src/surfaces/gui/live-types.js';
import { describeRunVitals } from '../../../src/surfaces/gui/app/src/workbench/run-vitals.js';

function model(): ModelProvider {
  const provider: ModelProvider = {
    capability: { maxContextTokens: 100_000, maxOutputTokens: 16_384, thinking: false, toolUse: true, imageIn: false, videoIn: false },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield { type: 'text', text: '确定回复' };
      return { text: '确定回复', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'completed', rawFinishReason: 'stop' };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function freeHost(cwd: string): GuiSessionHost {
  return new GuiSessionHost({ cwd, dataDir: join(cwd, 'data'), provider: model(), modelName: 'deterministic-test' });
}

/** Git-initialized temp workspace (createTask/persist flows need git; probe/presets do not). */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b5-test-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), 'data/\n', 'utf8');
  for (const command of ['git init -q', 'git add -- seed.txt .gitignore', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    expect(result.code, result.output).toBe(0);
  }
  return { cwd, dataDir: join(cwd, 'data') };
}

async function liveError(promise: Promise<unknown>): Promise<GuiLiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GuiLiveError);
    return error as GuiLiveError;
  }
  throw new Error('expected GuiLiveError');
}

function bareSnapshot(patch: Partial<GuiLiveSnapshot> = {}): GuiLiveSnapshot {
  return {
    id: 'gui-b5', sequence: 0, objective: 'o', cwd: 'H:\\tmp', model: 'm', sessionId: 'gui-b5', goalId: 'gui-b5',
    status: 'running', phase: '模型正在生成回复', nextAction: '观察执行过程', startedAt: '2026-10-07T00:00:00Z', elapsedMs: 42_000,
    messages: [], tools: [], approval: null, approvalHistory: [], pendingInputs: [],
    completion: { granted: false, verdict: 'none', rationale: '' }, evidenceToken: null, review: null,
    checks: [], diff: '', artifacts: [], usage: { inputTokens: 4210, outputTokens: 318, costCny: 0.0348, costNote: '' },
    limits: { maxRounds: 2, maxTurns: 6, turnTimeoutMs: 120_000, wallClockMs: 900_000 },
    sources: { session: 's', goal: 'g', approvals: 'a', events: 'e' }, warnings: [],
    capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    ...patch,
  };
}

describe('批5 终端 cancel cause 折叠（§恢复：超时 ≠ 用户取消）', () => {
  it('folds timeout/user cancel reasons into entry.cause; exit still closes without a cause', () => {
    const snapshot = bareSnapshot();
    applyGuiEvent(snapshot, { type: 'gui_terminal', phase: 'start', command: 'npm test', at: 't0' });
    applyGuiEvent(snapshot, { type: 'gui_terminal', phase: 'cancel', reason: 'timeout', at: 't1' });
    expect(snapshot.terminal?.history.at(-1)).toMatchObject({ canceled: true, cause: 'timeout', code: null });

    applyGuiEvent(snapshot, { type: 'gui_terminal', phase: 'start', command: 'npm run build', at: 't2' });
    applyGuiEvent(snapshot, { type: 'gui_terminal', phase: 'cancel', reason: 'user', at: 't3' });
    expect(snapshot.terminal?.history.at(-1)).toMatchObject({ canceled: true, cause: 'user' });

    applyGuiEvent(snapshot, { type: 'gui_terminal', phase: 'start', command: 'node -v', at: 't4' });
    applyGuiEvent(snapshot, { type: 'gui_terminal', phase: 'exit', code: 0, at: 't5' });
    expect(snapshot.terminal?.history.at(-1)).toMatchObject({ canceled: false, code: 0 });
    expect(snapshot.terminal?.history.at(-1)?.cause).toBeUndefined();
    expect(snapshot.terminal?.running).toBeNull();
  });

  it('replaying the same journal events reproduces cause deterministically', () => {
    const events: GuiObservedEvent[] = [
      { type: 'gui_terminal', phase: 'start', command: 'npm test', at: 't0' },
      { type: 'gui_terminal', phase: 'out', chunk: 'partial-output', at: 't1' },
      { type: 'gui_terminal', phase: 'cancel', reason: 'interrupted', at: 't2' },
    ];
    const first = bareSnapshot();
    const replayed = bareSnapshot();
    for (const event of events) {
      applyGuiEvent(first, event);
      applyGuiEvent(replayed, event);
    }
    expect(replayed.terminal?.history[0]).toMatchObject({ canceled: true, cause: 'interrupted', output: 'partial-output' });
    expect(replayed.terminal).toEqual(first.terminal);
  });
});

const VALID_PRESETS: Omit<GuiWorkspacePresets, 'savedAt'> = {
  writePaths: ['answer.mjs'],
  checkCommands: ['node --check answer.mjs'],
  maxRounds: 2,
  maxTurns: 6,
  minutes: 10,
};

describe('批5 工作区预设（服务端存取回环与字段校验）', () => {
  it('save → immediate workspaces echo → fresh host replays the persisted presets', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd);
    const overview = await host.overview();
    const wsId = overview.workspaces[0].id;
    const saved = await host.saveWorkspacePresets(wsId, VALID_PRESETS);
    const savedWs = saved.workspaces.find((workspace) => workspace.id === wsId);
    expect(savedWs?.presets).toMatchObject(VALID_PRESETS);
    expect(Number.isNaN(Date.parse(savedWs?.presets?.savedAt ?? ''))).toBe(false);

    // A brand-new host instance must see the persisted presets (workspaces.json roundtrip).
    const second = freeHost(cwd);
    const replayed = await second.overview();
    expect(replayed.workspaces.find((workspace) => workspace.id === wsId)?.presets).toMatchObject(VALID_PRESETS);
  });

  it('invalid presets collect per-field errors into one GuiLiveError(400)', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd);
    const wsId = (await host.overview()).workspaces[0].id;
    const error = await liveError(host.saveWorkspacePresets(wsId, {
      writePaths: ['/abs/x.mjs'], checkCommands: [], maxRounds: 99, maxTurns: 6, minutes: 10,
    }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('预设无效');
    expect(error.message).toContain('presets.writePaths');
    expect(error.message).toContain('presets.checkCommands');
    expect(error.message).toContain('presets.maxRounds');
  });

  it('unknown workspace id is an honest 404', async () => {
    const { cwd } = await workspace();
    const host = freeHost(cwd);
    const presetError = await liveError(host.saveWorkspacePresets('ws-does-not-exist', VALID_PRESETS));
    expect(presetError.status).toBe(404);
    const probeError = await liveError(host.probeWorkspaceCommands('ws-does-not-exist'));
    expect(probeError.status).toBe(404);
  });
});

describe('批5 只读 probe 候选命令', () => {
  it('finds package.json scripts, vitest config and tsconfig with honest sources', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b5-probe-'));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc' } }));
    await writeFile(join(cwd, 'vitest.config.ts'), 'export default {};\n');
    await writeFile(join(cwd, 'tsconfig.json'), '{}\n');
    const host = freeHost(cwd);
    const wsId = (await host.overview()).workspaces[0].id;
    const probe = await host.probeWorkspaceCommands(wsId);
    expect(probe.candidates.map((candidate) => candidate.command)).toEqual([
      'npm run test', 'npm run lint', 'npx vitest run', 'npx tsc --noEmit',
    ]);
    expect(probe.candidates.find((candidate) => candidate.command === 'npm run test')?.source).toBe('package.json scripts');
    expect(probe.candidates.find((candidate) => candidate.command === 'npx vitest run')?.source).toBe('vite/vitest 配置');
    expect(probe.candidates.find((candidate) => candidate.command === 'npx tsc --noEmit')?.source).toBe('tsconfig.json');
    expect(probe.note).toContain('采用前请自行确认');
  });

  it('empty workspace root yields no candidates and an honest note', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b5-probe-empty-'));
    const host = freeHost(cwd);
    const wsId = (await host.overview()).workspaces[0].id;
    const probe = await host.probeWorkspaceCommands(wsId);
    expect(probe.candidates).toEqual([]);
    expect(probe.note).toBe('未在 package.json scripts 与 vite/tsconfig 配置中发现候选检查命令。');
  });
});

describe('批5 运行状态条派生文案（run-vitals）', () => {
  it('approval waits on your decision', () => {
    expect(describeRunVitals(bareSnapshot({ status: 'approval' })).waiting).toBe('等你的审批决定');
  });

  it('running with two queued inputs reports the boundary wait honestly', () => {
    expect(describeRunVitals(bareSnapshot({ status: 'running', pendingInputs: ['甲', '乙'] })).waiting)
      .toBe('等下一处理边界送达 2 条补充');
  });

  it('running without queued inputs does not block the operator', () => {
    expect(describeRunVitals(bareSnapshot({ status: 'running' })).waiting).toBe('不阻塞你（可补充指令或急停）');
  });

  it('budget carries elapsed/limit and cost only when a price exists', () => {
    const withCost = describeRunVitals(bareSnapshot());
    expect(withCost.budget).toContain('已用');
    expect(withCost.budget).toContain('上限');
    expect(withCost.budget).toContain('· 成本');
    const withoutCost = describeRunVitals(bareSnapshot({ usage: { inputTokens: 10, outputTokens: 2, costCny: null, costNote: '未知' } }));
    expect(withoutCost.budget).toContain('已用');
    expect(withoutCost.budget).not.toContain('成本');
  });

  it('review and paused keep their own honest waits', () => {
    expect(describeRunVitals(bareSnapshot({ status: 'running', review: { requirements: [] } })).waiting).toBe('等你的逐项人工验收');
    expect(describeRunVitals(bareSnapshot({ status: 'paused' })).waiting).toBe('已暂停；等你继续或终止');
  });
});
