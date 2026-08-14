import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { writeTool } from '../../../src/core/tools/builtins.js';
import { runAgent } from '../../../src/core/loop/run-agent.js';
import { InMemoryEventBus } from '../../../src/runtime/event-bus.js';
import {
  DefaultPermissionGate,
  type Approval,
  type Approver,
} from '../../../src/runtime/permission/permission-gate.js';
import {
  SubagentManager,
  createDelegateTool,
  delegateToolSchema,
  TASK_TOOL_NAME,
  type RunAgent,
} from '../../../src/capabilities/subagents/index.js';
import type { AgentRole } from '../../../src/capabilities/subagents/roster.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import type { Message, ToolCall } from '../../../src/core/types.js';
import {
  FileSessionStore,
  createSessionComposition,
  loadSession,
} from '../../../src/runtime/session/session-store.js';

const ROSTER: AgentRole[] = [
  { name: 'reader', description: 'reads files', systemPrompt: 'You read.', capability: ['read-only'] },
  {
    name: 'writer',
    description: 'writes files',
    systemPrompt: 'CHILD: you write what you are asked to.',
    capability: ['read-only', 'writes-files'],
  },
];

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

function capturingRun(finalText: string): RunAgent {
  return async () => ({ finalText, turns: 1 });
}

const CAP = {
  maxContextTokens: 1000,
  maxOutputTokens: 100,
  thinking: false,
  toolUse: true,
  imageIn: false,
  videoIn: false,
};

interface Step {
  text?: string;
  toolCalls?: ToolCall[];
}

/** A provider that scripts the MAIN agent and the CHILD agent separately, routing by whether the
 *  conversation's system message marks the child (its role systemPrompt contains "CHILD"). Lets one
 *  provider drive both the parent loop and the spawned child without their turn counters colliding. */
