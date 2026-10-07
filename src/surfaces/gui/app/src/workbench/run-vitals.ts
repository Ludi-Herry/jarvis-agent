import type { GuiLiveSnapshot } from '../../../live-types.js';
import { formatCost, formatDuration, formatTokens } from './format.js';

/**
 * Batch 5 §运行状态: the 省心率 strip above the conversation. Every word derives from real
 * snapshot fields (phase/status/review/pendingInputs/nextAction/limits/usage) — no synthetic
 * percentages, no fabricated budget numbers.
 */

export interface RunVitals {
  readonly doing: string;
  readonly waiting: string;
  readonly next: string;
  readonly budget: string;
}

/** Run-only statuses; terminal states stay with the existing StatusCard. */
export const RUN_VITALS_STATUSES: readonly string[] = ['starting', 'running', 'approval', 'pausing', 'paused', 'checking', 'stopping'];

export function describeRunVitals(snapshot: GuiLiveSnapshot): RunVitals {
  let waiting = '—';
  if (snapshot.status === 'approval') waiting = '等你的审批决定';
  else if (snapshot.review !== null) waiting = '等你的逐项人工验收';
  else if (snapshot.status === 'pausing') waiting = '等当前工具或模型调用边界';
  else if (snapshot.status === 'paused') waiting = '已暂停；等你继续或终止';
  else if (snapshot.status === 'stopping') waiting = '等在途操作结束';
  else if (snapshot.status === 'checking') waiting = '等合同检查完成';
  else if (snapshot.status === 'running') {
    waiting = snapshot.pendingInputs.length > 0
      ? `等下一处理边界送达 ${snapshot.pendingInputs.length} 条补充`
      : '不阻塞你（可补充指令或急停）';
  }
  let budget = `已用 ${formatDuration(snapshot.elapsedMs)} / 上限 ${formatDuration(snapshot.limits.wallClockMs)}`
    + ` · 输入 ${formatTokens(snapshot.usage.inputTokens)} / 输出 ${formatTokens(snapshot.usage.outputTokens)}`;
  if (snapshot.usage.costCny !== null) budget += ` · 成本 ${formatCost(snapshot.usage.costCny)}`;
  return { doing: snapshot.phase, waiting, next: snapshot.nextAction, budget };
}
