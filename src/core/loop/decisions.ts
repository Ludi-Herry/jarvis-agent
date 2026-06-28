/**
 * AgentLoop decision points — pure, stateless, individually unit-testable (plan §3.4/§5.5).
 *
 * The loop (run-agent.ts) is a stateful host with side effects; the JUDGMENTS it makes
 * each turn — "should we stop?", "are we still within budget?", "is the context full
 * enough to compact?" — are pulled out here as pure functions. That keeps each decision
 * provable in isolation (including the guardrail's trigger path) instead of buried in the
 * loop where the only way to exercise it is to run the whole machine.
 */
import type { ModelResult, Usage } from '../model/types.js';

/** The loop's hard turn ceiling — the guardrail that stops a model stuck calling tools
 *  forever from burning the budget. Token/cost budgets join this struct in later phases. */
export interface Budget {
  maxTurns: number;
}

/** Compact when the prompt already fills this fraction of the context window. 0.83 sits in
 *  the plan's 80–85% band (§3.4) and matches kimi-code's headroom. */
export const COMPACT_THRESHOLD = 0.83;

/**
 * Decide whether the loop stops after a model turn — and, if so, whether it stopped on a
 * natural answer or an abnormal halt.
 *
 * A turn WITH tool calls always continues: there's something to execute and feed back. A turn
 * with NO tool calls is terminal, but the finishReason decides the meaning. A clean stop is the
 * `final` answer; a `truncated` turn (hit the max-output-token ceiling) or a `filtered` turn
 * (content filter) produced an incomplete or void reply that must NOT be mistaken for the answer
 * — it `halt`s so the caller surfaces "no proper answer" instead of trusting a half-formed string.
 *
 * Scope note: a truncated turn that STILL carries tool calls keeps going (the path above), because
 * a torn tool-call argument is caught downstream by schema validation — a recoverable tool error,
 * not a silent bad answer. So the finishReason check only governs the no-tool terminal path.
 */
export type StopDecision =
  | { done: false }
  | { done: true; reason: 'final' }
  | { done: true; reason: 'halt'; cause: 'truncated' | 'filtered' };

export function decideStop(res: ModelResult): StopDecision {
  if (res.toolCalls.length > 0) return { done: false };
  if (res.finishReason === 'truncated' || res.finishReason === 'filtered') {
    return { done: true, reason: 'halt', cause: res.finishReason };
  }
  return { done: true, reason: 'final' };
}

/** True while the loop may run another turn. `turn` is 0-based, so with `maxTurns: 3` it
 *  permits turns 0,1,2 and returns false at turn 3 — the point the loop emits `halt`. */
export function withinBudget(turn: number, budget: Budget): boolean {
  return turn < budget.maxTurns;
}

/**
 * True when the prompt is large enough (≥ {@link COMPACT_THRESHOLD} of `window`) that the
 * next turn risks overflow and the context should be compacted first. Pure here in A2;
 * the ContextManager that ACTS on it lands in A3 (plan §3.5). A non-positive window
 * (unknown) never triggers, so a missing window can't force a bogus compaction.
 */
export function decideCompact(usage: Usage, window: number): boolean {
  if (window <= 0) return false;
  return usage.inputTokens / window >= COMPACT_THRESHOLD;
}
