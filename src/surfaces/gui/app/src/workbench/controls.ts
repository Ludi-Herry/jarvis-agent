import type { GuiConnectionState, GuiLiveOverview, GuiLiveSnapshot } from '../../../live-types.js';

export interface ControlState {
  readonly available: boolean;
  readonly reason: string;
}

export interface RunControls {
  readonly pause: ControlState;
  readonly continueRun: ControlState;
  readonly stop: ControlState;
  readonly resume: ControlState;
}

export interface ComposerIntent {
  readonly kind: 'deny' | 'revise';
  readonly requestId: string;
}

const AVAILABLE: ControlState = { available: true, reason: '' };
const OFFLINE: ControlState = { available: false, reason: '连接已中断，控制暂时停用；恢复连接后会按持久事实重建。' };
const NOT_STARTED: ControlState = { available: false, reason: '当前没有运行现场。' };
const BUSY: ControlState = { available: false, reason: '另一项操作正在确认中。' };
const ENTRY_CLOSED: ControlState = { available: false, reason: '真实运行入口当前未启用。' };

function blocked(reason: string): ControlState {
  return { available: false, reason };
}

/** Runtime capability first, transport second; the UI never widens what the host granted. */
export function resolveGate(
  overview: GuiLiveOverview | null,
  connection: GuiConnectionState,
): ControlState {
  if (overview !== null && !overview.enabled) return ENTRY_CLOSED;
  if (connection === 'connected') return AVAILABLE;
  if (connection === 'connecting' || connection === 'loading') return blocked('正在恢复当前现场，控制暂时停用。');
  if (connection === 'disconnected') return OFFLINE;
  return blocked('当前现场只读，没有可用的控制入口。');
}

export function resolveRunControls(
  snapshot: GuiLiveSnapshot | null,
  gate: ControlState,
  pending: boolean,
): RunControls {
  if (snapshot === null) return { pause: NOT_STARTED, continueRun: NOT_STARTED, stop: NOT_STARTED, resume: NOT_STARTED };
  const base = pending ? BUSY : gate;
  if (!base.available) return { pause: base, continueRun: base, stop: base, resume: base };

  const caps = snapshot.capabilities;
  const status = snapshot.status;
  const pause = !caps.pause
    ? blocked('Runtime 当前不接受暂停；只有运行中的任务能在模型调用边界暂停。')
    : status === 'pausing'
      ? blocked('已经在等待下一个模型调用边界。')
      : status === 'stopping'
        ? blocked('正在终止，不能再暂停。')
        : AVAILABLE;
  const continueRun = !caps.continue
    ? blocked('Runtime 当前没有可继续的暂停点。')
    : status !== 'paused' && status !== 'pausing'
      ? blocked('只有已暂停或正在暂停的运行能继续。')
      : AVAILABLE;
  const stop = !caps.stop
    ? blocked('Runtime 当前没有可终止的运行。')
    : status === 'stopping'
      ? blocked('终止请求已提交，正在阻止后续动作。')
      : status === 'interrupted'
        ? blocked('运行已经停止。')
        : status === 'blocked' || status === 'complete'
          ? blocked('终态不会自动重跑，无需终止。')
          : AVAILABLE;
  const resume = !caps.resume
    ? blocked('当前没有可用的恢复入口；这个现场保持只读。')
    : status !== 'recoverable'
      ? blocked('只有宿主标记为可恢复的现场才能恢复执行。')
      : AVAILABLE;
  return { pause, continueRun, stop, resume };
}

export function resolveCanStart(
  selectedId: string | null,
  overview: GuiLiveOverview | null,
): ControlState {
  if (overview === null) return blocked('正在读取本地任务。');
  if (!overview.enabled) return ENTRY_CLOSED;
  if (overview.task === null) return blocked('尚未配置真实任务合同；GUI 不能自行创建任务。');
  if (selectedId !== null) return blocked('已选中既有会话；补充指令请回到该会话。');
  if (overview.activeId !== null) return blocked('已有运行中的任务，不能同时启动第二个。');
  if (overview.sessions.length > 0) return blocked('本次真实任务已有运行记录；请恢复或审阅该记录。');
  return AVAILABLE;
}

export function resolveComposer(
  snapshot: GuiLiveSnapshot | null,
  gate: ControlState,
  pending: boolean,
  intent: ComposerIntent | null,
  canStart: ControlState,
): ControlState {
  if (pending) return BUSY;
  if (!gate.available) return gate;
  if (intent !== null) {
    return snapshot?.approval?.requestId === intent.requestId
      ? AVAILABLE
      : blocked('当前审批已经变化，请重新核对后提交。');
  }
  if (snapshot === null) return canStart;
  if (snapshot.status === 'blocked') return blocked('任务已阻塞，不再接收补充指令。');
  if (snapshot.status === 'complete') return blocked('任务已结束，不再接收补充指令。');
  return snapshot.capabilities.submit
    ? AVAILABLE
    : blocked('Runtime 当前不在可接收补充指令的状态。');
}

export function resolveDecide(snapshot: GuiLiveSnapshot | null, gate: ControlState, pending: boolean): ControlState {
  if (snapshot?.approval == null) return blocked('当前没有等待处理的审批。');
  if (pending) return BUSY;
  return gate;
}

/**
 * Batch 3 §A3: viewing and switching is always allowed — observation is read-only and carries no
 * misoperation space. Control buttons keep targeting the selected task's own capabilities, and the
 * host dispatches emergency stop by task id, so switching never endangers another running task.
 */
export function resolveSessionSwitch(
  targetId: string | null,
  overview: GuiLiveOverview | null,
): ControlState {
  void targetId;
  void overview;
  return AVAILABLE;
}
