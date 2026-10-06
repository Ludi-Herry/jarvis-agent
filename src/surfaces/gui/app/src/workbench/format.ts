import type { GuiRunStatus, GuiTool } from '../../../live-types.js';

export const statusPresentation: Record<GuiRunStatus, { readonly label: string; readonly tone: string }> = {
  idle: { label: '等待开始', tone: 'muted' },
  starting: { label: '正在启动', tone: 'info' },
  running: { label: '运行中', tone: 'info' },
  approval: { label: '需要审批', tone: 'warning' },
  pausing: { label: '正在暂停', tone: 'warning' },
  paused: { label: '已暂停', tone: 'muted' },
  checking: { label: '正在验证', tone: 'info' },
  stopping: { label: '正在终止', tone: 'danger' },
  interrupted: { label: '已终止', tone: 'danger' },
  blocked: { label: '已阻塞', tone: 'danger' },
  complete: { label: '已完成', tone: 'success' },
  recoverable: { label: '可恢复', tone: 'warning' },
  unavailable: { label: '现场不可用', tone: 'danger' },
};

export const toolStatusLabels: Record<GuiTool['status'], string> = {
  proposed: '待执行',
  running: '运行中',
  committed: '已执行',
  denied: '已拒绝',
  failed: '失败',
  unknown: '未知',
};

export const toolKindLabels: Record<string, string> = {
  write: '写入文件',
  edit: '修改文件',
  bash: '运行命令',
  read: '读取文件',
  grep: '检索内容',
  update_goal: '更新任务状态',
};

export function shortObjective(text: string): string {
  return text.split(/[。\n]/u)[0].slice(0, 120);
}

export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function formatTokens(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
}

export function formatCost(costCny: number | null): string {
  return costCny === null ? '未知' : `¥${costCny.toFixed(4)}`;
}

export function stringValue(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/** Only an actual run counts as running; a model final or an HTTP 200 never does. */
export function isActuallyRunning(status: GuiRunStatus | undefined): boolean {
  return status === 'starting'
    || status === 'running'
    || status === 'pausing'
    || status === 'checking'
    || status === 'stopping';
}

export function statusDetail(snapshot: { status: GuiRunStatus; phase: string; nextAction: string } | null): string {
  if (snapshot === null) return '等待真实待办';
  if (snapshot.status === 'pausing') return '等待当前安全边界';
  if (snapshot.status === 'stopping') return '正在阻止后续动作';
  return snapshot.nextAction || snapshot.phase || '状态已更新';
}

export function workspaceName(cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === '') return '未接入';
  const parts = cwd.split(/[\\/]/u).filter((part) => part !== '');
  return parts.at(-1) ?? cwd;
}
