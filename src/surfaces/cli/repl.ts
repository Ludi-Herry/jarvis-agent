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
import type { SessionStore } from '../../runtime/session/index.js';
import {
  SubagentManager,
  createDelegateTool,
  TASK_TOOL_NAME,
  type AgentRole,
} from '../../capabilities/subagents/index.js';
import type { HookRunner } from '../../capabilities/hooks/index.js';
import { initialRenderState, renderEvent } from './render.js';
import { renderApprovalRequest, parseApprovalChoice } from './approval.js';

export interface ReplDeps {
  model: ModelProvider;
  tools: ToolRegistry;
  context?: ContextManager;
  /** Optional skills (A5): each turn the catalog + activated skill bodies fold into the system msg. */
  skills?: SkillRegistry;
  /** Optional agent roster (Phase C): when non-empty, a `task` delegate tool is registered so the
   *  main agent can spawn specialist subagents (capability-dispatch axis). */
  roster?: AgentRole[];
  /** Base directory tool paths resolve against. */
  cwd: string;
  /** Shown in the banner. */
  modelName: string;
  /** Either a fixed prompt, or a builder called with the names of the tools actually registered
   *  (see {@link resolveSystemPrompt}) — `task` is registered below, so only the REPL can know the
   *  complete list. The composition root passes `buildSystemPrompt` (system-prompt.ts). */
  systemPrompt: string | ((toolNames: string[]) => string);
  maxTurns: number;
  /** Override the approver (tests). Default builds the interactive readline approver below. */
  approver?: Approver;
  /** Gate policy (B5): the merged rule layers. Defaults to the built-in policy (no extra rules). */
  policy?: PermissionPolicy;
  /** Optional hooks, built by the composition root from trusted sources. PreToolUse can fail-closed
   *  block a gate-allowed call; PostToolUse and lifecycle hooks are advisory. */
  hooks?: HookRunner;
  /** Session store (persistence): when present, turns are logged so the session can be resumed. */
  store?: SessionStore;
  /** Seed the conversation from a resumed session. When absent/empty, a fresh system prompt is used. */
  initialMessages?: Message[];
  /** Optional first prompt supplied by `jarvis run <prompt>` before interactive input begins. */
  initialPrompt?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** How many unrecognized approval answers to tolerate before failing closed (deny). */
const MAX_APPROVAL_RETRIES = 3;

/** Max subagent nesting depth (main → child → grandchild). Bounds runaway recursion / cost (R4). */
const MAX_SUBAGENT_DEPTH = 2;

export async function startRepl(deps: ReplDeps): Promise<void> {
  const out = deps.output ?? process.stdout;
  const rl = createInterface({ input: deps.input ?? process.stdin, output: out });

  let activeRun: AbortController | null = null;
  let inApproval = false;

  // --- single on-demand line queue (shared by the main prompt and the approval prompt) ---
  const queue: string[] = deps.initialPrompt?.trim() ? [deps.initialPrompt] : [];
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

  // Phase C: with a roster configured, wire the SubagentManager and register the `task` delegate
  // tool. Children REUSE this gate (write/bash inside a child still gets approved), run on a strictly
  // smaller budget, and nest no deeper than MAX_SUBAGENT_DEPTH.
  if (deps.roster && deps.roster.length > 0) {
    const manager = new SubagentManager({
      provider: deps.model,
      registry: deps.tools,
      gate,
      budget: { maxTurns: deps.maxTurns },
      roster: deps.roster,
      cwd: deps.cwd,
      context: deps.context,
      remainingDepth: MAX_SUBAGENT_DEPTH,
      makeDelegateTool: (mgr) => createDelegateTool(mgr),
      delegateToolName: TASK_TOOL_NAME,
    });
    deps.tools.register(createDelegateTool(manager));
  }

  // Built HERE, after every conditional registration (bash/vision from the composition root, `task`
  // just above), so a derived prompt lists exactly the tools the model will be offered. Resume from a
  // prior session if given — it already carries its own system message; otherwise start fresh.
  const messages: Message[] =
    deps.initialMessages && deps.initialMessages.length > 0
      ? [...deps.initialMessages]
      : [{ role: 'system', content: resolveSystemPrompt(deps) }];

  await runAdvisoryHook(deps.hooks?.sessionStart);
  try {
    out.write(`Jarvis-Agent · ${deps.modelName}\n输入消息,Ctrl-C 退出(/exit 也可)\n\n`);

    for (;;) {
      out.write('› ');
      const line = await nextLine();
      if (line === null) break;
      const text = line.trim();
      if (text === '') continue;
      if (text === '/exit' || text === '/quit') break;

      messages.push({ role: 'user', content: text });
      // Persist the user turn immediately so it survives even if the run errors before its own sync.
      await deps.store?.sync(messages);

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
          hooks: deps.hooks,
          store: deps.store,
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
  } finally {
    await runAdvisoryHook(deps.hooks?.sessionEnd);
    rl.close();
  }
}

/** A fixed prompt passes through; a builder gets the tool names the model will actually see. */
function resolveSystemPrompt(deps: ReplDeps): string {
  return typeof deps.systemPrompt === 'string'
    ? deps.systemPrompt
    : deps.systemPrompt(deps.tools.schemasForModel().map((s) => s.name));
}

async function runAdvisoryHook(fn: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await fn?.();
  } catch {
    // session hooks are notification-only
  }
}
