import type { GuiLiveOverview, GuiLiveOverviewSession, GuiLiveSnapshot, GuiMessage, GuiModelsResponse, GuiTool, GuiWorkspaceInfo, GuiWorkspaceTree } from '../../../live-types.js';
import type { LiveConnectionState } from '../live/use-live-session.js';
import type { WorkbenchNotices } from './types.js';

/**
 * Deterministic UI specimens. They render the same projection shape the live host produces, so the
 * workbench can be verified without a model, a runtime or any file side effect. Nothing here is a
 * product acceptance result and nothing here is persisted.
 */

const FIXTURE_CWD = 'H:\\jarvis-agent';
const FIXTURE_TASK = '确定性试件任务：把 fixture/answer.mjs 的说明文字改清楚，并用 node --check 验证。此项不是真实任务。';
const FIXTURE_REQUIREMENTS = [
  '实际文件体现本次调整，语法检查通过；此为确定性试件。',
  '界面能把工具执行一步定位到对应 Diff、验证或上下文。',
];

const NOTICES: WorkbenchNotices = {
  overviewLoading: false,
  overviewError: null,
  connectionNotice: null,
  streamWarning: null,
  actionError: null,
};

const LIMITS = { maxRounds: 2, maxTurns: 6, turnTimeoutMs: 120_000, wallClockMs: 900_000 };
const SOURCES = { session: '试件：未落盘', goal: '试件：未落盘', approvals: '试件：未落盘', events: '试件：未落盘' };

function message(id: string, role: GuiMessage['role'], text: string, at: string, patch: Partial<GuiMessage> = {}): GuiMessage {
  return { id, role, text, at, status: 'complete', toolIds: [], ...patch };
}

function tool(id: string, name: string, status: GuiTool['status'], args: Record<string, unknown>, patch: Partial<GuiTool> = {}): GuiTool {
  return { id, name, arguments: JSON.stringify(args), status, ...patch };
}

interface SnapshotPatch extends Partial<GuiLiveSnapshot> {
  readonly status: GuiLiveSnapshot['status'];
}

function snapshot(patch: SnapshotPatch): GuiLiveSnapshot {
  const { status, ...rest } = patch;
  return {
    id: 'gui-fixture-0001',
    sequence: 12,
    objective: FIXTURE_TASK,
    cwd: FIXTURE_CWD,
    model: 'deterministic-fixture',
    sessionId: 'gui-fixture-0001',
    goalId: 'gui-fixture-0001',
    status,
    phase: '试件现场',
    nextAction: '观察执行过程；需要时补充指令或终止',
    startedAt: '2026-09-26T09:00:00.000Z',
    elapsedMs: 42_000,
    messages: [],
    tools: [],
    approval: null,
    approvalHistory: [],
    pendingInputs: [],
    completion: { granted: false, verdict: 'none', rationale: '完成授权未授予' },
    evidenceToken: null,
    review: null,
    checks: [],
    diff: '',
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, costCny: null, costNote: '试件不计费；Token 为构造值' },
    limits: LIMITS,
    sources: SOURCES,
    warnings: [],
    capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    ...rest,
  };
}

const FIXTURE_WORKSPACES: GuiWorkspaceInfo[] = [
  {
    id: 'ws-fixture-main', name: 'jarvis-agent', cwd: FIXTURE_CWD, createdAt: '2026-09-26T08:00:00.000Z', archived: false, sort: 0,
    presets: {
      writePaths: ['fixture/answer.mjs'],
      checkCommands: ['node --check fixture/answer.mjs'],
      maxRounds: 2, maxTurns: 6, minutes: 10,
      savedAt: '2026-09-26T08:30:00.000Z',
    },
  },
];

