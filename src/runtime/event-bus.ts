/**
 * EventBus — the internal broadcast station (knowledge base Part2 §8, plan §3.2).
 *
 * Everything that happens is emitted as a client-agnostic event; surfaces (CLI in
 * A4, GUI in E) only subscribe — they never reach into core. Wiring this on day 1
 * is what makes "add a GUI" become "add a subscriber", not "rewire the core".
 *
 * The public surface is typed to {@link Event} (not an open union) so subscribers
 * narrow on `event.type` and get checked payloads — that typed contract is the
 * whole point. Runtime forward-compatibility ("unknown type must not throw") is
 * preserved a different way: the bus never inspects `event.type`, it just delivers,
 * so an event type not yet in the canonical union flows through unharmed and a
 * subscriber handles it (or ignores it) in its `default` branch.
 */
import type { ToolCall, ToolResult } from '../core/types.js';
import type { FinishReason } from '../core/model/types.js';
import type { ToolCapability } from '../core/tools/types.js';
import type { Approval } from './permission/permission-gate.js';

/** The canonical event union (a subset for A phase; grows as milestones land). */
export type Event =
  | { type: 'message_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; out: ToolResult }
  | { type: 'state'; phase: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'final'; text: string }
  // Public headless lifecycle projection. These events contain identities and bounded status only;
  // prompts, reasoning, tool arguments/results, and held-out commands stay off the machine stream.
  | {
      type: 'model_started';
      sessionId?: string;
      modelRunId: string;
      requestId?: string;
      turn: number;
      messageCount: number;
      toolSchemaCount: number;
    }
  | {
      type: 'model_finished';
      sessionId?: string;
      modelRunId: string;
      requestId?: string;
      turn: number;
      status: 'completed' | 'halted' | 'failed' | 'timed-out' | 'interrupted';
      finishReason?: FinishReason;
      rawFinishReason?: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: 'tool_execution_started';
      sessionId?: string;
      modelRunId: string;
      requestId?: string;
      executionId?: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: 'tool_execution_finished';
      sessionId?: string;
      modelRunId: string;
      requestId?: string;
      executionId?: string;
      toolCallId: string;
      toolName: string;
      outcome: 'committed' | 'denied' | 'failed' | 'unknown';
    }
  | {
      type: 'check_finished';
      goalId: string;
      sessionId?: string;
      checkId: string;
      kind: 'canonical' | 'tamper' | 'worktree' | 'held-out';
      status: 'passed' | 'failed' | 'unavailable';
      exitCode?: number;
    }
  | {
      type: 'halt';
      reason:
        | 'maxTurns'
        | 'budget'
        | 'error'
        | 'truncated'
        | 'filtered'
        | 'paused'
        | 'refused'
        | 'unknown'
        | 'turnTimeout'
        | 'toolExecutionUnknown'
        | 'goalTimeout'
        | 'guardrail'
        | 'emergency-stop';
      /** Provider finish reason before normalization; present for abnormal model completions. */
      rawFinishReason?: string;
      /** Applied hard deadline; present for turn/goal timeout halts. */
      timeoutMs?: number;
    }
  // Phase D — goal autonomy. Inlined string unions (not imported from capabilities/goal) so the
  // runtime EventBus carries no back-dependency on the capabilities layer.
  | { type: 'verdict'; goalId: string; outcome: 'verified' | 'checksOnly' | 'rejected' | 'couldNotVerify'; rationale: string }
  | { type: 'goal_state'; goalId: string; state: 'active' | 'complete' | 'blocked' }
  // Read-only round/budget telemetry for GUI/status surfaces. These events are advisory and cannot
  // grant or replace completion authority.
  | {
      type: 'goal_round_start';
      goalId: string;
      round: number;
      maxRounds: number;
      totalTurns: number;
      totalTokens: number;
      maxTotalTurns?: number;
      maxTotalTokens?: number;
    }
  | {
      type: 'goal_round_end';
      goalId: string;
      round: number;
      turns: number;
      roundTokens: number;
      totalTurns: number;
      totalTokens: number;
      maxRounds: number;
      maxTotalTurns?: number;
      maxTotalTokens?: number;
      claimStatus?: 'complete' | 'blocked';
      verdict?: 'verified' | 'checksOnly' | 'rejected' | 'couldNotVerify';
      state: 'active' | 'complete' | 'blocked';
    }
  // Phase E — multi-goal Loop scheduling. The ONE machine-actionable moment an operator/GUI must act
  // on: the loop stopped, and why. Reason string inlined (no capabilities back-dependency, as above).
  | {
      type: 'loop_halt';
      loopId: string;
      reason:
        | 'queue-empty'
        | 'blocked-goals'
        | 'max-goals'
        | 'token-budget'
        | 'wall-clock'
        | 'emergency-stop'
        | 'consecutive-blocked'
        | 'verifier-health';
    }
  // Hooks slice-2 — a PostToolUse hook's stdout: surfaced for observability AND folded into the
  // conversation by run-agent so the model sees it next turn. Advisory (never alters a tool result).
  | { type: 'hook_output'; hook: 'PostToolUse'; toolName: string; output: string }
  // GUI/human-review prelude: approval events are observation/audit only. They do not alter the
  // PermissionGate outcome and cannot feed verifier reports or completion authority.
  | {
      type: 'approval_request';
      requestId: string;
      sessionId?: string;
      toolName: string;
      capability: ToolCapability;
      reason: string;
      detail: string;
      at: string;
    }
  | {
      type: 'approval_result';
      requestId: string;
      sessionId?: string;
      toolName: string;
      decision: Approval | 'error';
      error?: string;
      at: string;
    };

export type Subscriber = (event: Event) => void;

export interface EventBus {
  emit(event: Event): void;
  /** Returns an unsubscribe function for THIS registration. */
  subscribe(fn: Subscriber): () => void;
}

/**
 * In-memory EventBus. Subscribers receive every event in subscription order. A
 * subscriber that throws is isolated (its error is swallowed) so one bad listener
 * can't break the others or the emitting code path — mirrors kimi-code's "live
 * listener errors never affect the loop" (Part8 §2).
 */
export class InMemoryEventBus implements EventBus {
  private readonly subscribers = new Set<Subscriber>();
  /** Optional sink for swallowed subscriber errors (defaults to console.error). */
  private readonly onError: (err: unknown) => void;

  constructor(onError?: (err: unknown) => void) {
    this.onError = onError ?? ((err) => console.error('[EventBus] subscriber threw:', err));
  }

  emit(event: Event): void {
    // Snapshot so a subscriber that (un)subscribes during dispatch is well-defined.
    for (const fn of [...this.subscribers]) {
      try {
        fn(event);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    // Wrap so the SAME fn subscribed twice yields two independent registrations
    // (EventEmitter semantics, plan §3.2) and each unsubscribe removes only its own.
    const entry: Subscriber = (event) => fn(event);
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }
}
