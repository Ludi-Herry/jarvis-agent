/**
 * Loop barrel — public face of `src/core/loop`.
 *
 * The CLI (A4) and the a2-demo drive the agent through {@link runAgent}; the pure decision
 * functions stay exported so they're reusable and directly testable (plan §3.4).
 */
export { runAgent } from './run-agent.js';
export type { AgentContext, RunOutcome } from './run-agent.js';
export { decideStop, decideCompact, withinBudget, COMPACT_THRESHOLD } from './decisions.js';
export type { Budget } from './decisions.js';
