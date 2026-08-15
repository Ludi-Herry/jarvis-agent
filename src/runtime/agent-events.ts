import type { Event } from './event-bus.js';
import type { FinishReason } from '../core/model/types.js';
import type { ToolCapability } from '../core/tools/types.js';
import type { Approval } from './permission/permission-gate.js';

export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

export type AgentEventRoot = 'run' | 'goal' | 'loop';
export type AgentEventType =
  | 'session.started'
  | 'model.started'
  | 'model.finished'
  | 'tool.started'
  | 'tool.finished'
  | 'approval.required'
  | 'approval.resolved'
  | 'check.finished'
  | 'run.finished';

export interface AgentEventEnvelope {
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  sequence: number;
  type: AgentEventType;
  invocationId: string;
  sessionId: string | null;
  cwd: string;
  timestamp: string;
}

export type AgentRunStatus = 'completed' | 'blocked' | 'unverified' | 'needs-human' | 'failed' | 'interrupted';
export type AgentCompletionAuthority = 'none' | 'decideVerdict';
export type AgentCompletion =
  | { granted: false; authority: 'none' }
  | { granted: true; authority: 'decideVerdict' };
export type AgentModelStatus = 'completed' | 'halted' | 'failed' | 'timed-out' | 'interrupted';
export type AgentToolOutcome = 'committed' | 'denied' | 'failed' | 'unknown';
export type AgentCheckKind = 'canonical' | 'tamper' | 'worktree' | 'held-out';
export type AgentCheckStatus = 'passed' | 'failed' | 'unavailable';
export type AgentVerdict = 'verified' | 'checksOnly' | 'rejected' | 'couldNotVerify';

export type AgentEventPayloadV1 =
  | {
      type: 'session.started';
      root: AgentEventRoot;
      resumed: boolean;
      model?: string;
    }
  | {
      type: 'model.started';
      modelRunId: string;
      turn: number;
      messageCount: number;
      toolSchemaCount: number;
      requestId?: string;
    }
  | {
      type: 'model.finished';
      modelRunId: string;
      turn: number;
      status: AgentModelStatus;
      requestId?: string;
      finishReason?: FinishReason;
      rawFinishReason?: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: 'tool.started';
      modelRunId: string;
      toolCallId: string;
      toolName: string;
      requestId?: string;
      executionId?: string;
    }
  | {
      type: 'tool.finished';
      modelRunId: string;
      toolCallId: string;
      toolName: string;
      outcome: AgentToolOutcome;
      requestId?: string;
      executionId?: string;
    }
  | {
      type: 'approval.required';
      requestId: string;
      toolName: string;
      capability: ToolCapability;
      reason: string;
    }
  | {
      type: 'approval.resolved';
      requestId: string;
      toolName: string;
      decision: Approval | 'error';
    }
  | {
      type: 'check.finished';
      goalId: string;
      checkId: string;
      kind: AgentCheckKind;
      status: AgentCheckStatus;
      exitCode?: number;
    }
  | {
      type: 'run.finished';
      root: AgentEventRoot;
      status: AgentRunStatus;
      exitCode: number;
      verdict?: AgentVerdict;
      completion: AgentCompletion;
    };

export type AgentEventV1 = Omit<AgentEventEnvelope, 'type'> & AgentEventPayloadV1;

export interface AgentEventWriterOptions {
  invocationId: string;
  defaultSessionId: string | null;
  root: AgentEventRoot;
  cwd: string;
  writeLine: (line: string) => void;
  now?: () => string;
}

export interface RunFinishedInput {
  status: AgentRunStatus;
  exitCode: number;
  verdict?: AgentVerdict;
  completion: AgentCompletion;
}

/**
 * Project the internal EventBus into the narrow public JSONL contract. Projection is deliberately
 * lossy: model text/reasoning, tool arguments/results, and held-out material never enter the stream.
 */
export class AgentEventWriter {
  private sequence = 0;
  private closed = false;
  private readonly now: () => string;