function routedModel(mainSteps: Step[], childSteps: Step[]): ModelProvider {
  let mainI = 0;
  let childI = 0;
  const provider: ModelProvider = {
    capability: CAP,
    async *call(messages: Message[]): AsyncGenerator<ModelDelta, ModelResult> {
      const isChild = messages.some((m) => m.role === 'system' && m.content.includes('CHILD'));
      const steps = isChild ? childSteps : mainSteps;
      const i = isChild ? childI++ : mainI++;
      const step = steps[Math.min(i, steps.length - 1)];
      const text = step.text ?? '';
      if (text.length > 0) yield { type: 'text', text };
      const toolCalls = step.toolCalls ?? [];
      return {
        text,
        toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'completed',
        rawFinishReason: 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function dummyProvider(): ModelProvider {
  const provider: ModelProvider = {
    capability: CAP,
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield* []; // this provider is never actually iterated (shape/run-maps tests don't run the loop)
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

describe('createDelegateTool — shape', () => {
  it('is a read-only `task` tool whose description lists the roster', () => {
    const mgr = new SubagentManager({
      provider: dummyProvider(),
      registry: new InMemoryToolRegistry(),
      gate: new DefaultPermissionGate({}),
      budget: { maxTurns: 6 },
      roster: ROSTER,
      cwd: process.cwd(),
      remainingDepth: 2,
    });
    const tool = createDelegateTool(mgr);
    expect(tool.name).toBe(TASK_TOOL_NAME);
    expect(tool.capability).toBe('read-only'); // delegation itself produces no direct side effect
    expect(tool.description).toContain('reader');
    expect(tool.description).toContain('writer');
    const registry = new InMemoryToolRegistry();
    registry.register(tool);
    expect(delegateToolSchema(ROSTER)).toEqual(registry.schemasForModel()[0]);
  });
});

describe('createDelegateTool — run maps the spawn result', () => {
  it('returns the summary as content on success, and as error on a refused/failed spawn', async () => {
    const mgr = new SubagentManager({
      provider: dummyProvider(),
      registry: new InMemoryToolRegistry(),
      gate: new DefaultPermissionGate({}),
      budget: { maxTurns: 6 },
      roster: ROSTER,
      cwd: process.cwd(),
      remainingDepth: 2,
      run: capturingRun('SUMMARY'),
    });
    const tool = createDelegateTool(mgr);

    const ok = await tool.run({ role: 'reader', task: 'x' }, { cwd: process.cwd() });
    expect(ok).toEqual({ content: 'SUMMARY' });

    const bad = await tool.run({ role: 'ghost', task: 'x' }, { cwd: process.cwd() });
    expect(bad.content).toBe('');
    expect(bad.error).toContain("unknown role 'ghost'");
  });
});

describe('delegating via `task` does NOT bypass write approval (decision 2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-delegate-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('the child write still hits the approver; the task call itself does not', async () => {
    const a = fixedApprover('allow-once');
    const gate = new DefaultPermissionGate({ approver: a.approver });
    const provider = routedModel(
      // MAIN: delegate to the writer, then report.
      [
        {
          text: 'delegating',
          toolCalls: [
            { id: 't1', name: TASK_TOOL_NAME, arguments: JSON.stringify({ role: 'writer', task: 'write out.txt' }) },
          ],
        },
        { text: 'the subagent wrote the file' },
      ],
      // CHILD: write the file, then report.
      [
        {
          text: 'writing',
          toolCalls: [
            { id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'out.txt', content: 'hi', createOnly: true }) },
          ],
        },
        { text: 'wrote out.txt' },
      ],
    );

    const tools = new InMemoryToolRegistry();
    tools.register(writeTool);
    const manager = new SubagentManager({
      provider,
      registry: tools,
      gate,
      budget: { maxTurns: 6 },
      roster: ROSTER,
      cwd: dir,
      remainingDepth: 2,
      makeDelegateTool: (m) => createDelegateTool(m),
      delegateToolName: TASK_TOOL_NAME,
    });
    tools.register(createDelegateTool(manager));

    const bus = new InMemoryEventBus();
    const outcome = await runAgent({
      model: provider,
      tools,
      bus,
      messages: [
        { role: 'system', content: 'MAIN: you can delegate with the task tool.' },
        { role: 'user', content: 'have the writer create out.txt' },
      ],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 6 },
      gate,
    });

    expect(a.asks()).toBe(1); // ONLY the child write asked — the read-only `task` call did not
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('hi');
    expect(outcome.finalText).toBeDefined();
  });

  it('propagates a child write-then-throw as an unresolved parent task effect', async () => {
    const gate = new DefaultPermissionGate({ approver: fixedApprover('allow-once').approver });
    const provider = routedModel(
      [{ toolCalls: [{ id: 't1', name: TASK_TOOL_NAME, arguments: JSON.stringify({ role: 'writer', task: 'run it' }) }] }],
      [{ toolCalls: [{ id: 'w1', name: 'child_write_then_throw', arguments: '{}' }] }],
    );
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: 'child_write_then_throw',
      description: 'test only',
      capability: 'writes-files',
      inputSchema: z.object({}),
      run: async () => {
        await writeFile(join(dir, 'child-effect.txt'), 'applied', 'utf8');
        throw new Error('child late failure');
      },
    });
    const manager = new SubagentManager({
      provider,
      registry: tools,
      gate,
      budget: { maxTurns: 6 },
      roster: ROSTER,
      cwd: dir,
      remainingDepth: 2,
      makeDelegateTool: (m) => createDelegateTool(m),
      delegateToolName: TASK_TOOL_NAME,
    });
    tools.register(createDelegateTool(manager));
    const sessionPath = join(dir, 'parent.jsonl');
    const store = new FileSessionStore(sessionPath);
    await store.writeHeader({
      id: 'parent',
      model: 'm',
      cwd: dir,
      startedAt: 't0',
      composition: createSessionComposition({
        root: 'repl', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: tools.schemasForModel(), systemPrompt: 'MAIN',
      }),
    });

    const outcome = await runAgent({
      model: provider,
      tools,
      bus: new InMemoryEventBus(),
      messages: [{ role: 'system', content: 'MAIN' }, { role: 'user', content: 'delegate' }],
      toolCtx: { cwd: dir },
      budget: { maxTurns: 6 },
      gate,
      store,
    });

    expect(outcome).toEqual({ halted: 'toolExecutionUnknown', turns: 1 });
    expect(await readFile(join(dir, 'child-effect.txt'), 'utf8')).toBe('applied');
    await expect(loadSession(sessionPath, { requireHeader: true })).resolves.toMatchObject({
      pendingTools: [expect.objectContaining({ toolName: TASK_TOOL_NAME, reason: 'unknown' })],
    });
  });
});
