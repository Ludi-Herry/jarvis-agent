/**
 * EventBus — the internal broadcast station (knowledge base Part2 §8, plan §3.2).
 *
 * Everything that happens is emitted as a client-agnostic event; surfaces (CLI in
 * A4, GUI in E) only subscribe — they never reach into core. Wiring this on day 1
 * is what makes "add a GUI" become "add a subscriber", not "rewire the core".
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
  | { type: 'halt'; reason: 'maxTurns' | 'budget' | 'error' };

/** Any event the bus will carry. The open variant is the `unknown` fallback: a
 *  not-yet-canonical event type still flows through without crashing the bus. */
export type AnyEvent = Event | { type: string; [key: string]: unknown };

export type Subscriber = (event: AnyEvent) => void;

export interface EventBus {
  emit(event: AnyEvent): void;
  /** Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void;
}

/**
 * In-memory EventBus. Subscribers receive every event in subscription order; an
 * unknown event type is delivered, not rejected. A subscriber that throws is
 * isolated (its error is swallowed) so one bad listener can't break the others or
 * the emitting code path — mirrors kimi-code's "live listener errors never affect
 * the loop" (Part8 §2).
 */
export class InMemoryEventBus implements EventBus {
  private readonly subscribers = new Set<Subscriber>();
  /** Optional sink for swallowed subscriber errors (defaults to console.error). */
  private readonly onError: (err: unknown) => void;

  constructor(onError?: (err: unknown) => void) {
    this.onError = onError ?? ((err) => console.error('[EventBus] subscriber threw:', err));
  }

  emit(event: AnyEvent): void {
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
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}
