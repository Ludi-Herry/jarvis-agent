/**
 * Pure state machine for the checkpoint/TUI contract.
 *
 * The reducer only observes EventBus lifecycle facts and returns declarative effects for a
 * renderer/host to perform. It does not call AgentLoop, PermissionGate, Session, or any I/O.
 * Prompt bodies are allowed on startRun (the host needs them), but audit effects contain only
 * bounded metadata and stable identities.
 */
import type { Event } from '../../runtime/event-bus.js';

export type TuiEvent = Event;

export type TuiStatus =
  | 'idle'
  | 'model-running'
  | 'tool-running'
  | 'approval-pending'
  | 'stopping'
  | 'needs-human'
  | 'closed';

export type ApprovalDecision = 'allow-once' | 'allow-session' | 'deny';
export type PromptMode = 'queue' | 'redirect';

export interface TuiToolIdentity {
  modelRunId: string;
  toolCallId: string;
  toolName: string;
  executionId?: string;
}

export interface TuiApprovalState {
  requestId: string;
  toolName: string;
  returnStatus: 'model-running' | 'tool-running';
  decision?: ApprovalDecision;
}

export interface TuiState {
  status: TuiStatus;
  /** Pending user prompts in arrival order. */
  queue: string[];
  /** Stable identity of the current model wave, when the host has announced it. */
  runId?: string;
  /** Provider turn lets the reducer reject an old model event while accepting the next wave. */
  turn?: number;
  tool?: TuiToolIdentity;
  approval?: TuiApprovalState;
  /** At most one prompt may wait for the current run to close. */
  redirect?: string;
}

export interface TuiSubmitAction {
  type: 'submit';
  text: string;
  /** Explicit mode used by the renderer. Defaults to queue. */
  mode?: PromptMode;
  /** Compatibility spelling for adapters that keep separate queue/redirect flags. */
  queue?: boolean;
  redirect?: boolean;
}

export interface TuiRunClosedAction {
  type: 'runClosed';
  /** Host-owned bounded outcome label; no completion authority is inferred here. */
  outcome: string;
  /** A boolean is accepted for the simple host path; the object form keeps pending/unknown explicit. */
  pendingEffects?: boolean | PendingEffects;
  runId?: string;
}

export interface PendingEffects {
  pending?: boolean;
  unknown?: boolean;
  hasPending?: boolean;
  count?: number;
}

export type TuiAction =
  | TuiSubmitAction
  | { type: 'event'; event: Event }
  | TuiRunClosedAction
  | { type: 'esc' }
  | { type: 'ctrlC' }
  | { type: 'approvalDecision'; requestId?: string; decision: ApprovalDecision }
  | { type: 'eof' };

export type TuiAuditDetail =
  | {
      kind: 'submit';
      mode: PromptMode;
      textLength: number;
      queueDepth: number;
      runId?: string;
    }
  | {
      kind: 'run-closed';
      outcome: string;
      pendingEffects: boolean;
      runId?: string;
    }
  | {
      kind: 'interrupt';
      source: 'esc' | 'ctrl-c' | 'eof';
      runId?: string;
      requestId?: string;
    }
  | {
      kind: 'approval';
      requestId: string;
      decision: ApprovalDecision;
    }
  | { kind: 'eof' };

export type TuiEffect =
  | { type: 'startRun'; prompt: string }
  | { type: 'abortRun'; runId?: string }
  | { type: 'resolveApproval'; requestId: string; decision: ApprovalDecision }
  | { type: 'exit'; code: 0 | 130 }
  | { type: 'appendAudit'; detail: TuiAuditDetail };

export interface TuiTransition {
  state: TuiState;
  effects: TuiEffect[];
}

export function initialTuiState(): TuiState {
  return { status: 'idle', queue: [] };
}

/** One pure transition. State and its queue are never mutated in place. */
export function reduceTui(state: TuiState, action: TuiAction): TuiTransition {
  switch (action.type) {
    case 'submit':
      return submit(state, action);
    case 'event':
      return { state: reduceEvent(state, action.event), effects: [] };
    case 'runClosed':
      return runClosed(state, action);
    case 'esc':
      return interrupt(state, 'esc');
    case 'ctrlC':
      return ctrlC(state);
    case 'approvalDecision':
      return approvalDecision(state, action.requestId, action.decision);
    case 'eof':
      return eof(state);
    default:
      return { state, effects: [] };
  }
}

/** Alias kept intentionally small so a renderer adapter can name the function as a reducer. */
export const tuiReducer = reduceTui;
export const reduceTuiState = reduceTui;

