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
 * Stop the loop when the model asked for no tools — that turn's text is the final answer.
 * The presence of tool calls (not the finishReason string) is the operational signal:
 * if there's nothing to execute, there's nothing to feed back, so the turn is terminal.
 */
export function decideStop(res: ModelResult): { done: boolean; reason?: 'final' } {
  if (res.toolCalls.length === 0) return { done: true, reason: 'final' };
  return { done: false };
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
