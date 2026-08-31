/**
 * SubagentManager — spawns a child agent as a NARROWED, recursive run of the same loop (Phase C).
 *
 * The core insight: a subagent is not a new loop. It is `runAgent` again, on a child
 * {@link AgentContext} that is a pure narrowing of the parent's — fewer tools (parent ∩ requested),
 * a strictly smaller budget, an independent event bus, the SAME permission gate, the parent's abort
 * signal plus a whole-task deadline, and DELIBERATELY no session store. The manager holds the
 * stateful parts (remaining nesting depth, the parent resource snapshot); derive.ts computes the
 * narrowing.
 *
 * Four hard invariants on every child context (each has a guardrail trigger test):
 *  - **no store**: a child's internal messages must NOT append to the parent's JSONL (it would
 *    corrupt the transcript and break resume) — only the parent persists; the delegate tool's
 *    result (the child's summary) flows into the parent transcript naturally.
 *  - **gate present for side effects**: a side-effecting child without a gate would run write/bash
 *    ungated (run-agent.ts: no gate ⇒ tools run unchecked) — that is the single worst bypass, so
 *    such a spawn is refused fail-closed.
 *  - **independent bus**: the child's deltas/final must not bleed into the parent's rendered stream.
 *  - **bounded signal**: Ctrl-C on the parent and the task deadline must kill work inside the child.
 *
 * Blocking `spawn` (await the child to completion, return its `finalText` as a condensed summary) —
 * the coding-style choice; async fire-and-forget is a later product fork (blueprint §4).
 */
import type { Message } from '../../core/types.js';
import type { ModelProvider } from '../../core/model/types.js';
import type { ToolCapability, ToolDefinition, ToolRegistry } from '../../core/tools/types.js';
import type { ContextManager } from '../../core/context/context-manager.js';
import type { PermissionGate } from '../../runtime/permission/permission-gate.js';
import { type Budget } from '../../core/loop/decisions.js';
import { type AgentContext, type RunOutcome, runAgent } from '../../core/loop/run-agent.js';
import { InMemoryEventBus } from '../../runtime/event-bus.js';
import {
  deriveBudget,
  deriveCapabilities,
  deriveDepth,
  deriveTools,
  type ToolMeta,
} from './derive.js';
import { type AgentRole, findRole } from './roster.js';

/** One delegated task gets a single wall-clock budget across all of its model turns. */
const DEFAULT_SUBAGENT_WALL_CLOCK_MS = 120_000;

/** The agent loop runner. Injected so a test can capture the child {@link AgentContext} and assert
 *  the four hard invariants (no store, gate present, independent bus, signal passed through) without
 *  running a real model. Defaults to {@link runAgent}. */
export type RunAgent = (ctx: AgentContext) => Promise<RunOutcome>;

/** The outcome of one `spawn`. `summary` is the child's condensed final answer (or a reason it
 *  could not run). Mapped by the delegate tool (C3) into a {@link ToolResult} fed back to the parent. */
export interface SpawnResult {
  role: string;
  ok: boolean;
  summary: string;
  turns: number;
  /** Child execution crossed a side-effect boundary without a provable terminal state. */
  executionUnknown?: true;
}

/** Everything the manager needs, injected so it owns no globals (mirrors AgentContext). A nested
 *  delegate's manager is a clone of this with a narrowed registry/budget and a decremented depth
 *  (see {@link SubagentManager} buildChildRegistry), so every level derives strictly from the one
 *  above it — never from the root. */
