import { describe, expect, it } from 'vitest';
import {
  initialTuiState,
  reduceTui,
  type TuiAction,
  type TuiState,
} from '../../src/surfaces/cli/tui-state.js';
import type { Event } from '../../src/runtime/event-bus.js';

function step(state: TuiState, action: TuiAction): { state: TuiState; effects: readonly unknown[] } {
  return reduceTui(state, action);
}

function event(state: TuiState, value: Event): TuiState {
  return step(state, { type: 'event', event: value }).state;
}

describe('tui state reducer', () => {
  it('starts idle with an empty FIFO and no identities', () => {
    expect(initialTuiState()).toEqual({
      status: 'idle',
      queue: [],
    });
  });

  it('starts an idle submission and queues later prompts without exposing prompt text to audit', () => {
    const first = step(initialTuiState(), { type: 'submit', text: 'first prompt', mode: 'queue' });
    expect(first.state.status).toBe('model-running');
    expect(first.effects).toEqual([
      { type: 'startRun', prompt: 'first prompt' },
      { type: 'appendAudit', detail: { kind: 'submit', mode: 'queue', textLength: 12, queueDepth: 0 } },
    ]);

    const running = event(first.state, {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 0,
    });
    const queued = step(running, { type: 'submit', text: 'untrusted queued prompt', mode: 'queue' });
    expect(queued.state.status).toBe('model-running');
    expect(queued.state.queue).toEqual(['untrusted queued prompt']);
    expect(queued.effects).toEqual([
      { type: 'appendAudit', detail: { kind: 'submit', mode: 'queue', textLength: 23, queueDepth: 1, runId: 'run-1' } },
    ]);
    expect(JSON.stringify(queued.effects)).not.toContain('untrusted queued prompt');
  });

  it('uses one redirect slot, preserving a second redirect request in FIFO order', () => {
    const running = event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 0,
    });

    const redirected = step(running, { type: 'submit', text: 'redirect one', mode: 'redirect' });
    expect(redirected.state).toMatchObject({ status: 'stopping', runId: 'run-1', redirect: 'redirect one' });
    expect(redirected.effects).toEqual([
      { type: 'abortRun', runId: 'run-1' },
      { type: 'appendAudit', detail: { kind: 'submit', mode: 'redirect', textLength: 12, queueDepth: 0, runId: 'run-1' } },
    ]);

    const second = step(redirected.state, { type: 'submit', text: 'redirect two', mode: 'redirect' });
    expect(second.state.redirect).toBe('redirect one');
    expect(second.state.queue).toEqual(['redirect two']);
    expect(JSON.stringify(second.effects)).not.toContain('redirect two');
  });

  it('maps model and tool lifecycle events by stable run/tool identities', () => {
    const started = event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      requestId: 'request-1',
      turn: 1,
      messageCount: 4,
      toolSchemaCount: 2,
    });
    expect(started).toMatchObject({ status: 'model-running', runId: 'run-1' });

    const toolStarted = event(started, {
      type: 'tool_execution_started',
      modelRunId: 'run-1',
      executionId: 'exec-1',
      toolCallId: 'call-1',
      toolName: 'read',
    });
    expect(toolStarted).toMatchObject({
      status: 'tool-running',
      runId: 'run-1',
      tool: { executionId: 'exec-1', toolCallId: 'call-1', toolName: 'read' },
    });

    const toolFinished = event(toolStarted, {
      type: 'tool_execution_finished',
      modelRunId: 'run-1',
      executionId: 'exec-1',
      toolCallId: 'call-1',
      toolName: 'read',
      outcome: 'committed',
    });
    expect(toolFinished).toMatchObject({ status: 'model-running', runId: 'run-1' });
    expect(toolFinished.tool).toBeUndefined();

    const stale = event(toolFinished, {
      type: 'tool_execution_started',
      modelRunId: 'run-old',
      executionId: 'exec-old',
      toolCallId: 'call-old',
      toolName: 'write',
    });
    expect(stale).toEqual(toolFinished);

    const nextTurn = event(toolFinished, {
      type: 'model_started',
      modelRunId: 'run-2',
      turn: 2,
      messageCount: 6,
      toolSchemaCount: 2,
    });
    expect(nextTurn).toMatchObject({ status: 'model-running', runId: 'run-2', turn: 2 });
    expect(event(nextTurn, {
      type: 'model_started',
      modelRunId: 'run-old',
      turn: 1,
      messageCount: 5,
      toolSchemaCount: 2,
    })).toEqual(nextTurn);

    const finished = event(nextTurn, {
      type: 'model_finished',
      modelRunId: 'run-2',
      turn: 2,
      status: 'completed',
    });
    expect(finished).toMatchObject({ status: 'model-running', runId: 'run-2', turn: 2 });
    expect(step(finished, { type: 'runClosed', outcome: 'completed', pendingEffects: false }).state)
      .toEqual({ status: 'idle', queue: [] });
  });

  it('does not let stale lifecycle events resurrect a stopping or approval-pending run', () => {
    const running = event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 0,
    });
    const stopping = step(running, { type: 'esc' }).state;
    expect(event(stopping, {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 1,
      messageCount: 3,
      toolSchemaCount: 0,
    })).toEqual(stopping);

    const pending = event(running, {
      type: 'approval_request',
      requestId: 'approval-1',
      toolName: 'write',
      capability: 'writes-files',
      reason: 'review',
      detail: 'detail',
      at: 'now',
    });
    expect(event(pending, {
      type: 'tool_execution_finished',
      modelRunId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'write',
      outcome: 'committed',
    })).toEqual(pending);
  });

  it('waits for runClosed before starting redirect or FIFO work', () => {
    const running = event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 0,
    });
    const queued = step(running, { type: 'submit', text: 'queued', mode: 'queue' }).state;
    const closed = step(queued, { type: 'runClosed', outcome: 'completed', pendingEffects: false });
    expect(closed.state.status).toBe('model-running');
    expect(closed.state.redirect).toBeUndefined();
    expect(closed.state.runId).toBeUndefined();
    expect(closed.state.queue).toEqual([]);
    expect(closed.effects).toEqual([{ type: 'startRun', prompt: 'queued' }]);
  });

  it('fails closed on pending or unknown effects and does not auto-start work', () => {
    const running = event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 0,
    });
    const queued = step(running, { type: 'submit', text: 'must wait', mode: 'queue' }).state;
    const blocked = step(queued, {
      type: 'runClosed',
      outcome: 'completed',
      pendingEffects: { pending: false, unknown: true },
    });
    expect(blocked.state).toMatchObject({ status: 'needs-human', runId: 'run-1' });
    expect(blocked.state.queue).toEqual(['must wait']);
    expect(blocked.effects).toEqual([
      { type: 'appendAudit', detail: { kind: 'run-closed', outcome: 'completed', pendingEffects: true, runId: 'run-1' } },
    ]);

    const recovered = step(blocked.state, { type: 'runClosed', outcome: 'reconciled', pendingEffects: false });
    expect(recovered.state.status).toBe('model-running');
    expect(recovered.state.queue).toEqual([]);
    expect(recovered.effects).toEqual([{ type: 'startRun', prompt: 'must wait' }]);
  });

  it('Esc denies a pending approval before aborting the run', () => {
    const running = event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 1,
    });
    const pending = event(running, {
      type: 'approval_request',
      requestId: 'approval-1',
      toolName: 'write',
      capability: 'writes-files',
      reason: 'needs review',
      detail: 'untrusted detail must not be copied',
      at: 'now',
    });
    expect(pending).toMatchObject({
      status: 'approval-pending',
      approval: { requestId: 'approval-1', returnStatus: 'model-running' },
    });

    const cancelled = step(pending, { type: 'esc' });
    expect(cancelled.state).toMatchObject({ status: 'stopping', runId: 'run-1' });
    expect(cancelled.state.approval).toBeUndefined();
    expect(cancelled.effects.slice(0, 2)).toEqual([
      { type: 'resolveApproval', requestId: 'approval-1', decision: 'deny' },
      { type: 'abortRun', runId: 'run-1' },
    ]);
  });

  it('approvalDecision emits a resolution and approval_result restores the prior state', () => {
    const pending = event(event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 1,
    }), {
      type: 'approval_request',
      requestId: 'approval-1',
      toolName: 'bash',
      capability: 'executes-code',
      reason: 'needs review',
      detail: 'detail',
      at: 'now',
    });
    const decision = step(pending, { type: 'approvalDecision', requestId: 'approval-1', decision: 'allow-once' });
    expect(decision.state.status).toBe('approval-pending');
    expect(decision.effects).toEqual([
      { type: 'resolveApproval', requestId: 'approval-1', decision: 'allow-once' },
      { type: 'appendAudit', detail: { kind: 'approval', requestId: 'approval-1', decision: 'allow-once' } },
    ]);

    const restored = event(decision.state, {
      type: 'approval_result',
      requestId: 'approval-1',
      toolName: 'bash',
      decision: 'allow-once',
      at: 'later',
    });
    expect(restored).toMatchObject({ status: 'model-running', runId: 'run-1' });
    expect(restored.approval).toBeUndefined();
  });

  it('handles first and second Ctrl-C, idle Ctrl-C, and EOF deterministically', () => {
    const running = event(initialTuiState(), {
      type: 'model_started',
      modelRunId: 'run-1',
      turn: 0,
      messageCount: 2,
      toolSchemaCount: 0,
    });
    const stopping = step(running, { type: 'ctrlC' });
    expect(stopping.state.status).toBe('stopping');
    expect(stopping.effects).toEqual([
      { type: 'abortRun', runId: 'run-1' },
      { type: 'appendAudit', detail: { kind: 'interrupt', source: 'ctrl-c', runId: 'run-1' } },
    ]);
    const closed = step(stopping.state, { type: 'ctrlC' });
    expect(closed.state.status).toBe('closed');
    expect(closed.effects).toEqual([
      { type: 'exit', code: 130 },
      { type: 'appendAudit', detail: { kind: 'interrupt', source: 'ctrl-c', runId: 'run-1' } },
    ]);

    const idleClosed = step(initialTuiState(), { type: 'ctrlC' });
    expect(idleClosed).toEqual({
      state: { status: 'closed', queue: [] },
      effects: [
        { type: 'exit', code: 130 },
        { type: 'appendAudit', detail: { kind: 'interrupt', source: 'ctrl-c' } },
      ],
    });

    const eof = step(initialTuiState(), { type: 'eof' });
    expect(eof).toEqual({
      state: { status: 'closed', queue: [] },
      effects: [{ type: 'exit', code: 0 }, { type: 'appendAudit', detail: { kind: 'eof' } }],
    });
  });
});
