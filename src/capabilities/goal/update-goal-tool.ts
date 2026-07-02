/**
 * update-goal-tool — the builder's `update_goal` tool (Phase D; blueprint §9, Kun范式).
 *
 * The FIRST line of defense (the second is the deterministic two legs): anti-reward-hacking is
 * written into the tool DESCRIPTION itself — "don't mark complete just because you want to stop; the
 * harness will independently re-run the checks." The enum exposes only `complete | blocked` (the
 * model can't pause/resume/rebudget itself; those are system-controlled).
 *
 * It does NOT terminate the goal. It records the builder's claim into a shared {@link ClaimSlot}
 * (the same closure-binding范式 as createDelegateTool) that the GoalLoop reads after the round, then
 * verifies independently. `capability: 'read-only'` — the tool itself has no project side effect
 * (every real effect happens through the builder's other tools, still gated).
 */
import { z } from 'zod';
import type { ToolDefinition } from '../../core/tools/types.js';
import type { GoalClaim } from './goal.js';

export const UPDATE_GOAL_TOOL_NAME = 'update_goal';

/** A mutable holder the GoalLoop reads after each builder round (reset before each round). */
export interface ClaimSlot {
  claim?: GoalClaim;
}

/** Read AND clear the pending claim. The explicit return type lets a caller narrow cleanly — TS
 *  can't see the tool's closure side effect on `slot.claim` across an await, so reading the property
 *  directly narrows to `never`; a typed function return does not. */
export function takeClaim(slot: ClaimSlot): GoalClaim | undefined {
  const claim = slot.claim;
  slot.claim = undefined;
  return claim;
}

export function createUpdateGoalTool(
  slot: ClaimSlot,
): ToolDefinition<{ status: 'complete' | 'blocked'; verification?: string }> {
  return {
    name: UPDATE_GOAL_TOOL_NAME,
    description: [
      'Update the goal status. Set `complete` ONLY when the objective is genuinely achieved and no',
      'required work remains; put in `verification` a note of what you checked. Do NOT mark complete',
      'merely because the budget is nearly exhausted or you want to stop — the harness will',
      'INDEPENDENTLY re-run the project checks, scan for test tampering, and compare worktree status; it will reject a false',
      'claim. Set `blocked` if you are genuinely stuck and need a human. After calling this, STOP and',
      'end your turn so the harness can verify. You cannot pause, resume, or change the budget.',
    ].join(' '),
    capability: 'read-only',
    inputSchema: z.object({
      status: z.enum(['complete', 'blocked']),
      verification: z
        .string()
        .optional()
        .describe('What you ran/checked — a HINT to the harness only; it is not trusted to decide the verdict.'),
    }),
    run: async ({ status, verification }) => {
      slot.claim = { status, ...(verification !== undefined ? { verification } : {}) };
      return {
        content:
          status === 'complete'
            ? 'Completion claim recorded. The harness will now INDEPENDENTLY verify (re-run checks + tamper scan + worktree status audit). End your turn.'
            : 'Blocked recorded; the goal will be handed to a human. End your turn.',
      };
    },
  };
}