export interface SubagentManagerDeps {
  /** Parent provider — the fallback model. Model routing is YAGNI until a 2nd endpoint exists. */
  provider: ModelProvider;
  /** Parent tool registry — the child's tools are a `subset` of this. */
  registry: ToolRegistry;
  /** The permission gate, REUSED by every child so write/bash inside a child still gets approved. */
  gate?: PermissionGate;
  /** Parent budget — the child's is strictly smaller (deriveBudget). */
  budget: Budget;
  roster: readonly AgentRole[];
  cwd: string;
  /** Optional context manager (shared; stateless across calls — it acts on the messages passed in). */
  context?: ContextManager;
  /** Remaining nesting levels this manager may still spawn. 0 ⇒ refuse (depth cap, R4). */
  remainingDepth: number;
  /** C3 injects this to bind a fresh `task` tool to a CHILD manager, so a nested subagent that may
   *  itself delegate gets a task tool whose depth is already decremented. Absent (C2) ⇒ children
   *  carry no delegate tool. */
  makeDelegateTool?: (manager: SubagentManager) => ToolDefinition;
  /** The delegate tool's name, so the inherited (parent-bound) copy is excluded before re-binding. */
  delegateToolName?: string;
  /** The loop runner, injected so a test can capture the child context; defaults to {@link runAgent}. */
  run?: RunAgent;
  /** Whole-task wall-clock deadline. Exposed only for focused tests/callers. */
  deadlineMs?: number;
}

export class SubagentManager {
  constructor(private readonly deps: SubagentManagerDeps) {}

  get remainingDepth(): number {
    return this.deps.remainingDepth;
  }

  /** The roles the main agent may delegate to (the delegate tool's description routes on this). */
  roster(): readonly AgentRole[] {
    return this.deps.roster;
  }

  /**
   * Spawn by role NAME (looked up in the roster), running it to completion and returning its
   * condensed summary. Refuses an unknown role; otherwise delegates to {@link spawnRole}, which
   * enforces the depth cap (R4) and the no-gate-for-side-effects guard (R2).
   */
  async spawn(roleName: string, task: string, signal?: AbortSignal): Promise<SpawnResult> {
    const role = findRole(this.deps.roster, roleName);
    if (!role) return fail(roleName, `unknown role '${roleName}'`);
    return this.spawnRole(role, task, signal);
  }

