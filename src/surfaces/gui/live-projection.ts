import type { GuiLiveSnapshot, GuiMessage, GuiTerminalEntry, GuiUndoFile } from './live-types.js';

/** Journal records are display observations, never a source of completion authority. */
export interface GuiObservedEvent {
  type: string;
  [key: string]: unknown;
}

/** Desk-side terminal projection caps (batch 3 §D17): merged output per history entry and the
 *  number of kept entries. */
export const GUI_TERMINAL_OUTPUT_CAP = 4_000;
export const GUI_TERMINAL_HISTORY_CAP = 20;

const TERMINAL_TRUNCATION_MARKER = '\n…[中间输出已截断]…\n';

/** Append a chunk, keeping the FIRST and LAST halves when the merged text exceeds the cap
 *  (首尾截断, contract §D14). Pure; replay-safe. */
export function appendTerminalOutput(existing: string, chunk: string, cap = GUI_TERMINAL_OUTPUT_CAP): string {
  const merged = existing + chunk;
  if (merged.length <= cap) return merged;
  const keep = Math.max(0, Math.floor((cap - TERMINAL_TRUNCATION_MARKER.length) / 2));
  return merged.slice(0, keep) + TERMINAL_TRUNCATION_MARKER + merged.slice(merged.length - keep);
}

export function applyGuiEvent(state: GuiLiveSnapshot, event: GuiObservedEvent): void {
  switch (event.type) {
    case 'model_started': {
      state.status = 'running';
      state.phase = '模型正在生成回复';
      const id = String(event.requestId ?? event.modelRunId);
      if (!state.messages.some((item) => item.id === id)) {
        state.messages.push({ id, role: 'assistant', text: '', at: String(event.at), status: 'running', toolIds: [] });
      }
      break;
    }
    case 'message_delta': {
      const last = state.messages.at(-1);
      if (last?.role === 'assistant' && last.status === 'running') last.text += String(event.text ?? '');
      break;
    }
    case 'model_finished': {
      const item = state.messages.find((message) => message.id === String(event.requestId ?? event.modelRunId));
      // The response is not complete until Session persistence confirms it.
      if (item && event.status !== 'completed') item.status = 'incomplete';
      break;
    }
    case 'gui_message': {
      const message = event.message as GuiMessage;
      const index = state.messages.findIndex((item) => item.id === message.id);
      if (index < 0) state.messages.push(message);
      else state.messages[index] = message;
      break;
    }
    case 'tool_call': {
      const call = event.call as { id: string; name: string; arguments: string };
      if (!state.tools.some((item) => item.id === call.id)) {
        state.tools.push({ id: call.id, name: call.name, arguments: call.arguments, status: 'proposed' });
      }
      const last = state.messages.at(-1);
      if (last?.role === 'assistant' && !last.toolIds.includes(call.id)) last.toolIds.push(call.id);
      break;
    }
    case 'tool_execution_started': {
      const tool = state.tools.find((item) => item.id === event.toolCallId);
      if (tool) tool.status = 'running';
      state.phase = `正在执行 ${String(event.toolName)}`;
      break;
    }
    case 'tool_result': {
      const out = event.out as { callId: string; content: string; error?: string; fileReceipt?: { kind: string; path: string; outcome?: string } };
      const tool = state.tools.find((item) => item.id === out.callId);
      if (tool) {
        tool.output = out.error ? `${out.error}\n${out.content}` : out.content;
        tool.path = out.fileReceipt?.path;
      }
      if (out.fileReceipt?.kind === 'write') {
        state.artifacts.push({ path: out.fileReceipt.path, outcome: out.fileReceipt.outcome ?? 'unknown' });
      }
      break;
    }
    case 'tool_execution_finished': {
      const tool = state.tools.find((item) => item.id === event.toolCallId);
      if (tool) tool.status = event.outcome as typeof tool.status;
      break;
    }
    case 'approval_request':
      state.status = 'approval';
      state.phase = '等待你的审批';
      break;
    case 'gui_approval':
      state.approval = event.approval as GuiLiveSnapshot['approval'];
      break;
    case 'approval_result':
      state.approvalHistory.push({ requestId: String(event.requestId), toolName: String(event.toolName), decision: String(event.decision), ...(typeof event.reason === 'string' ? { reason: event.reason } : {}) });
      state.approval = null;
      if (state.status === 'approval') state.status = 'running';
      break;
    case 'usage':
      state.usage.inputTokens += Number(event.inputTokens ?? 0);
      state.usage.outputTokens += Number(event.outputTokens ?? 0);
      break;
    case 'gui_status':
      state.status = event.status as GuiLiveSnapshot['status'];
      state.phase = String(event.phase);
      break;
    case 'gui_input_queued':
      state.pendingInputs.push(String(event.text));
      break;
    case 'gui_input_withdrawn': {
      // Batch 6 §可控: journal-deterministic splice; out-of-range indexes fold to a no-op so old
      // journals and boundary-raced withdraws never corrupt the queue.
      const index = Number(event.index);
      if (Number.isInteger(index) && index >= 0 && index < state.pendingInputs.length) state.pendingInputs.splice(index, 1);
      break;
    }
    case 'gui_meta': {
      if (typeof event.title === 'string') state.title = event.title;
      if (typeof event.pinned === 'boolean') state.pinned = event.pinned;
      if (typeof event.archived === 'boolean') state.archived = event.archived;
      break;
    }
    case 'gui_permission_mode':
      // plain-v1 P2: replay restores the composer mode; an unknown value folds to a no-op.
      if (event.mode === 'discuss' || event.mode === 'ask' || event.mode === 'auto') state.permissionMode = event.mode;
      break;
    case 'gui_undo':
      state.undo = {
        state: event.action === 'redo' ? 'redone' : 'undone',
        at: String(event.at ?? ''),
        files: Array.isArray(event.files) ? (event.files as GuiUndoFile[]).map((file) => ({ path: String(file.path), change: file.change })) : [],
        restoredTree: String(event.restoredTree ?? ''),
        savedTree: String(event.savedTree ?? ''),
      };
      break;
    case 'gui_inputs_consumed':
      state.pendingInputs.splice(0, Number(event.count));
      break;
    case 'gui_diff':
      state.diff = String(event.diff);
      break;
    case 'gui_terminal': {
      // Batch 3 §D14: start → open a running row; out → merge into the latest row; exit/cancel
      // → close it. Rows stay ordered oldest-first, capped at GUI_TERMINAL_HISTORY_CAP.
      state.terminal ??= { running: null, history: [] };
      const terminal = state.terminal;
      const entry = terminal.history.at(-1);
      switch (String(event.phase)) {
        case 'start': {
          const command = String(event.command ?? '');
          const at = String(event.at ?? '');
          terminal.running = { command, startedAt: at };
          const opened: GuiTerminalEntry = { command, code: null, output: '', canceled: false, at };
          terminal.history.push(opened);
          if (terminal.history.length > GUI_TERMINAL_HISTORY_CAP) terminal.history.splice(0, terminal.history.length - GUI_TERMINAL_HISTORY_CAP);
          break;
        }
        case 'out':
          if (entry) entry.output = appendTerminalOutput(entry.output, String(event.chunk ?? ''));
          break;
        case 'exit':
          if (entry && entry.code === null && !entry.canceled) {
            entry.code = typeof event.code === 'number' ? event.code : null;
            entry.at = String(event.at ?? entry.at);
          }
          terminal.running = null;
          break;
        case 'cancel':
          if (entry && entry.code === null) {
            entry.canceled = true;
            // Batch 5 §恢复: the cancel reason survives the fold so the UI can tell 超时/中断/用户取消 apart.
            if (typeof event.reason === 'string') entry.cause = event.reason as GuiTerminalEntry['cause'];
            entry.at = String(event.at ?? entry.at);
          }
          terminal.running = null;
          break;
      }
      break;
    }
    case 'gui_warning':
      if (!state.warnings.includes(String(event.message))) state.warnings.push(String(event.message));
      break;
    case 'halt':
      state.phase = `运行停止：${String(event.reason)}`;
      break;
    case 'state':
      state.phase = String(event.phase);
      break;
    case 'check_finished':
      state.status = 'checking';
      state.phase = '正在核对可信验证证据';
      break;
    case 'final':
      // A model final is deliberately not a task verdict.
      state.phase = '模型本轮回复结束；等待 Runtime 裁决';
      break;
    case 'verdict':
    case 'goal_state':
    case 'goal_round_start':
    case 'goal_round_end':
    case 'hook_output':
    case 'gui_elapsed':
    case 'gui_settled':
    case 'gui_review_recorded':
    case 'gui_checked_evidence':
    case 'gui_task_started':
      break;
    default: {
      const warning = `暂不支持的事件已保留：${event.type}`;
      if (!state.warnings.includes(warning)) state.warnings.push(warning);
    }
  }
}

