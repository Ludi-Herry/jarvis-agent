import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { readTool, writeTool } from '../../../src/core/tools/builtins.js';
import { createBashTool } from '../../../src/core/tools/bash.js';
import { InMemoryEventBus } from '../../../src/runtime/event-bus.js';
import {
  DefaultPermissionGate,
  type Approval,
  type Approver,
} from '../../../src/runtime/permission/permission-gate.js';
import {
  SubagentManager,
  createDelegateTool,
  TASK_TOOL_NAME,
  type RunAgent,
} from '../../../src/capabilities/subagents/index.js';
import type { AgentRole } from '../../../src/capabilities/subagents/roster.js';
import type { AgentContext, RunOutcome } from '../../../src/core/loop/run-agent.js';
import type { FinishReason, ModelDelta, ModelProvider, ModelResult, Usage } from '../../../src/core/model/types.js';
import type { ToolCall } from '../../../src/core/types.js';

// --- test doubles (mirroring run-agent.test.ts / permission-gate.test.ts) ---

interface Step {
  text?: string;
  toolCalls?: ToolCall[];
  finishReason?: FinishReason;
  usage?: Usage;
}
function scriptedModel(steps: Step[]): ModelProvider {
  let count = 0;
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      const step = steps[Math.min(count, steps.length - 1)];
      count++;
      const text = step.text ?? '';
      if (text.length > 0) yield { type: 'text', text };
      const toolCalls = step.toolCalls ?? [];
      return {
        text,
        toolCalls,
        usage: step.usage ?? { inputTokens: 10, outputTokens: 5 },
        finishReason: step.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'completed'),
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

/** A fake loop runner that captures the child context and counts invocations — lets us assert the
 *  four hard invariants without running a real model. */
function capturingRun(outcome?: Partial<RunOutcome>): {
  run: RunAgent;
  ctx: () => AgentContext | undefined;
  calls: () => number;
} {
  let captured: AgentContext | undefined;
  let calls = 0;
  const run: RunAgent = async (c) => {
    captured = c;
    calls++;
    return { finalText: 'captured', turns: 1, ...outcome };
  };
  return { run, ctx: () => captured, calls: () => calls };
}

function fixedApprover(verdict: Approval): { approver: Approver; asks: () => number } {
  let asks = 0;
  return {
    approver: async () => {
      asks++;
      return verdict;
    },
    asks: () => asks,
  };
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) };
}

const ROSTER: AgentRole[] = [
  { name: 'reader', description: 'reads files', systemPrompt: 'You read.', capability: ['read-only'] },
  {
    name: 'writer',
    description: 'writes files',
    systemPrompt: 'You write.',
    capability: ['read-only', 'writes-files'],
  },
];

function defaultRegistry(): InMemoryToolRegistry {
  const r = new InMemoryToolRegistry();
  r.register(readTool);
  r.register(writeTool);
  r.register(createBashTool());
  return r;
}

function makeManager(opts: {
  provider?: ModelProvider;
  registry?: InMemoryToolRegistry;
  gate?: DefaultPermissionGate;
  budget?: { maxTurns: number };
  roster?: AgentRole[];
  cwd?: string;
  remainingDepth?: number;
  run?: RunAgent;
} = {}): SubagentManager {
  return new SubagentManager({
    provider: opts.provider ?? scriptedModel([{ text: 'done' }]),
    registry: opts.registry ?? defaultRegistry(),
    gate: opts.gate,
    budget: opts.budget ?? { maxTurns: 8 },
    roster: opts.roster ?? ROSTER,
    cwd: opts.cwd ?? process.cwd(),
    remainingDepth: opts.remainingDepth ?? 2,
    run: opts.run,
  });
}

describe('InMemoryToolRegistry.subset', () => {
  it('exposes only the named tools (reusing definitions); unknown names are skipped', () => {
    const sub = defaultRegistry().subset(['read', 'nonexistent']);
    expect(sub.schemasForModel().map((s) => s.name)).toEqual(['read']);
    expect(sub.capabilityOf('read')).toBe('read-only');
    expect(sub.capabilityOf('write')).toBeUndefined(); // not in the subset
  });
});

describe('SubagentManager.spawn — closed loop (real runAgent)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-subagent-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a read-only child to completion and returns its finalText as the summary', async () => {
    await writeFile(join(dir, 'note.txt'), 'the answer is 42', 'utf8');
    const provider = scriptedModel([
      { text: 'reading', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"note.txt"}' }] },
      { text: 'The note says the answer is 42.' },
    ]);
    const mgr = makeManager({ provider, gate: new DefaultPermissionGate({}), cwd: dir });
    const res = await mgr.spawn('reader', 'what does note.txt say?');
    expect(res).toMatchObject({
      role: 'reader',
      ok: true,
      summary: 'The note says the answer is 42.',
    });
  });
});

