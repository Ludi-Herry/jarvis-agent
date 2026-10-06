export type DemoRole = 'user' | 'assistant';

export type DemoPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: Readonly<Record<string, string>>;
      readonly result?: Readonly<Record<string, string>>;
      readonly isError?: boolean;
    };

export interface DemoMessage {
  readonly id: string;
  readonly role: DemoRole;
  readonly name: string;
  readonly time: string;
  readonly content: readonly DemoPart[];
}

export interface DemoPlanStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly status: 'complete' | 'approval' | 'pending';
}

export interface DemoDiffLine {
  readonly old: string;
  readonly next: string;
  readonly kind: 'context' | 'added';
  readonly text: string;
}

export const guiRecover17 = {
  meta: {
    label: 'React Spike · 模拟任务',
    workspace: 'H:\\jarvis-agent',
    branch: 'main',
    session: 'session_gui_recover_017',
    updatedAt: '14:32:18',
  },
  task: {
    id: 'GUI-RECOVER-17',
    objective: '修复会话恢复后消息状态与最新 Diff 不同步',
    request:
      '恢复会话后，活动记录显示已完成，但 Artifact 仍停在旧 Diff。保持 API 与完成授权不变，做最小修复并补一条聚焦测试。',
    scope: '只改显示投影与聚焦测试；保留 Runtime、Session、权限、Goal 和现有 API。',
    phase: '修正显示投影',
    progress: '2 / 5',
  },
  sessions: [
    {
      id: 'session_gui_recover_017',
      title: '修复会话恢复后消息状态与最新 Diff 不同步',
      detail: '等待一次性审批 · 14:32',
      status: 'approval',
      current: true,
    },
    {
      id: 'session_cli_doctor',
      title: '统一 CLI doctor 输出',
      detail: '已完成 · 昨天',
      status: 'complete',
      current: false,
    },
    {
      id: 'session_fault_injection',
      title: '异常流故障注入',
      detail: '失败，保留证据 · 8 月 30 日',
      status: 'failed',
      current: false,
    },
  ],
  approval: {
    title: '批准一次性写入？',
    capability: 'workspace.write',
    requestId: 'approval_gui_017',
    reason: '写入 presentation.js 与 gui-presentation.test.js；不改 API、Runtime 或完成授权。',
    impact: '+29 / −2 · 2 个现有文件 · 可通过 Git 还原',
  },
  plan: [
    { id: '01', label: '复现恢复后的旧投影', detail: '旧刷新在 mutation 后返回', status: 'complete' },
    { id: '02', label: '核对持久事实与显示序列', detail: 'Session sequence 单调，投影落后', status: 'complete' },
    { id: '03', label: '修正刷新屏障', detail: '等待写入 2 个现有文件', status: 'approval' },
    { id: '04', label: '运行聚焦测试', detail: 'gui-presentation + assets', status: 'pending' },
    { id: '05', label: '交给完成授权链', detail: '只有 verified 才显示完成', status: 'pending' },
  ] satisfies readonly DemoPlanStep[],
  artifacts: [
    { path: 'src/surfaces/gui/assets/presentation.js', delta: '+11 −2' },
    { path: 'test/surfaces/gui/gui-presentation.test.js', delta: '+18 −0' },
  ],
  diff: [
    { old: '118', next: '118', kind: 'context', text: 'export function shouldApplyRefresh(sequence, appliedSequence) {' },
    { old: '119', next: '119', kind: 'context', text: '  return sequence >= appliedSequence;' },
    { old: '120', next: '120', kind: 'context', text: '}' },
    { old: '', next: '121', kind: 'added', text: '' },
    { old: '', next: '122', kind: 'added', text: 'export function reconcileRecoveredProjection(snapshot, refresh) {' },
    { old: '', next: '123', kind: 'added', text: '  if (!shouldApplyRefresh(refresh.sequence, snapshot.appliedSequence)) {' },
    { old: '', next: '124', kind: 'added', text: '    return snapshot;' },
    { old: '', next: '125', kind: 'added', text: '  }' },
    { old: '', next: '126', kind: 'added', text: '  return { ...snapshot, ...refresh.value, appliedSequence: refresh.sequence };' },
    { old: '', next: '127', kind: 'added', text: '}' },
    { old: '121', next: '128', kind: 'context', text: '' },
    { old: '122', next: '129', kind: 'context', text: 'export function advanceMutationBarrier(refreshSequence, appliedRefreshSequence) {' },
    { old: '123', next: '130', kind: 'context', text: '  const barrier = Math.max(refreshSequence, appliedRefreshSequence) + 1;' },
    { old: '124', next: '131', kind: 'context', text: '  return {' },
    { old: '125', next: '132', kind: 'context', text: '    barrier,' },
    { old: '126', next: '133', kind: 'context', text: '    refreshSequence: barrier,' },
    { old: '127', next: '134', kind: 'context', text: '    appliedRefreshSequence: barrier,' },
    { old: '128', next: '135', kind: 'context', text: '  };' },
    { old: '129', next: '136', kind: 'context', text: '}' },
    { old: '130', next: '137', kind: 'context', text: '' },
    { old: '131', next: '138', kind: 'context', text: 'export async function settleSequencedRefresh(sequence, load, getAppliedSequence) {' },
    { old: '132', next: '139', kind: 'context', text: '  try {' },
    { old: '133', next: '140', kind: 'context', text: '    const value = await load();' },
    { old: '134', next: '141', kind: 'context', text: '    if (!shouldApplyRefresh(sequence, getAppliedSequence())) return { accepted: false };' },
    { old: '135', next: '142', kind: 'context', text: '    return { accepted: true, value };' },
    { old: '136', next: '143', kind: 'context', text: '  } catch (error) {' },
    { old: '137', next: '144', kind: 'context', text: '    if (!shouldApplyRefresh(sequence, getAppliedSequence())) return { accepted: false };' },
    { old: '138', next: '145', kind: 'context', text: '    throw error;' },
    { old: '139', next: '146', kind: 'context', text: '  }' },
    { old: '140', next: '147', kind: 'context', text: '}' },
  ] satisfies readonly DemoDiffLine[],
  terminal: {
    command: 'npm test -- gui-presentation',
    success: '模拟完成：17 tests passed；decideVerdict 授权完成。',
    failure: '模拟失败：旧刷新仍覆盖新序列；工作区保留待修，完成授权未授予。',
  },
} as const;

