import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { readTool } from '../../../src/core/tools/builtins.js';
import {
  DefaultPermissionGate,
  type Approval,
  type Approver,
} from '../../../src/runtime/permission/permission-gate.js';
import {
  SIX_HATS,
  SubagentManager,
  runPanel,
  type RunAgent,
} from '../../../src/capabilities/subagents/index.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import type { Message, ToolCall } from '../../../src/core/types.js';

const CAP = {
  maxContextTokens: 1000,
  maxOutputTokens: 100,
  thinking: false,
  toolUse: true,
  imageIn: false,
  videoIn: false,
};

function dummyProvider(): ModelProvider {
  const provider: ModelProvider = {
    capability: CAP,
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield* []; // never iterated — these tests inject a fake runner
      return {
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

/** A reviewer model that reads data.txt on its first turn, then writes a review — decided from the
 *  conversation (stateless), so parallel children don't collide on a shared counter. */
function reviewerModel(): ModelProvider {
  const provider: ModelProvider = {
    capability: CAP,
    async *call(messages: Message[]): AsyncGenerator<ModelDelta, ModelResult> {
      const hasToolResult = messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        const tc: ToolCall = { id: 'r1', name: 'read', arguments: JSON.stringify({ path: 'data.txt' }) };
        return {
          text: '',
          toolCalls: [tc],
          usage: { inputTokens: 10, outputTokens: 5 },
          finishReason: 'tool_calls',
          rawFinishReason: 'tool_calls',
        };
      }
      yield { type: 'text', text: 'reviewed from my hat' };
      return {
        text: 'reviewed from my hat',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
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

/** A fake runner that records the peak number of concurrently in-flight reviewers. */
function countingRun(): { run: RunAgent; peak: () => number } {
  let active = 0;
  let peak = 0;
  const run: RunAgent = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((r) => setImmediate(r)); // let other workers start before we decrement
    active--;
    return { finalText: 'reviewed', turns: 1 };
  };
  return { run, peak: () => peak };
}

function makeManager(opts: {
  provider?: ModelProvider;
  registry?: InMemoryToolRegistry;
  gate?: DefaultPermissionGate;
  run?: RunAgent;
  cwd?: string;
} = {}): SubagentManager {
  return new SubagentManager({
    provider: opts.provider ?? dummyProvider(),
    registry: opts.registry ?? new InMemoryToolRegistry(),
    gate: opts.gate ?? new DefaultPermissionGate({}),
    budget: { maxTurns: 8 },
    roster: [],
    cwd: opts.cwd ?? process.cwd(),
    remainingDepth: 2,
    run: opts.run,
  });
}

describe('SIX_HATS preset', () => {
  it('is six distinct read-only perspectives', () => {
    expect(SIX_HATS).toHaveLength(6);
    expect(new Set(SIX_HATS.map((h) => h.name)).size).toBe(6);
    expect(SIX_HATS.every((h) => h.capability?.length === 1 && h.capability[0] === 'read-only')).toBe(
      true,
    );
  });
});

describe('runPanel', () => {
  it('returns one review per hat, in order', async () => {
    const mgr = makeManager({ run: async () => ({ finalText: 'reviewed', turns: 1 }) });
    const reviews = await runPanel(mgr, SIX_HATS, 'some artifact');
    expect(reviews).toHaveLength(6);
    expect(reviews.map((r) => r.hat)).toEqual(SIX_HATS.map((h) => h.name));
    expect(reviews.every((r) => r.ok && r.review === 'reviewed')).toBe(true);
  });

  it('caps concurrency at maxConcurrency (but still runs in parallel)', async () => {
    const c = countingRun();
    const mgr = makeManager({ run: c.run });
    await runPanel(mgr, SIX_HATS, 'artifact', { maxConcurrency: 2 });
    expect(c.peak()).toBe(2); // exactly the cap — never more, and genuinely parallel (> 1)
  });

  it('runs all hats at once when the cap is high enough', async () => {
    const c = countingRun();
    const mgr = makeManager({ run: c.run });
    await runPanel(mgr, SIX_HATS.slice(0, 3), 'artifact', { maxConcurrency: 10 });
    expect(c.peak()).toBe(3);
  });
});

describe('R7: a parallel read-only panel never invokes the approver', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-panel-'));
    await writeFile(join(dir, 'data.txt'), 'the artifact body', 'utf8');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('read-only reviewers (even using read) never reach the ask lane → no approval contention', async () => {
    const a = fixedApprover('deny'); // would deny if it were ever consulted
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const registry = new InMemoryToolRegistry();
    registry.register(readTool);
    const mgr = makeManager({ provider: reviewerModel(), registry, gate, cwd: dir });

    const reviews = await runPanel(mgr, SIX_HATS.slice(0, 3), 'artifact to review');

    expect(a.asks()).toBe(0); // read-only is auto-allowed; parallel reviewers don't contend on approval
    expect(reviews).toHaveLength(3);
    expect(reviews.every((r) => r.ok && r.review.includes('reviewed'))).toBe(true);
  });
});