export function updateGuiCapabilities(state: GuiLiveSnapshot, running: boolean): void {
  state.capabilities = {
    submit: running && ['running', 'approval', 'pausing', 'paused'].includes(state.status),
    pause: running && state.status === 'running',
    continue: running && ['paused', 'pausing'].includes(state.status),
    stop: running && state.status !== 'stopping',
    resume: !running && state.status === 'recoverable',
  };
  state.nextAction = state.status === 'idle' ? '任务已创建，待启动；可检查后启动、归档或更新元数据'
    : state.status === 'approval' ? '检查工具请求，允许一次、拒绝或填写调整意见'
    : state.status === 'paused' ? '补充指令后继续，或终止本次运行'
    : state.status === 'pausing' ? '等待当前工具执行完毕，到下一模型调用边界暂停'
    : state.status === 'stopping' ? '等待 Runtime 结束在途操作；尚未确认安全停止'
    : state.status === 'recoverable' ? '检查已恢复的 Session 事实；通过恢复校验后才继续'
    : state.review ? '检查产物、Diff 和验证输出，再逐项记录人工验收'
    : state.status === 'complete' ? '检查已授权的交付物；本次 Web 任务结束'
    : ['interrupted', 'blocked', 'unavailable'].includes(state.status) ? '查看阻塞原因及保留的证据；终态不会自动重跑'
    : '观察执行过程；需要时补充指令或终止';
}