  /**
   * Spawn a given role OBJECT (rather than a roster name) — used by the review panel for preset
   * perspectives (e.g. the six hats) that need not live in the roster. Same narrowing and guardrails
   * as {@link spawn}.
   */
  async spawnRole(role: AgentRole, task: string, signal?: AbortSignal): Promise<SpawnResult> {
    if (this.deps.remainingDepth <= 0) {
      return fail(role.name, `depth cap reached — cannot spawn a deeper subagent`);
    }

    const parentMeta = this.toolMetas();
    const derivedCaps = deriveCapabilities(uniqueCapabilities(parentMeta), role.capability);
    const derivedNames = deriveTools(parentMeta, role.tools, derivedCaps);
    const childDepth = deriveDepth(this.deps.remainingDepth, role.maxDepth);
    const childBudget = deriveBudget(this.deps.budget, role.maxTurns);

    // R2: a child with any side-effecting tool MUST run behind a gate; refuse fail-closed otherwise.
    if (!this.deps.gate && hasSideEffect(parentMeta, derivedNames)) {
      return fail(role.name, `refusing to spawn a side-effecting subagent without a permission gate`);
    }

    const childRegistry = this.buildChildRegistry(derivedNames, childDepth, childBudget);
    const childBus = new InMemoryEventBus();
    const childMessages: Message[] = [
      { role: 'system', content: role.systemPrompt },
      { role: 'user', content: task },
    ];

    const run = this.deps.run ?? runAgent;
    const deadlineMs = resolveDeadlineMs(this.deps.deadlineMs);
    const deadline = new AbortController();
    const childSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const pending = run({
      model: this.providerFor(role),
      tools: childRegistry,
      bus: childBus, // independent bus — child events never reach the parent's rendered stream
      messages: childMessages,
      toolCtx: { cwd: this.deps.cwd },
      budget: childBudget, // strictly smaller than the parent (R5); also the basis a grandchild narrows from
      context: this.deps.context,
      gate: this.deps.gate, // REUSE the parent gate — write/bash inside the child still gets approved
      // store: deliberately omitted — a child must not append to the parent's session log (R3)
      signal: childSignal, // parent interruption + the whole-task deadline both cancel child work
    });
    void pending.catch(() => undefined);
    const timedOut = Symbol('subagent-timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => {
        resolve(timedOut);
        deadline.abort();
      }, deadlineMs);
    });
    try {
      const outcome = await Promise.race([pending, timeout]);
      if (outcome === timedOut) {
        return {
          ...fail(role.name, `subagent timed out after ${deadlineMs}ms`),
          ...(hasSideEffect(parentMeta, derivedNames) ? { executionUnknown: true as const } : {}),
        };
      }
      return summarize(outcome, role.name);
    } catch (err) {
      // A child loop throw may follow a side effect. Preserve that uncertainty through
      // the delegate tool so the parent task halts instead of treating it as recoverable text.
      return { ...fail(role.name, `subagent errored: ${message(err)}`), executionUnknown: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Parent tools as {name, capability}, skipping any without a declared capability. */
  private toolMetas(): ToolMeta[] {
    const metas: ToolMeta[] = [];
    for (const schema of this.deps.registry.schemasForModel()) {
      const capability = this.deps.registry.capabilityOf(schema.name);
      if (capability !== undefined) metas.push({ name: schema.name, capability });
    }
    return metas;
  }

  /**
   * The child's registry: the narrowed subset of the parent's tools. The inherited (parent-bound)
   * delegate tool is ALWAYS dropped first — keeping it would let a grandchild derive from the ROOT
   * registry/budget and escape the chain narrowing (capability + budget would reset to root). If the
   * child may itself delegate (childDepth > 0), a FRESH `task` is bound to a child manager scoped to
   * the child's OWN narrowed registry + budget + decremented depth, so every nesting level narrows
   * strictly from the level above it — never from the root.
   */
  private buildChildRegistry(names: string[], childDepth: number, childBudget: Budget): ToolRegistry {
    const { makeDelegateTool, delegateToolName } = this.deps;
    const ownNames = delegateToolName ? names.filter((n) => n !== delegateToolName) : names;
    const childRegistry = this.deps.registry.subset(ownNames);
    if (childDepth > 0 && makeDelegateTool && delegateToolName && names.includes(delegateToolName)) {
      const childManager = new SubagentManager({
        ...this.deps,
        registry: childRegistry, // the child's OWN narrowed registry (incl. the task registered next)
        budget: childBudget, // the child's OWN narrowed budget — a grandchild narrows from this, not root
        remainingDepth: childDepth,
      });
      childRegistry.register(makeDelegateTool(childManager));
    }
    return childRegistry;
  }

  /** The model for a role. Model routing is YAGNI (single provider) — `role.model` is metadata and
   *  falls back to the parent provider; `reasoningEffort` IS honored (cheap workers run low effort). */
  private providerFor(role: AgentRole): ModelProvider {
    return role.reasoningEffort
      ? this.deps.provider.withThinking(role.reasoningEffort)
      : this.deps.provider;
  }
}

function uniqueCapabilities(metas: readonly ToolMeta[]): ToolCapability[] {
  const seen = new Set<ToolCapability>();
  for (const m of metas) seen.add(m.capability);
  return [...seen];
}

function hasSideEffect(metas: readonly ToolMeta[], names: readonly string[]): boolean {
  const capOf = new Map(metas.map((m) => [m.name, m.capability] as const));
  return names.some((n) => {
    const c = capOf.get(n);
    return c === 'writes-files' || c === 'executes-code' || c === 'network';
  });
}

function summarize(outcome: RunOutcome, role: string): SpawnResult {
  if (outcome.finalText !== undefined) {
    return { role, ok: true, summary: outcome.finalText, turns: outcome.turns };
  }
  return {
    role,
    ok: false,
    summary: `subagent produced no answer (halted: ${outcome.halted ?? 'unknown'})`,
    turns: outcome.turns,
    ...(outcome.halted === 'toolExecutionUnknown' ? { executionUnknown: true as const } : {}),
  };
}

function fail(role: string, reason: string): SpawnResult {
  return { role, ok: false, summary: reason, turns: 0 };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveDeadlineMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SUBAGENT_WALL_CLOCK_MS;
  return Math.max(0, Math.floor(value));
}