function submit(state: TuiState, action: TuiSubmitAction): TuiTransition {
  if (state.status === 'closed') return empty(state);

  const mode = submitMode(action);
  const runId = state.runId;
  if (state.status === 'idle') {
    const next = {
      ...state,
      status: 'model-running' as const,
      queue: [...state.queue],
    };
    const effects: TuiEffect[] = [{ type: 'startRun', prompt: action.text }];
    effects.push(audit({ kind: 'submit', mode, textLength: boundedLength(action.text), queueDepth: boundedQueueDepth(next.queue.length) }));
    return { state: next, effects };
  }

  if (isActive(state.status)) {
    if (mode === 'redirect' && state.redirect === undefined) {
      const next: TuiState = { ...state, status: 'stopping', redirect: action.text, queue: [...state.queue] };
      const effects: TuiEffect[] = [];
      if (state.approval) effects.push({ type: 'resolveApproval', requestId: state.approval.requestId, decision: 'deny' });
      if (state.status !== 'stopping') effects.push(abort(state.runId));
      effects.push(audit({
        kind: 'submit', mode, textLength: boundedLength(action.text), queueDepth: boundedQueueDepth(next.queue.length),
        ...(runId === undefined ? {} : { runId }),
      }));
      return { state: withoutApproval(next), effects };
    }

    // Redirect has one slot. A later redirect is kept in the FIFO so no user input is silently lost.
    const queue = [...state.queue, action.text];
    const next: TuiState = { ...state, queue };
    return {
      state: next,
      effects: [audit({
        kind: 'submit', mode, textLength: boundedLength(action.text), queueDepth: boundedQueueDepth(queue.length),
        ...(runId === undefined ? {} : { runId }),
      })],
    };
  }

  if (state.status === 'needs-human') {
    const queue = [...state.queue, action.text];
    return {
      state: { ...state, queue },
      effects: [audit({
        kind: 'submit', mode: 'queue', textLength: boundedLength(action.text), queueDepth: boundedQueueDepth(queue.length),
        ...(runId === undefined ? {} : { runId }),
      })],
    };
  }

  return empty(state);
}

function runClosed(state: TuiState, action: TuiRunClosedAction): TuiTransition {
  if (state.status === 'closed') return empty(state);
  if (action.runId !== undefined && action.runId !== state.runId) return empty(state);

  // An unresolved approval is itself a pending effect. It must never be bypassed by a host that
  // reports a clean run close before the approval_result event arrives.
  const pending = state.status === 'approval-pending' || hasPendingEffects(action.pendingEffects);
  if (pending) {
    return {
      state: { ...state, status: 'needs-human' },
      effects: [audit({
        kind: 'run-closed', outcome: boundedOutcome(action.outcome), pendingEffects: true,
        ...(state.runId === undefined ? {} : { runId: state.runId }),
      })],
    };
  }

  const prompt = state.redirect ?? state.queue[0];
  const remainingQueue = state.redirect === undefined ? state.queue.slice(1) : [...state.queue];
  const next: TuiState = {
    status: prompt === undefined ? 'idle' : 'model-running',
    queue: remainingQueue,
  };
  if (prompt !== undefined) return { state: next, effects: [{ type: 'startRun', prompt }] };
  return { state: next, effects: [] };
}

function reduceEvent(state: TuiState, event: Event): TuiState {
  if (state.status === 'closed') return state;

  switch (event.type) {
    case 'model_started': {
      if (state.status === 'tool-running' || state.status === 'approval-pending'
        || state.status === 'stopping' || state.status === 'needs-human') return state;
      if (state.turn !== undefined && event.turn < state.turn) return state;
      if (state.turn !== undefined && event.turn === state.turn
        && state.runId !== undefined && state.runId !== event.modelRunId) return state;
      const next: TuiState = {
        ...state, status: 'model-running', runId: event.modelRunId, turn: event.turn,
      };
      delete next.tool;
      delete next.approval;
      return next;
    }
    case 'model_finished': {
      if (!matchesRun(state, event.modelRunId) || !matchesTurn(state, event.turn) || state.status === 'tool-running'
        || state.status === 'approval-pending' || state.status === 'stopping' || state.status === 'needs-human') return state;
      // Provider completion is not host completion: tool execution or final
      // persistence may still follow. Only runClosed may expose idle/start FIFO.
      return state;
    }
    case 'tool_execution_started': {
      if (state.status === 'approval-pending' || state.status === 'stopping' || state.status === 'needs-human') return state;
      if (!matchesRun(state, event.modelRunId)) return state;
      return {
        ...state,
        status: 'tool-running',
        tool: {
          modelRunId: event.modelRunId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
        },
      };
    }
    case 'tool_execution_finished': {
      if (state.status === 'approval-pending' || state.status === 'stopping' || state.status === 'needs-human' || !state.tool) return state;
      if (!matchesRun(state, event.modelRunId) || !matchesTool(state.tool, event)) return state;
      const next: TuiState = { ...state, status: 'model-running' };
      delete next.tool;
      return next;
    }
    case 'approval_request': {
      if (!isApprovalSourceStatus(state.status) || state.approval) return state;
      return {
        ...state,
        status: 'approval-pending',
        approval: { requestId: event.requestId, toolName: event.toolName, returnStatus: state.status },
      };
    }
    case 'approval_result': {
      if (state.status !== 'approval-pending' || !state.approval || state.approval.requestId !== event.requestId) return state;
      const next: TuiState = { ...state, status: state.approval.returnStatus };
      delete next.approval;
      return next;
    }
    default:
      return state;
  }
}

