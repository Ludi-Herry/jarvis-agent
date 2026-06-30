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

/** The canonical event union (a subset for A phase; grows as milestones land). */
export type Event =
  | { type: 'message_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; out: ToolResult }
  | { type: 'state'; phase: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'final'; text: string }
  | { type: 'halt'; reason: 'maxTurns' | 'budget' | 'error' | 'truncated' | 'filtered' | 'guardrail' }
  // Phase D — goal autonomy. Inlined string unions (not imported from capabilities/goal) so the
  // runtime EventBus carries no back-dependency on the capabilities layer.
  | { type: 'verdict'; goalId: string; outcome: 'verified' | 'rejected' | 'couldNotVerify'; rationale: string }
  | { type: 'goal_state'; goalId: string; state: 'active' | 'complete' | 'blocked' }
  // Phase E — multi-goal Loop scheduling. The ONE machine-actionable moment an operator/GUI must act
  // on: the loop stopped, and why. Reason string inlined (no capabilities back-dependency, as above).
  | {
      type: 'loop_halt';
      loopId: string;
      reason: 'queue-empty' | 'max-goals' | 'token-budget' | 'wall-clock' | 'consecutive-blocked' | 'verifier-health';
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
