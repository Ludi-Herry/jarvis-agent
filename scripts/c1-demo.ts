/**
 * C1 milestone demo — "it can delegate to a specialist subagent".
 *
 * Capability-dispatch axis (Phase C) against the REAL Doubao endpoint:
 *   Run A — DIRECT spawn: the manager runs the `researcher` role on a file-reading subtask; the
 *           child is narrowed to read-only, reads config.json, and returns a condensed summary.
 *   Run B — MODEL-DRIVEN: the main agent is given the `task` tool and decides to delegate to the
 *           researcher, then answers from the returned summary. (If the model answers without
 *           delegating, that is still a valid outcome; the direct path A proves the machinery.)
 *
 * Run:  npm run demo:c1   (needs ARK_API_KEY in the environment)
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDefaultRegistry,
  createProvider,
  loadDoubaoConfig,
  runAgent,
  type Message,
} from '../src/core/index.js';
import { DefaultPermissionGate, InMemoryEventBus, type Event } from '../src/runtime/index.js';
import {
  SubagentManager,
  createDelegateTool,
  TASK_TOOL_NAME,
  type AgentRole,
} from '../src/capabilities/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const ROSTER: AgentRole[] = [
  {
    name: 'researcher',
    description: 'reads files in the project and returns a concise factual summary',
    systemPrompt:
      'You are a focused researcher. Read what you are asked to read and reply with a concise, factual summary grounded in the file. Do not speculate or write files.',
    capability: ['read-only'],
    reasoningEffort: 'off',
  },
];

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  const provider = createProvider(config).withThinking('off');

  const dir = await mkdtemp(join(tmpdir(), 'c1-demo-'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ port: 8080, host: 'localhost' }, null, 2),
    'utf8',
  );

  // Parent registry: the built-ins (read/write/grep). The `task` tool is added after the manager
  // exists. The researcher is read-only, so its child only ever receives read/grep/task — not write.
  const tools = buildDefaultRegistry();
  const gate = new DefaultPermissionGate({
    approver: async (r) => {
      console.log(`\n[approver] ${r.toolName} — ${r.reason}? → allow-once`);
      return 'allow-once';
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

  console.log(`model: ${config.model}`);
  console.log(`cwd:   ${dir}`);

  console.log('\n=== Run A: DIRECT spawn of the researcher (read-only child closed loop) ===');
  const a = await manager.spawn(
    'researcher',
    'Read config.json and report the value of the "port" field.',
  );
  console.log(`[researcher summary] ${a.summary}`);
  const aOk = a.ok && /8080/.test(a.summary);
  console.log(`[assert A] researcher read the file and reported the port: ${aOk}`);

  console.log('\n=== Run B: MODEL-DRIVEN delegation via the task tool ===');
  const b = await runMain(
    provider,
    tools,
    gate,
    dir,
    'Use the researcher role (via the task tool) to find the "port" value in config.json, then tell me the port number.',
  );
  const delegated = b.events.some((e) => e.type === 'tool_call' && e.call.name === TASK_TOOL_NAME);
  const answered = /8080/.test(b.finalText ?? '');
  console.log(`\n[assert B] the main agent delegated via task: ${delegated}`);
  console.log(`[assert B] the main agent answered with the port: ${answered}`);

  await rm(dir, { recursive: true, force: true });

  const ok = aOk && answered; // B's answer is the end-to-end proof; delegation itself is best-effort
  console.log(`\n=== C1 demo ${ok ? 'PASSED' : 'FAILED'} ===`);
  if (!ok) process.exitCode = 1;
}

interface RunReport {
  events: Event[];
  finalText?: string;
}

async function runMain(
  provider: ReturnType<typeof createProvider>,
  tools: ReturnType<typeof buildDefaultRegistry>,
  gate: DefaultPermissionGate,
  dir: string,
  question: string,
): Promise<RunReport> {
  const bus = new InMemoryEventBus();
  const events: Event[] = [];
  bus.subscribe((e: Event) => {
    events.push(e);
    switch (e.type) {
      case 'message_delta':
        process.stdout.write(e.text);
        break;
      case 'tool_call':
        process.stdout.write(`\n[tool_call] ${e.call.name}(${preview(e.call.arguments)})\n`);
        break;
      case 'tool_result':
        process.stdout.write(
          `[tool_result] ${e.out.error ? `ERROR: ${e.out.error}` : preview(e.out.content)}\n`,
        );
        break;
      case 'final':
        process.stdout.write(`\n[final] ${e.text}\n`);
        break;
      default:
        break;
    }
  });
  const messages: Message[] = [
    {
      role: 'system',
      content:
        'You are a coding assistant. You can delegate a self-contained subtask to a specialist subagent with the `task` tool. Paths are relative to the project root.',
    },
    { role: 'user', content: question },
  ];
  const outcome = await runAgent({
    model: provider,
    tools,
    bus,
    messages,
    toolCtx: { cwd: dir },
    budget: { maxTurns: 6 },
    gate,
  });
  return { events, finalText: outcome.finalText };
}

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
