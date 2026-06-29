/**
 * delegate-tool — exposes SubagentManager.spawn to the model as the `task` tool (Phase C, C3).
 *
 * This is the capability-dispatch axis entry point: the main agent calls `task(role, task)` to hand
 * a self-contained subtask to a specialist subagent and gets back a condensed summary. The tool is
 * `read-only` — it produces no direct side effect (every effect happens INSIDE the child, gated by
 * the same PermissionGate), so the main agent isn't prompted to approve the delegation itself; cost
 * is bounded by the depth / budget / (panel) concurrency guardrails, not the gate.
 *
 * It is an ordinary registered tool, so the parent loop already emits tool_call/tool_result for it —
 * the UI renders `⏺ task(role=…)` + `↳ summary` with no new event type (plan decision 1).
 */
import { z } from 'zod';
import type { ToolDefinition } from '../../core/tools/types.js';
import { rosterCatalog } from './roster.js';
import type { SubagentManager } from './subagent-manager.js';

/** The delegate tool's name — shared so the manager can exclude the inherited copy when re-binding
 *  a child's `task` to the child manager (depth decremented). */
export const TASK_TOOL_NAME = 'task';

/** Build the `task` tool bound to `manager`. The description lists the roster so the model routes by
 *  role name. A child manager gets its own bound copy via SubagentManagerDeps.makeDelegateTool. */
export function createDelegateTool(
  manager: SubagentManager,
): ToolDefinition<{ role: string; task: string }> {
  const catalog = rosterCatalog(manager.roster());
  const description = [
    'Delegate a self-contained subtask to a specialist subagent; returns a condensed summary.',
    'Use it when a subtask is outside your strengths, or would produce a lot of intermediate work',
    'you only need summarized. Pick one role by name:',
    catalog === '' ? '(no roles configured)' : catalog,
  ].join('\n');

  return {
    name: TASK_TOOL_NAME,
    description,
    capability: 'read-only',
    inputSchema: z.object({
      role: z.string().describe('The role to delegate to — one of the listed role names.'),
      task: z.string().describe('A self-contained description of the subtask for the subagent.'),
    }),
    run: async ({ role, task }, ctx) => {
      // Pass the turn's abort signal so Ctrl-C on the parent kills work inside the child (R8).
      const result = await manager.spawn(role, task, ctx.signal);
      // The child's summary becomes the tool result. A refused/halted spawn comes back as `error`
      // so the parent model sees it failed and can change course (same shape as a tool failure).
      return result.ok ? { content: result.summary } : { content: '', error: result.summary };
    },
  };
}
