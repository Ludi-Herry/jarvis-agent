/**
 * derive — the construction-time guardrail for subagents (Phase C, plan R1/R4/R5).
 *
 * A subagent must NEVER be able to do more than its parent. Rather than detect a runaway after the
 * fact, we make over-reach UNREPRESENTABLE: a child's capabilities / tools / depth / budget are a
 * pure narrowing of the parent's, computed here. Every function returns a subset (or a strictly
 * smaller number); the `never_escalates` tests pin that no requested value can widen the result.
 *
 * Pure and side-effect-free (AGENTS.md: decision points are pure functions + unit tests). The
 * stateful SubagentManager (subagent-manager.ts) holds the depth/concurrency counters; this module
 * only computes the narrowing it applies when constructing a child context.
 */
import type { ToolCapability } from '../../core/tools/types.js';
import type { Budget } from '../../core/loop/decisions.js';

/** A parent tool reduced to what the narrowing needs: its name and its single effect class. */
export interface ToolMeta {
  name: string;
  capability: ToolCapability;
}

/** Least-privilege default when a role declares no capability: read-only only. A role that needs
 *  to write or run commands must say so explicitly, so silence can never grant a side effect. */
const DEFAULT_REQUESTED: readonly ToolCapability[] = ['read-only'];

/**
 * Child capabilities = parent ∩ requested, in the parent's order. A role that requests nothing
 * defaults to read-only (least privilege). A requested capability the parent lacks is dropped, so
 * the result is ALWAYS a subset of the parent — a child can never gain an effect class its parent
 * doesn't have.
 */
export function deriveCapabilities(
  parent: readonly ToolCapability[],
  requested?: readonly ToolCapability[],
): ToolCapability[] {
  const req = requested && requested.length > 0 ? requested : DEFAULT_REQUESTED;
  const seen = new Set<ToolCapability>();
  const out: ToolCapability[] = [];
  for (const cap of parent) {
    if (req.includes(cap) && !seen.has(cap)) {
      seen.add(cap);
      out.push(cap);
    }
  }
  return out;
}

/**
 * Child tools = parent tools whose effect class is in `derivedCaps` AND (if the role named a tool
 * subset) whose name was requested. The capability filter is the real R1 guard: even if a role
 * lists `bash` in its `tools`, a child narrowed to read-only never receives it, because bash's
 * `executes-code` isn't in the derived capability set. A tool the parent doesn't have, or whose
 * effect class isn't in the derived set, is dropped.
 */
export function deriveTools(
  parentTools: readonly ToolMeta[],
  requestedNames: readonly string[] | undefined,
  derivedCaps: readonly ToolCapability[],
): string[] {
  return parentTools
    .filter((t) => derivedCaps.includes(t.capability))
    .filter((t) => requestedNames === undefined || requestedNames.includes(t.name))
    .map((t) => t.name);
}

/**
 * Child remaining-depth = min(requested, parent − 1), floored at 0. Each spawn level strictly
 * decreases the budget for further nesting, so a cycle (roleA→roleB→roleA) terminates: at remaining
 * depth 0 the manager refuses to spawn. A role may request a SMALLER depth but never a larger one.
 */
export function deriveDepth(parentRemaining: number, requested?: number): number {
  const childMax = Math.max(0, parentRemaining - 1);
  if (requested === undefined) return childMax;
  return Math.min(Math.max(0, requested), childMax);
}

/**
 * Child budget = a STRICTLY smaller turn ceiling than the parent (R5: N children must not each run
 * a full parent budget). Default is half the parent (floored, ≥1); a role may request fewer but is
 * capped at parent − 1, so the child is always smaller whenever the parent has room to nest
 * (maxTurns ≥ 2). A degenerate parent (maxTurns ≤ 1) can't meaningfully nest anyway.
 */
export function deriveBudget(parent: Budget, requested?: number): Budget {
  const cap = Math.max(1, parent.maxTurns - 1);
  const want =
    requested !== undefined ? Math.max(1, requested) : Math.max(1, Math.floor(parent.maxTurns / 2));
  return { maxTurns: Math.min(want, cap) };
}