export const baseMessages: readonly DemoMessage[] = [
  {
    id: 'message_user_01',
    role: 'user',
    name: 'Ludi',
    time: '14:26',
    content: [{ type: 'text', text: guiRecover17.task.request }],
  },
  {
    id: 'message_assistant_01',
    role: 'assistant',
    name: 'Jarvis',
    time: '14:27',
    content: [
      {
        type: 'text',
        text: '已复现显示层竞态。持久化 Session 序列完整，旧刷新响应覆盖了较新的显示投影。准备把修复限制在 presentation 投影与现有测试。',
      },
      {
        type: 'reasoning',
        text: [
          '先比较 Session JSONL 的最新 sequence 与页面 applied sequence。',
          '确认持久化事实没有倒退，问题只出现在异步刷新回写顺序。',
          '沿用现有 mutation barrier，不增加新的状态层或 API。',
          '审批通过后只写 2 个现有文件，再运行聚焦测试。',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'message_assistant_02',
    role: 'assistant',
    name: 'Jarvis',
    time: '14:31',
    content: [
      {
        type: 'text',
        text: '补丁已整理为 2 个文件。写入会改变工作区，当前停在一次性审批；完成状态仍需聚焦测试与 decideVerdict 通过。',
      },
      {
        type: 'tool-call',
        toolCallId: 'tool_read_file',
        toolName: 'read_file',
        args: { target: 'presentation.js', status: 'complete', detail: '247 lines' },
        result: { summary: '247 lines' },
      },
      {
        type: 'tool-call',
        toolCallId: 'tool_rg',
        toolName: 'rg',
        args: { target: 'refreshSequence', status: 'complete', detail: '8 matches' },
        result: { summary: '8 matches' },
      },
      {
        type: 'tool-call',
        toolCallId: 'tool_apply_patch',
        toolName: 'apply_patch',
        args: { target: '2 files', status: 'approval', detail: 'workspace write' },
      },
      {
        type: 'tool-call',
        toolCallId: 'tool_vitest',
        toolName: 'vitest',
        args: { target: 'gui-presentation', status: 'pending', detail: 'queued after approval' },
      },
    ],
  },
];