describe('SubagentManager.spawn — four hard child-context invariants', () => {
  it('child ctx: no store, gate reused, independent bus, signal passed through', async () => {
    const cap = capturingRun();
    const gate = new DefaultPermissionGate({});
    const ac = new AbortController();
    const mgr = makeManager({ gate, run: cap.run });

    await mgr.spawn('reader', 'go', ac.signal);
    const ctx = cap.ctx();
    expect(ctx).toBeDefined();
    expect(ctx?.store).toBeUndefined(); // R3: a child never appends to the parent's session log
    expect(ctx?.gate).toBe(gate); // the SAME gate is reused (R2/R6)
    expect(ctx?.signal).toBe(ac.signal); // R8: parent abort reaches the child
    expect(ctx?.bus).toBeInstanceOf(InMemoryEventBus); // independent bus, not the parent's stream
  });

  it('two spawns get distinct buses (no shared rendered stream)', async () => {
    const cap = capturingRun();
    const mgr = makeManager({ gate: new DefaultPermissionGate({}), run: cap.run });
    await mgr.spawn('reader', 'a');
    const bus1 = cap.ctx()?.bus;
    await mgr.spawn('reader', 'b');
    const bus2 = cap.ctx()?.bus;
    expect(bus1).toBeDefined();
    expect(bus1).not.toBe(bus2);
  });

  it('R5: the child budget is strictly smaller than the parent', async () => {
    const cap = capturingRun();
    const mgr = makeManager({ gate: new DefaultPermissionGate({}), budget: { maxTurns: 8 }, run: cap.run });
    await mgr.spawn('reader', 'go');
    expect(cap.ctx()?.budget.maxTurns).toBeLessThan(8);
  });
});

describe('SubagentManager.spawn — guardrails (refuse without running)', () => {
  it('R2: refuses a side-effecting child when no gate is present', async () => {
    const cap = capturingRun();
    const mgr = makeManager({ run: cap.run }); // no gate
    const res = await mgr.spawn('writer', 'write something');
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('without a permission gate');
    expect(cap.calls()).toBe(0); // never ran
  });

  it('a read-only child needs no gate (read-only is auto-allowed) and runs', async () => {
    const cap = capturingRun();
    const mgr = makeManager({ run: cap.run }); // no gate
    const res = await mgr.spawn('reader', 'read');
    expect(res.ok).toBe(true);
    expect(cap.calls()).toBe(1);
  });

  it('R4: refuses to spawn when the depth cap is reached', async () => {
    const cap = capturingRun();
    const mgr = makeManager({ gate: new DefaultPermissionGate({}), remainingDepth: 0, run: cap.run });
    const res = await mgr.spawn('reader', 'go');
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('depth cap');
    expect(cap.calls()).toBe(0);
  });

  it('refuses an unknown role', async () => {
    const cap = capturingRun();
    const mgr = makeManager({ gate: new DefaultPermissionGate({}), run: cap.run });
    const res = await mgr.spawn('ghost', 'go');
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("unknown role 'ghost'");
    expect(cap.calls()).toBe(0);
  });
});

describe('R6: a parent session-grant for write carries into a child (pinned as a contract)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-subagent-r6-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('after the parent allow-sessions write, the child write does NOT ask again', async () => {
    const a = fixedApprover('allow-session');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    // Parent seeds the session grant for write.
    await gate.check(call('write', { path: 'seed.txt', content: 'x' }), 'writes-files');
    expect(a.asks()).toBe(1);

    const provider = scriptedModel([
      {
        text: 'writing',
        toolCalls: [{ id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'child.txt', content: 'hi' }) }],
      },
      { text: 'done' },
    ]);
    const mgr = makeManager({ provider, gate, cwd: dir });
    const res = await mgr.spawn('writer', 'write child.txt');

    expect(res.ok).toBe(true);
    expect(a.asks()).toBe(1); // the child write reused the session grant — never asked again (the contract)
    expect(await readFile(join(dir, 'child.txt'), 'utf8')).toBe('hi');
  });
});

describe('nested delegation narrows from the child, not the root (HIGH-1 fix)', () => {
  function wired(remainingDepth: number, run: RunAgent): SubagentManager {
    const registry = defaultRegistry(); // read / write / bash
    const manager = new SubagentManager({
      provider: scriptedModel([{ text: 'x' }]),
      registry,
      gate: new DefaultPermissionGate({}),
      budget: { maxTurns: 24 },
      roster: ROSTER,
      cwd: process.cwd(),
      remainingDepth,
      run,
      makeDelegateTool: (m) => createDelegateTool(m),
      delegateToolName: TASK_TOOL_NAME,
    });
    registry.register(createDelegateTool(manager));
    return manager;
  }

  it('a read-only child cannot delegate out write/bash; budget narrows from the child', async () => {
    const cap = capturingRun();
    const manager = wired(3, cap.run);

    await manager.spawn('reader', 'go');
    const child = cap.ctx();
    const childTools = child?.tools.schemasForModel().map((s) => s.name) ?? [];
    expect(childTools).toContain('task'); // depth 3→2 > 0: the child may delegate
    expect(childTools).not.toContain('write'); // read-only child: no write/bash
    expect(childTools).not.toContain('bash');
    expect(child?.budget.maxTurns).toBe(12); // 24 → 12

    // The child delegates to `writer` via ITS task tool. Pre-fix, the nested task was bound to a
    // manager that still saw the ROOT registry/budget, so the grandchild could regain write and the
    // budget reset. Now the grandchild narrows from the (read-only) child.
    await child?.tools.run(
      { id: 'g1', name: 'task', arguments: JSON.stringify({ role: 'writer', task: 'write x' }) },
      { cwd: process.cwd() },
    );
    const grand = cap.ctx();
    const grandTools = grand?.tools.schemasForModel().map((s) => s.name) ?? [];
    expect(grandTools).not.toContain('write'); // cannot gain write the read-only child never had
    expect(grand?.budget.maxTurns).toBe(6); // 12 → 6: narrows from the child, not the root's 24→12
  });

  it('a depth-exhausted child carries no task tool', async () => {
    const cap = capturingRun();
    const manager = wired(1, cap.run); // child gets remainingDepth 0
    await manager.spawn('reader', 'go');
    const childTools = cap.ctx()?.tools.schemasForModel().map((s) => s.name) ?? [];
    expect(childTools).not.toContain('task');
  });
});
