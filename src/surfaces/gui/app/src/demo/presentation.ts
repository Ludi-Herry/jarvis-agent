import type { RunState } from './demo-reducer.js';
import { guiRecover17 } from './gui-recover-17.js';

export type Tone = 'info' | 'warning' | 'success' | 'danger' | 'muted';

export interface StatePresentation {
  readonly label: string;
  readonly detail: string;
  readonly tone: Tone;
  readonly outcome: string;
}

export const statePresentation: Record<RunState, StatePresentation> = {
  running: {
    label: '运行中',
    detail: '只读核对与补丁准备',
    tone: 'info',
    outcome: 'Agent 正在推进模拟任务。',
  },
  approval: {
    label: '需要审批',
    detail: '一次性写入 2 个现有文件',
    tone: 'warning',
    outcome: '高影响动作已停在人工 gate。',
  },
  paused: {
    label: '已暂停',
    detail: '现场、草稿与证据保持原位',
    tone: 'muted',
    outcome: '任务已暂停，继续后回到原阶段。',
  },
  validating: {
    label: '验证中',
    detail: '聚焦测试正在运行（模拟）',
    tone: 'info',
    outcome: '写入已允许一次，完成授权仍未授予。',
  },
  failed: {
    label: '运行失败',
    detail: '失败证据已保留',
    tone: 'danger',
    outcome: guiRecover17.terminal.failure,
  },
  interrupted: {
    label: '已终止',
    detail: '现场只读保留，可恢复',
    tone: 'danger',
    outcome: '本次模拟运行已终止，恢复入口持续可达。',
  },
  restored: {
    label: '已恢复现场',
    detail: '等待用户继续',
    tone: 'info',
    outcome: '滚动位置、证据页签与 Composer 草稿保持不变。',
  },
  completed: {
    label: '已完成',
    detail: 'decideVerdict · verified（模拟）',
    tone: 'success',
    outcome: guiRecover17.terminal.success,
  },
};