/** 与真实端点一致的诚实形状：单模型、当前配置固定、思考档只读。 */
export const FIXTURE_MODELS: GuiModelsResponse = {
  defaultModel: 'deepseek-flash',
  models: [{ id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', maxContextTokens: 1_048_576, thinkingLevels: ['off'] }],
};

/** 演示用多档目录（试件专用，不代表真实 provider）。 */
export const FIXTURE_MODELS_DEMO: GuiModelsResponse = {
  defaultModel: 'deepseek-flash',
  models: [
    { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', maxContextTokens: 1_048_576, thinkingLevels: ['off', 'low', 'high', 'max'] },
    { id: 'deepseek-pro', label: 'DeepSeek-V4-Pro（演示）', maxContextTokens: 1_048_576, thinkingLevels: ['off', 'low', 'high', 'max'] },
  ],
};

/** Batch 7 §工作空间: deterministic tree levels for the 「文件」tab; sorted like the server (dirs → files → other). */
export const FIXTURE_TREE: Record<string, GuiWorkspaceTree> = {
  '': {
    path: '',
    entries: [
      { name: 'docs', kind: 'dir', link: false },
      { name: 'fixture', kind: 'dir', link: false },
      { name: 'package.json', kind: 'file', link: false, size: 312 },
      { name: 'locked.lnk', kind: 'other', link: true },
    ],
    truncated: false,
  },
  fixture: {
    path: 'fixture',
    entries: [
      { name: 'answer.mjs', kind: 'file', link: false, size: 96 },
      { name: 'v13-shot.png', kind: 'file', link: false, size: 67 },
    ],
    truncated: false,
  },
  docs: {
    path: 'docs',
    entries: [
      { name: 'guide.md', kind: 'file', link: false, size: 120 },
    ],
    truncated: false,
  },
};

function overviewSession(patch: Partial<GuiLiveOverviewSession> = {}): GuiLiveOverviewSession {
  return {
    id: 'gui-fixture-0001',
    title: FIXTURE_TASK.slice(0, 60),
    objective: FIXTURE_TASK,
    status: 'running',
    workspaceId: 'ws-fixture-main',
    pinned: false,
    archived: false,
    updatedAt: '2026-09-26T09:10:00.000Z',
    lastMessage: '收到。我会把 label 改成一句可直接使用的引导…',
    ...patch,
  };
}

function overview(patch: Partial<GuiLiveOverview> = {}): GuiLiveOverview {
  return {
    cwd: FIXTURE_CWD,
    enabled: true,
    task: { objective: FIXTURE_TASK, requirements: FIXTURE_REQUIREMENTS },
    sessions: [],
    activeId: null,
    activeIds: [],
    workspaces: FIXTURE_WORKSPACES,
    ...patch,
  };
}

/** Batch 3 §A4: run-state session statuses populate activeIds; terminal/idle rows contribute none. */
const RUNNING_SESSION_STATUSES: ReadonlySet<string> = new Set(['starting', 'running', 'approval', 'pausing', 'paused', 'checking', 'stopping']);

const runningCaps = { submit: true, pause: true, continue: false, stop: true, resume: false };

const READ_TOOLS: GuiTool[] = [
  tool('call_fx_read_1', 'read', 'committed', { path: 'fixture/answer.mjs' }, { path: 'fixture/answer.mjs', output: 'export const label = "说明";\n' }),
  tool('call_fx_grep_1', 'grep', 'committed', { pattern: 'label', path: 'fixture' }, { output: 'fixture/answer.mjs:1:export const label = "说明";' }),
];

const RUNNING_MESSAGES: GuiMessage[] = [
  message('message-1', 'user', FIXTURE_TASK, '2026-09-26T09:00:01.000Z'),
  message('call_fx_m1', 'assistant', '我先读取现有文件，确认要改哪一行说明文字。这一步只读，不产生副作用。', '2026-09-26T09:00:06.000Z', { toolIds: ['call_fx_read_1', 'call_fx_grep_1'] }),
  message('message-2', 'user', '说明文字要让第一次使用的人看懂从哪里开始，不要用内部术语。', '2026-09-26T09:00:40.000Z'),
  message('call_fx_m2', 'assistant', '收到。我会把 label 改成一句可直接使用的引导，并在写入前请求你的审批。', '2026-09-26T09:00:44.000Z', { status: 'running' }),
];

/** Batch 4 §阅读试件：一条带 Markdown 结构的回复，验证渲染而非真实任务内容。 */
const MARKDOWN_MESSAGES: GuiMessage[] = [
  ...RUNNING_MESSAGES,
  message(
    'call_fx_md',
    'assistant',
    [
      '我把需要改的地方拆开说清楚，方便你直接判断。',
      '',
      '## 现状',
      '',
      '- `fixture/answer.mjs` 只有一行 `export const label`，说明太短。',
      '- 目标：让第一次使用的人知道**从哪里开始**。',
      '',
      '## 计划改法',
      '',
      '| 步骤 | 动作 | 是否要写盘 |',
      '| --- | --- | --- |',
      '| 1 | 把 label 改成完整引导句 | 要 |',
      '| 2 | `node --check` 语法验证 | 不要 |',
      '',
      '```js',
      'export const label = "从左侧选择任务，中间描述目标；写入前会在右侧请求你的批准。";',
      '```',
      '',
      '> 细节与来源可以展开 [V13 冻结清单](https://example.test/docs) 对照；这只影响说明文字，不碰运行逻辑。',
    ].join('\n'),
    '2026-09-26T09:00:50.000Z',
  ),
];

export interface WorkbenchFixture {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly overview: GuiLiveOverview;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly connection: LiveConnectionState;
  readonly actionPending: string | null;
  readonly notices: WorkbenchNotices;
  readonly models: GuiModelsResponse;
}

function fixture(id: string, label: string, hint: string, patch: Partial<WorkbenchFixture> & { snapshot?: GuiLiveSnapshot | null }): WorkbenchFixture {
  const snapshotStatus = patch.snapshot?.status ?? 'running';
  return {
    id,
    label,
    hint,
    overview: patch.overview ?? overview(id === 'empty'
      ? { sessions: [], activeId: null, activeIds: [] }
      : {
          sessions: [overviewSession({ status: snapshotStatus })],
          activeId: null,
          activeIds: RUNNING_SESSION_STATUSES.has(snapshotStatus) ? ['gui-fixture-0001'] : [],
        }),
    snapshot: patch.snapshot === undefined ? snapshot({ status: 'running' }) : patch.snapshot,
    connection: patch.connection ?? 'connected',
    actionPending: patch.actionPending ?? null,
    notices: patch.notices ?? NOTICES,
    models: patch.models ?? FIXTURE_MODELS,
  };
}

function longHistory(): { messages: GuiMessage[]; tools: GuiTool[] } {
  const messages: GuiMessage[] = [];
  const tools: GuiTool[] = [];
  for (let turn = 1; turn <= 9; turn += 1) {
    const at = `2026-09-26T09:${String(10 + turn).padStart(2, '0')}:00.000Z`;
    messages.push(message(`long-q-${turn}`, 'user', `第 ${turn} 轮提问：请检查 fixture 目录里第 ${turn} 个文件的说明文字是否清楚，并告诉我需要改哪里。`, at));
    const readId = `long-read-${turn}`;
    tools.push(tool(readId, 'read', 'committed', { path: `fixture/file-${turn}.mjs` }, { path: `fixture/file-${turn}.mjs`, output: `export const label = "说明 ${turn}";\n` }));
    messages.push(message(`long-a-${turn}`, 'assistant', `第 ${turn} 轮回复：我读取了 fixture/file-${turn}.mjs。说明文字能看懂对象，但缺少「从哪里开始」的指引；建议补一句入口说明。这是只读检查，不产生副作用。`, `2026-09-26T09:${String(10 + turn).padStart(2, '0')}:24.000Z`, { toolIds: [readId] }));
  }
  return { messages, tools };
}

const LONG = longHistory();

export const workbenchFixtures: readonly WorkbenchFixture[] = [
  fixture('empty', '空任务引导', '尚未启动：右栏显示任务合同，中栏显示从哪里开始。', {
    snapshot: null,
    overview: overview(),
  }),
  fixture('running', '运行中', '流式回复与只读工具摘要；暂停与急停可用；待送达补充可撤回。', {
    snapshot: snapshot({
      status: 'running',
      phase: '模型正在生成回复',
      nextAction: '观察执行过程；需要时补充指令或终止',
      pendingInputs: ['模型生成完这段回复后，请再核对一遍需求描述里有没有遗漏。'],
      messages: RUNNING_MESSAGES,
      tools: [
        ...READ_TOOLS,
        tool('call_fx_task_1', 'task', 'committed', { role: 'researcher', task: '核对说明文字调整涉及的既有验收口径与历史结论，给出不超过 200 字的摘要。' }, { output: '（试件）委派结果：既有口径要求确定性检查与人工验收同时通过才授予完成；本次说明文字调整不改变该口径。' }),
      ],
      usage: { inputTokens: 4210, outputTokens: 318, costCny: 0.0348, costNote: '试件按构造值估算，不产生真实费用' },
      capabilities: runningCaps,
    }),
  }),
  fixture('markdown', 'Markdown 阅读', '一条带标题、列表、表格与代码块的回复（试件形状）。', {
    snapshot: snapshot({
      status: 'running',
      phase: '模型正在生成回复',
      nextAction: '观察执行过程；需要时补充指令或终止',
      messages: MARKDOWN_MESSAGES,
      tools: [...READ_TOOLS],
      usage: { inputTokens: 4210, outputTokens: 318, costCny: 0.0348, costNote: '试件按构造值估算，不产生真实费用' },
      capabilities: runningCaps,
    }),
  }),
  fixture('long', '长对话与定位刻度', '九轮问答：验证顶部提问摘要与左侧定位刻度的出现条件。', {
    snapshot: snapshot({
      status: 'running',
      phase: '模型正在生成回复',
      nextAction: '观察执行过程；需要时补充指令或终止',
      messages: LONG.messages,
      tools: LONG.tools,
      usage: { inputTokens: 31_204, outputTokens: 2_418, costCny: 0.2598, costNote: '试件按构造值估算，不产生真实费用' },
      capabilities: runningCaps,
    }),
  }),
  fixture('approval', '待审批写入', '写入请求等待你决定；允许一次只推进这一次。', {
    snapshot: snapshot({
      status: 'approval',
      phase: '等待你的审批',
      nextAction: '检查工具请求，允许一次、拒绝或填写调整意见',
      messages: RUNNING_MESSAGES,
      tools: [
        ...READ_TOOLS,
        tool('call_fx_write_1', 'write', 'proposed', { path: 'fixture/answer.mjs', content: 'export const label = "说明清楚";\n', createOnly: false }, { path: 'fixture/answer.mjs' }),
      ],
      approval: {
        requestId: 'req-fx-1',
        toolName: 'write',
        capability: 'writes-files',
        reason: '写入文件需要你的批准',
        detail: '仅允许本次请求；拒绝理由会传回模型',
        arguments: JSON.stringify({ path: 'fixture/answer.mjs', content: 'export const label = "说明清楚";\n', expectedVersion: 'fv1:aa01' }, null, 2),
      },
      capabilities: { submit: true, pause: false, continue: false, stop: true, resume: false },
    }),
  }),
  fixture('adjusted', '要求调整后', '拒绝理由已进入 Session，并改变后续写入内容。', {
    snapshot: snapshot({
      status: 'running',
      phase: '模型正在生成回复',
      nextAction: '观察执行过程；需要时补充指令或终止',
      messages: [
        ...RUNNING_MESSAGES,
        message('message-3', 'user', '不要只改一个词。请把 label 写成一句完整引导，说明从哪里开始、什么时候需要审批。', '2026-09-26T09:02:10.000Z'),
        message('call_fx_m3', 'assistant', '明白，我按你的理由重写了这句引导，并再次请求写入审批。', '2026-09-26T09:02:16.000Z', { toolIds: ['call_fx_write_2'] }),
      ],
      tools: [
        ...READ_TOOLS,
        tool('call_fx_write_1', 'write', 'denied', { path: 'fixture/answer.mjs' }, { path: 'fixture/answer.mjs', output: '用户要求调整：不要只改一个词，需要写成完整引导。' }),
        tool('call_fx_write_2', 'write', 'proposed', { path: 'fixture/answer.mjs' }, { path: 'fixture/answer.mjs' }),
      ],
      approvalHistory: [{ requestId: 'req-fx-1', toolName: 'write', decision: 'deny', reason: '不要只改一个词。请把 label 写成一句完整引导，说明从哪里开始、什么时候需要审批。' }],
      approval: {
        requestId: 'req-fx-2',
        toolName: 'write',
        capability: 'writes-files',
        reason: '写入文件需要你的批准',
        detail: '仅允许本次请求；拒绝理由会传回模型',
        arguments: JSON.stringify({ path: 'fixture/answer.mjs', content: 'export const label = "从左侧选择任务，中间描述目标；写入前会在右侧请求你的批准。";\n' }, null, 2),
      },
      capabilities: { submit: true, pause: false, continue: false, stop: true, resume: false },
    }),
  }),
  fixture('edit', '待审批 Edit', '一次局部修改请求；结构化变更视图显示 oldText→newText 的差异。', {
    snapshot: snapshot({
      status: 'approval',
      phase: '等待你的审批',
      nextAction: '检查修改内容，允许一次、拒绝或填写调整意见',
      messages: RUNNING_MESSAGES,
      tools: [
        ...READ_TOOLS,
        tool('call_fx_edit_1', 'edit', 'proposed', {
          path: 'fixture/answer.mjs',
          oldText: 'export const label = "说明";\n',
          newText: 'export const label = "从左侧选择任务，中间描述目标；写入前会在右侧请求你的批准。";\n',
          expectedVersion: 'fv1:bb02',
        }, { path: 'fixture/answer.mjs' }),
      ],
      approval: {
        requestId: 'req-fx-3',
        toolName: 'edit',
        capability: 'writes-files',
        reason: '写入文件需要你的批准',
        detail: '仅允许本次请求；拒绝理由会传回模型',
        arguments: JSON.stringify({
          path: 'fixture/answer.mjs',
          oldText: 'export const label = "说明";\n',
          newText: 'export const label = "从左侧选择任务，中间描述目标；写入前会在右侧请求你的批准。";\n',
          expectedVersion: 'fv1:bb02',
        }, null, 2),
      },
      capabilities: { submit: true, pause: false, continue: false, stop: true, resume: false },
    }),
  }),
  fixture('verification', '验证与人工验收', '检查已跑完，等待你逐项验收；完成授权仍未授予。', {
    snapshot: snapshot({
      status: 'blocked',
      phase: '等待你的交付验收',
      nextAction: '检查产物、Diff 和验证输出，再逐项记录人工验收',
      elapsedMs: 268_000,
      messages: [
        ...RUNNING_MESSAGES,
        message('call_fx_m4', 'assistant', '写入已完成，node --check 通过。我调用 update_goal(complete)，交付物是 fixture/answer.mjs 的一处改动。', '2026-09-26T09:04:20.000Z', { toolIds: ['call_fx_goal_1'] }),
      ],
      tools: [
        ...READ_TOOLS,
        tool('call_fx_write_2', 'write', 'committed', { path: 'fixture/answer.mjs' }, { path: 'fixture/answer.mjs', output: '已写入 fixture/answer.mjs' }),
        tool('call_fx_goal_1', 'update_goal', 'committed', { status: 'complete' }, { output: 'Goal 状态已记录为 complete；等待独立检查与人工验收' }),
      ],
      approvalHistory: [{ requestId: 'req-fx-2', toolName: 'write', decision: 'allow-once' }],
      artifacts: [{ path: 'fixture/answer.mjs', outcome: 'written' }, { path: 'docs/guide.md', outcome: 'written' }],
      diff: 'diff --git a/docs/guide.md b/docs/guide.md\nnew file mode 100644\nindex 0000000..1f2d3e4\n--- /dev/null\n+++ b/docs/guide.md\n@@ -0,0 +1 @@\n+# 引导（试件构造内容）\ndiff --git a/fixture/answer.mjs b/fixture/answer.mjs\nindex 8c1e2f4..2b7a91c 100644\n--- a/fixture/answer.mjs\n+++ b/fixture/answer.mjs\n@@ -1 +1 @@\n-export const label = "说明";\n+export const label = "从左侧选择任务，中间描述目标；写入前会在右侧请求你的批准。";\n',
      checks: [
        { command: 'node --check fixture/answer.mjs', code: 0, output: '' },
        { command: 'GUI evidence stability', code: 0, output: '验证期间源文件未变化' },
      ],
      review: {
        requirements: [
          { requirementId: 'R1', text: '实际文件体现本次调整，语法检查通过；此为确定性试件。', reason: '需要人眼确认交付物与检查对应同一份工作树。' },
          { requirementId: 'R2', text: '界面能把工具执行一步定位到对应 Diff、验证或上下文。', reason: '这是本次 GUI 改造的可用性要求。' },
        ],
      },
      evidenceToken: 'fixture-evidence-token',
      usage: { inputTokens: 18_420, outputTokens: 1_206, costCny: 0.1467, costNote: '试件按构造值估算，不产生真实费用' },
      completion: { granted: false, verdict: 'pending_human_review', rationale: '检查已通过，但完成授权需要人工验收进入既有可信链。' },
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    }),
  }),
  fixture('failed', '检查失败', '确定性检查未通过；界面不得显示成功。', {
    snapshot: snapshot({
      status: 'blocked',
      phase: '运行停止：objective checks failed',
      nextAction: '查看阻塞原因及保留的证据；终态不会自动重跑',
      elapsedMs: 301_000,
      messages: [
        ...RUNNING_MESSAGES,
        message('call_fx_m5', 'assistant', '我已完成写入并声明任务完成。', '2026-09-26T09:05:02.000Z', { toolIds: ['call_fx_goal_2'] }),
      ],
      tools: [
        ...READ_TOOLS,
        tool('call_fx_write_3', 'write', 'committed', { path: 'fixture/answer.mjs' }, { path: 'fixture/answer.mjs', output: '已写入 fixture/answer.mjs' }),
        tool('call_fx_goal_2', 'update_goal', 'committed', { status: 'complete' }, { output: 'Goal 状态已记录为 complete' }),
      ],
      artifacts: [{ path: 'fixture/answer.mjs', outcome: 'written' }],
      diff: 'diff --git a/fixture/answer.mjs b/fixture/answer.mjs\n--- a/fixture/answer.mjs\n+++ b/fixture/answer.mjs\n@@ -1 +1 @@\n-export const label = "说明";\n+export const label = "说明";\n+export const broken =\n',
      checks: [{ command: 'node --check fixture/answer.mjs', code: 1, output: "fixture/answer.mjs:2\nexport const broken =\n                      ^\nSyntaxError: Missing initializer in const declaration" }],
      completion: { granted: false, verdict: 'failed', rationale: 'objective checks failed：语法检查未通过，模型声明不构成完成。' },
      warnings: ['检查未通过；本次交付没有可信完成授权。'],
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    }),
  }),
  fixture('blocked', '已阻塞', '总时限已到；终态只读，不自动重跑。', {
    snapshot: snapshot({
      status: 'blocked',
      phase: '运行停止：任务总时限已到，已停止执行',
      nextAction: '查看阻塞原因及保留的证据；终态不会自动重跑',
      elapsedMs: 900_000,
      messages: RUNNING_MESSAGES,
      tools: READ_TOOLS,
      completion: { granted: false, verdict: 'none', rationale: '任务总时限已到；恢复不会重置时限或累计调用上限。' },
      warnings: ['任务总时限已到，已停止执行。'],
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    }),
  }),
  fixture('stopped', '急停后', '急停已生效：在途执行中断，后续副作用被阻止。', {
    snapshot: snapshot({
      status: 'interrupted',
      phase: '运行停止：GUI emergency stop',
      nextAction: '查看阻塞原因及保留的证据；终态不会自动重跑',
      elapsedMs: 154_000,
      messages: [
        ...RUNNING_MESSAGES,
        message('call_fx_m6', 'assistant', '正在等待写入审批…', '2026-09-26T09:02:30.000Z', { status: 'incomplete' }),
      ],
      tools: [...READ_TOOLS, tool('call_fx_write_9', 'write', 'denied', { path: 'fixture/answer.mjs' }, { path: 'fixture/answer.mjs', output: '审批因执行中断而失效；文件未写入' })],
      approvalHistory: [{ requestId: 'req-fx-9', toolName: 'write', decision: 'interrupted', reason: 'Ludi 从 Web GUI 紧急终止本次运行。' }],
      completion: { granted: false, verdict: 'none', rationale: '急停后没有交付；待批写入未发生。' },
      warnings: ['Session 留有未执行工具意图，自动恢复继续被拒绝。'],
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    }),
  }),
  fixture('recoverable', '可恢复现场', 'Goal 仍为 active，恢复入口可用；恢复不重置预算。', {
    snapshot: snapshot({
      status: 'recoverable',
      phase: '进程已重启，现场从持久事实重建',
      nextAction: '检查已恢复的 Session 事实；通过恢复校验后才继续',
      elapsedMs: 96_000,
      messages: RUNNING_MESSAGES,
      tools: READ_TOOLS,
      completion: { granted: false, verdict: 'none', rationale: '尚未产生可信裁决' },
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: true },
    }),
  }),
  fixture('disconnected', '连接中断', '事件流断开：危险控制停用，草稿与阅读位置保留。', {
    connection: 'disconnected',
    notices: { ...NOTICES, connectionNotice: '连接已中断。控制暂时停用，草稿与阅读位置已保留，系统会自动重连。' },
    snapshot: snapshot({
      status: 'running',
      phase: '模型正在生成回复',
      messages: RUNNING_MESSAGES,
      tools: READ_TOOLS,
      capabilities: runningCaps,
    }),
  }),
  fixture('complete', '可信完成', '人工验收进入既有可信链后才显示完成已授权。', {
    snapshot: snapshot({
      status: 'complete',
      phase: '任务交付与验收已完成',
      nextAction: '检查已授权的交付物；本次试件结束',
      elapsedMs: 322_000,
      messages: [
        ...RUNNING_MESSAGES,
        message('call_fx_m7', 'assistant', '交付物是 fixture/answer.mjs 的一处改动，node --check 通过，人工验收已记录。', '2026-09-26T09:06:00.000Z'),
      ],
      tools: [
        ...READ_TOOLS,
        tool('call_fx_write_2', 'write', 'committed', { path: 'fixture/answer.mjs' }, { path: 'fixture/answer.mjs', output: '已写入 fixture/answer.mjs' }),
      ],
      approvalHistory: [{ requestId: 'req-fx-2', toolName: 'write', decision: 'allow-once' }],
      artifacts: [{ path: 'fixture/answer.mjs', outcome: 'written' }],
      diff: 'diff --git a/fixture/answer.mjs b/fixture/answer.mjs\n--- a/fixture/answer.mjs\n+++ b/fixture/answer.mjs\n@@ -1 +1 @@\n-export const label = "说明";\n+export const label = "从左侧选择任务，中间描述目标；写入前会在右侧请求你的批准。";\n',
      checks: [{ command: 'node --check fixture/answer.mjs', code: 0, output: '' }],
      usage: { inputTokens: 21_033, outputTokens: 1_402, costCny: 0.1682, costNote: '试件按构造值估算，不产生真实费用' },
      completion: { granted: true, verdict: 'verified', rationale: '（试件）objective checks passed + human review approved；真实授权只能来自既有可信链。' },
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    }),
  }),
  fixture('unavailable', '现场不可用', '持久事实读取失败：显式降级，不显示成功。', {
    snapshot: snapshot({
      status: 'unavailable',
      phase: '持久事实读取失败',
      nextAction: '查看阻塞原因及保留的证据；终态不会自动重跑',
      messages: RUNNING_MESSAGES,
      tools: READ_TOOLS,
      warnings: ['持久事实读取失败：Goal identity mismatch'],
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    }),
  }),
  fixture('multi', '多任务与工作区', '两个工作区、置顶、已归档与运行中任务并存；含一条待审批任务，顶部出现「其他任务待处理」提示条。', {
    snapshot: snapshot({
      status: 'running',
      messages: RUNNING_MESSAGES,
      tools: READ_TOOLS,
      capabilities: runningCaps,
      terminal: {
        running: null,
        history: [
          { command: 'node --version', code: 0, output: 'v22.12.0\n（试件构造输出，非真实执行）', canceled: false, at: '2026-09-26T09:08:00.000Z' },
          { command: 'npm run build', code: null, output: '（试件）构建输出中途超过 120 秒命令上限\n', canceled: true, cause: 'timeout', at: '2026-09-26T09:09:00.000Z' },
        ],
      },
    }),
    overview: overview({
      activeId: 'gui-fixture-0001',
      activeIds: ['gui-fixture-0001'],
      workspaces: [
        ...FIXTURE_WORKSPACES,
        { id: 'ws-fixture-demo', name: 'demo-standby', cwd: 'H:\\demo-standby', createdAt: '2026-09-26T08:30:00.000Z', archived: false, sort: 1 },
      ],
      sessions: [
        overviewSession({ id: 'gui-fixture-pin-1', title: '置顶：GUI 文案巡检', status: 'complete', pinned: true, updatedAt: '2026-09-26T09:12:00.000Z', lastMessage: '已交付，验收已完成。' }),
        overviewSession({ id: 'gui-fixture-0001', status: 'running', updatedAt: '2026-09-26T09:11:00.000Z' }),
        overviewSession({ id: 'gui-fixture-arch-1', title: '旧文档迁移（归档）', status: 'blocked', archived: true, updatedAt: '2026-09-25T17:40:00.000Z', lastMessage: '预算用尽，已保留现场。' }),
        overviewSession({ id: 'gui-fixture-demo-1', title: 'demo-standby 的首个任务（待审批）', workspaceId: 'ws-fixture-demo', status: 'approval', objective: '演示第二个工作区里等待审批的任务（试件数据）', updatedAt: '2026-09-26T09:02:00.000Z', lastMessage: '（试件）写入等待你的审批' }),
      ],
    }),
    models: FIXTURE_MODELS_DEMO,
  }),
  fixture('concurrent', '双任务并发', '两个工作区各一个运行中任务；切换查看不加锁，急停仍按所选任务分派。', {
    snapshot: snapshot({ status: 'running', messages: RUNNING_MESSAGES, tools: READ_TOOLS, capabilities: runningCaps }),
    overview: overview({
      activeId: 'gui-fixture-0001',
      activeIds: ['gui-fixture-0001', 'gui-fixture-par-1'],
      workspaces: [
        ...FIXTURE_WORKSPACES,
        { id: 'ws-fixture-lab', name: 'demo-parallel', cwd: 'H:\\demo-parallel', createdAt: '2026-09-26T08:30:00.000Z', archived: false, sort: 1 },
      ],
      sessions: [
        overviewSession({ id: 'gui-fixture-0001', status: 'running', updatedAt: '2026-09-26T09:11:00.000Z' }),
        overviewSession({ id: 'gui-fixture-par-1', title: '并行：demo-parallel 的重构巡检', workspaceId: 'ws-fixture-lab', status: 'running', objective: '并行演示：在 demo-parallel 工作区运行一次重构巡检', updatedAt: '2026-09-26T09:10:30.000Z', lastMessage: '正在读取 src 目录结构…' }),
      ],
    }),
  }),
  fixture('branch', '讨论分支来源', '新任务携带来源链与前情，待启动；审批与验收不继承。', {
    snapshot: snapshot({
      id: 'gui-fixture-fork-1',
      sessionId: 'gui-fixture-fork-1',
      goalId: 'gui-fixture-fork-1',
      status: 'idle',
      phase: '任务已创建，待启动',
      objective: '承接「确定性试件任务：把 fixture/answer.mjs 的说明文字改清楚」第 2 轮的讨论分支',
      sourceRef: { parentId: 'gui-fixture-0001', turnId: 'call_fx_m2', summary: '承接「确定性试件任务」第 2 轮的讨论分支（试件示意）' },
      messages: [
        message('fx-fork-u1', 'user', '[前情 · 来自任务 gui-fixture-0001 第 2 轮] 确定性试件任务：把 fixture/answer.mjs 的说明文字改清楚。', '2026-09-26T09:20:00.000Z'),
        message('fx-fork-a1', 'assistant', '[前情 · 助手] 收到。我会把 label 改成一句可直接使用的引导。', '2026-09-26T09:20:02.000Z'),
      ],
      capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
    }),
    overview: overview({
      sessions: [
        overviewSession({ id: 'gui-fixture-fork-1', title: '分支 · 承接「确定性试件任务」第 2 轮', status: 'idle', objective: '承接「确定性试件任务：把 fixture/answer.mjs 的说明文字改清楚」第 2 轮的讨论分支', sourceRef: { parentId: 'gui-fixture-0001', turnId: 'call_fx_m2', summary: '承接「确定性试件任务」第 2 轮的讨论分支（试件示意）' } }),
      ],
    }),
  }),
];

export function findFixture(id: string | null): WorkbenchFixture | undefined {
  return workbenchFixtures.find((item) => item.id === id);
}
