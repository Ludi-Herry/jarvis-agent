/**
 * The terminal REPL shell — the thin imperative layer over the agent loop.
 *
 * Read a line → append it as a user turn → run the agent (streaming events through the pure
 * {@link renderEvent} formatter) → re-prompt. The conversation and context manager persist across
 * turns, so it's one continuous session. Streams are injected (default stdin/stdout) so the whole
 * REPL runs against fake streams in a test, no TTY required.
 *
 * Input is served from a single on-demand line queue (not readline's async iterator): the main
 * prompt AND the B4 approval prompt both pull from it serially, so an approval answer is never
 * also swallowed as the next user message (which a second 'line' listener would do).
 *
 * Permissions (B4): every tool call passes a {@link DefaultPermissionGate}; an `ask` pauses and
 * prompts the user (allow once / session / deny). Ctrl-C denies a pending approval AND aborts the
 * run; mid-run it aborts; idle it exits. No interactive answer (piped/EOF) fails closed to deny.
 */
import { createInterface } from 'node:readline';
import type { Message } from '../../core/types.js';
import type { ModelProvider } from '../../core/model/types.js';
import type { ToolRegistry } from '../../core/tools/types.js';
import type { ContextManager } from '../../core/context/context-manager.js';
import type { SkillRegistry } from '../../capabilities/skills/skill-registry.js';
import { runAgent } from '../../core/loop/run-agent.js';
import { InMemoryEventBus } from '../../runtime/event-bus.js';
import { DefaultPermissionGate, type Approver, type PermissionPolicy } from '../../runtime/permission/index.js';
import { initialRenderState, renderEvent } from './render.js';
import { renderApprovalRequest, parseApprovalChoice } from './approval.js';

export interface ReplDeps {
  model: ModelProvider;
  tools: ToolRegistry;
  context?: ContextManager;
  /** Optional skills (A5): each turn the catalog + activated skill bodies fold into the system msg. */
  skills?: SkillRegistry;
  /** Base directory tool paths resolve against. */
  cwd: string;
  /** Shown in the banner. */
  modelName: string;
  systemPrompt: string;
  maxTurns: number;
  /** Override the approver (tests). Default builds the interactive readline approver below. */
  approver?: Approver;
  /** Gate policy (B5): the merged rule layers. Defaults to the built-in policy (no extra rules). */
  policy?: PermissionPolicy;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** How many unrecognized approval answers to tolerate before failing closed (deny). */
const MAX_APPROVAL_RETRIES = 3;

export async function startRepl(deps: ReplDeps): Promise<void> {
  const out = deps.output ?? process.stdout;
  const rl = createInterface({ input: deps.input ?? process.stdin, output: out });

  const messages: Message[] = [{ role: 'system', content: deps.systemPrompt }];
  let activeRun: AbortController | null = null;
  let inApproval = false;

  // --- single on-demand line queue (shared by the main prompt and the approval prompt) ---
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  const deliver = (line: string | null): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else if (line !== null) {
      queue.push(line);
    }
  };
  rl.on('line', (line) => deliver(line));
  rl.on('close', () => {
    closed = true;
    deliver(null);
  });
  const nextLine = (): Promise<string | null> => {
    if (queue.length > 0) return Promise.resolve(queue.shift() ?? null);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };

  rl.on('SIGINT', () => {
    if (inApproval) {
      out.write('\n');
      activeRun?.abort(); // deny the approval (via the null below) AND stop the run
      deliver(null);
    } else if (activeRun) {
      activeRun.abort();
    } else {
      closed = true;
      deliver(null);
      rl.close();
    }
  });

  // The interactive approver: show the request, read one line, map it. EOF/Ctrl-C → deny
  // (fail-closed); too many unrecognized answers → deny.
  const interactiveApprover: Approver = async (req) => {
    out.write(renderApprovalRequest(req));
    for (let attempt = 0; attempt < MAX_APPROVAL_RETRIES; attempt++) {
      out.write('    › ');
      inApproval = true;
      const line = await nextLine();
      inApproval = false;
      if (line === null) return 'deny';
      const choice = parseApprovalChoice(line);
      if (choice) return choice;
      out.write('    请输入 a(本次) / s(本会话) / d(拒绝)\n');
    }
    return 'deny';
  };

  const gate = new DefaultPermissionGate({ approver: deps.approver ?? interactiveApprover, policy: deps.policy });

  out.write(`Jarvis-Agent · ${deps.modelName}\n输入消息,Ctrl-C 退出(/exit 也可)\n\n`);

  for (;;) {
    out.write('› ');
    const line = await nextLine();
    if (line === null) break;
    const text = line.trim();
    if (text === '') continue;
    if (text === '/exit' || text === '/quit') break;

    messages.push({ role: 'user', content: text });

    const bus = new InMemoryEventBus();
    let rstate = initialRenderState();
    const unsubscribe = bus.subscribe((event) => {
      const { output, state } = renderEvent(rstate, event);
      rstate = state;
      if (output) out.write(output);
    });

    activeRun = new AbortController();
    try {
      await runAgent({
        model: deps.model,
        tools: deps.tools,
        bus,
        messages,
        toolCtx: { cwd: deps.cwd },
        budget: { maxTurns: deps.maxTurns },
        context: deps.context,
        gate,
        systemAddendum: deps.skills?.systemAddendum(text),
        signal: activeRun.signal,
      });
    } catch (err) {
      out.write(
        activeRun.signal.aborted
          ? '\n  · (已中断)\n'
          : `\n  · 出错: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      unsubscribe();
      activeRun = null;
    }

    out.write('\n');
  }

  rl.close();
}