function approvalDecision(state: TuiState, requestId: string | undefined, decision: ApprovalDecision): TuiTransition {
  if (state.status !== 'approval-pending' || !state.approval) return empty(state);
  if (requestId !== undefined && requestId !== state.approval.requestId) return empty(state);
  if (state.approval.decision !== undefined) return empty(state);
  const id = state.approval.requestId;
  return {
    state: { ...state, approval: { ...state.approval, decision } },
    effects: [
      { type: 'resolveApproval', requestId: id, decision },
      audit({ kind: 'approval', requestId: id, decision }),
    ],
  };
}

function interrupt(state: TuiState, source: 'esc' | 'ctrl-c' | 'eof'): TuiTransition {
  if (!isActive(state.status) || state.status === 'stopping') return empty(state);
  const effects: TuiEffect[] = [];
  const requestId = state.approval?.requestId;
  if (requestId !== undefined) effects.push({ type: 'resolveApproval', requestId, decision: 'deny' });
  effects.push(abort(state.runId));
  effects.push(audit({
    kind: 'interrupt', source,
    ...(state.runId === undefined ? {} : { runId: state.runId }),
    ...(requestId === undefined ? {} : { requestId }),
  }));
  const next: TuiState = { ...state, status: 'stopping' };
  delete next.approval;
  return { state: next, effects };
}

function ctrlC(state: TuiState): TuiTransition {
  if (state.status === 'stopping') {
    return {
      state: { ...state, status: 'closed' },
      effects: [
        { type: 'exit', code: 130 },
        audit({
          kind: 'interrupt', source: 'ctrl-c',
          ...(state.runId === undefined ? {} : { runId: state.runId }),
        }),
      ],
    };
  }
  if (state.status === 'idle') {
    return {
      state: { ...state, status: 'closed' },
      effects: [{ type: 'exit', code: 130 }, audit({ kind: 'interrupt', source: 'ctrl-c' })],
    };
  }
  return interrupt(state, 'ctrl-c');
}

function eof(state: TuiState): TuiTransition {
  if (state.status === 'idle' || state.status === 'needs-human' || state.status === 'stopping') {
    return {
      state: { ...state, status: 'closed' },
      effects: [
        { type: 'exit', code: 0 },
        audit(state.status === 'idle' || state.status === 'needs-human'
          ? { kind: 'eof' }
          : {
              kind: 'interrupt', source: 'eof',
              ...(state.runId === undefined ? {} : { runId: state.runId }),
            }),
      ],
    };
  }
  return interrupt(state, 'eof');
}

function empty(state: TuiState): TuiTransition {
  return { state, effects: [] };
}

function audit(detail: TuiAuditDetail): TuiEffect {
  return { type: 'appendAudit', detail };
}

function abort(runId: string | undefined): TuiEffect {
  return runId === undefined ? { type: 'abortRun' } : { type: 'abortRun', runId };
}

function withoutApproval(state: TuiState): TuiState {
  if (state.approval === undefined) return state;
  const next = { ...state };
  delete next.approval;
  return next;
}

function submitMode(action: TuiSubmitAction): PromptMode {
  if (action.mode !== undefined) return action.mode;
  if (action.redirect === true || action.queue === false) return 'redirect';
  return 'queue';
}

function isActive(status: TuiStatus): boolean {
  return status === 'model-running' || status === 'tool-running' || status === 'approval-pending' || status === 'stopping';
}

function isApprovalSourceStatus(status: TuiStatus): status is 'model-running' | 'tool-running' {
  return status === 'model-running' || status === 'tool-running';
}

function matchesRun(state: TuiState, modelRunId: string): boolean {
  return state.runId === undefined || state.runId === modelRunId;
}

function matchesTurn(state: TuiState, turn: number): boolean {
  return state.turn === undefined || state.turn === turn;
}

function matchesTool(
  tool: TuiToolIdentity,
  event: Extract<Event, { type: 'tool_execution_finished' }>,
): boolean {
  if (tool.toolCallId !== event.toolCallId || tool.toolName !== event.toolName) return false;
  return tool.executionId === undefined || event.executionId === undefined || tool.executionId === event.executionId;
}

function hasPendingEffects(value: boolean | PendingEffects | undefined): boolean {
  if (value === true) return true;
  if (value === false || value === undefined) return false;
  return value.pending === true || value.unknown === true || value.hasPending === true || (value.count ?? 0) > 0;
}

function boundedLength(text: string): number {
  return Math.min(text.length, 1_000_000);
}

function boundedQueueDepth(depth: number): number {
  return Math.min(depth, 1_000_000);
}

function boundedOutcome(outcome: string): string {
  return outcome.length > 128 ? outcome.slice(0, 128) : outcome;
}