  constructor(private readonly options: AgentEventWriterOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  sessionStarted(input: { sessionId: string; resumed: boolean; model?: string }): void {
    this.emit(input.sessionId, {
      type: 'session.started',
      root: this.options.root,
      resumed: input.resumed,
      ...(input.model === undefined ? {} : { model: input.model }),
    });
  }

  accept(event: Event): void {
    switch (event.type) {
      case 'model_started':
        this.emit(event.sessionId ?? this.options.defaultSessionId, {
          type: 'model.started',
          modelRunId: event.modelRunId,
          turn: event.turn,
          messageCount: event.messageCount,
          toolSchemaCount: event.toolSchemaCount,
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        });
        break;
      case 'model_finished':
        this.emit(event.sessionId ?? this.options.defaultSessionId, {
          type: 'model.finished',
          modelRunId: event.modelRunId,
          turn: event.turn,
          status: event.status,
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason }),
          ...(event.rawFinishReason === undefined ? {} : { rawFinishReason: event.rawFinishReason }),
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
        });
        break;
      case 'tool_execution_started':
        this.emit(event.sessionId ?? this.options.defaultSessionId, {
          type: 'tool.started',
          modelRunId: event.modelRunId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
        });
        break;
      case 'tool_execution_finished':
        this.emit(event.sessionId ?? this.options.defaultSessionId, {
          type: 'tool.finished',
          modelRunId: event.modelRunId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          outcome: event.outcome,
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
        });
        break;
      case 'approval_request':
        this.emit(event.sessionId ?? this.options.defaultSessionId, {
          type: 'approval.required',
          requestId: event.requestId,
          toolName: event.toolName,
          capability: event.capability,
          reason: event.reason,
        });
        break;
      case 'approval_result':
        this.emit(event.sessionId ?? this.options.defaultSessionId, {
          type: 'approval.resolved',
          requestId: event.requestId,
          toolName: event.toolName,
          decision: event.decision,
        });
        break;
      case 'check_finished':
        this.emit(event.sessionId ?? this.options.defaultSessionId, {
          type: 'check.finished',
          goalId: event.goalId,
          checkId: event.checkId,
          kind: event.kind,
          status: event.status,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        });
        break;
      default:
        break;
    }
  }

  runFinished(input: RunFinishedInput): void {
    assertCompletionAuthority(this.options.root, input);
    this.emit(this.options.defaultSessionId, {
      type: 'run.finished',
      root: this.options.root,
      status: input.status,
      exitCode: input.exitCode,
      ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
      completion: input.completion,
    });
    this.closed = true;
  }

  private emit(sessionId: string | null, payload: AgentEventPayloadV1): void {
    if (this.closed) throw new Error('agent-event stream is already closed');
    const record: AgentEventV1 = {
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      sequence: ++this.sequence,
      invocationId: this.options.invocationId,
      sessionId,
      cwd: this.options.cwd,
      timestamp: this.now(),
      ...payload,
    };
    const line = JSON.stringify(record);
    // JSON.stringify escapes these bytes inside strings. Assert the transport invariant anyway so a
    // future custom serializer cannot silently turn JSONL into terminal control or forged records.
    if (line.includes('\u001b') || line.includes('\r') || line.includes('\n')) {
      throw new Error('agent-event serialization emitted raw terminal control characters');
    }
    this.options.writeLine(line);
  }
}

function assertCompletionAuthority(root: AgentEventRoot, input: RunFinishedInput): void {
  const completionKeys = Object.keys(input.completion).sort();
  if (completionKeys.length !== 2 || completionKeys[0] !== 'authority' || completionKeys[1] !== 'granted') {
    throw new Error('run.finished completion shape is invalid');
  }
  if (!input.completion.granted) {
    if (input.completion.authority !== 'none') {
      throw new Error('run.finished completion authority is invalid');
    }
    return;
  }
  if (
    root !== 'goal'
    || input.completion.authority !== 'decideVerdict'
    || input.verdict !== 'verified'
    || input.status !== 'completed'
    || input.exitCode !== 0
  ) {
    throw new Error('run.finished completion authority is invalid');
  }
}
