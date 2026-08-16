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
 *
 * The per-prompt machinery (gate + approver wiring, checkpoint capture, Session persistence,
 * EventBus subscription, runAgent) lives in {@link createReplRunner} so the fullscreen TUI driver
 * (tui-repl.ts) reuses THIS implementation instead of growing a second one: only the input
 * acquisition and the text rendering differ between the two surfaces.
 */
import { createInterface } from 'node:readline';
import type { Message } from '../../core/types.js';
import type { ModelProvider } from '../../core/model/types.js';
import type { ToolRegistry } from '../../core/tools/types.js';
import type { ContextManager } from '../../core/context/context-manager.js';
import type { SkillRegistry } from '../../capabilities/skills/skill-registry.js';
import { runAgent, type RunOutcome } from '../../core/loop/run-agent.js';
import { InMemoryEventBus, type Event } from '../../runtime/event-bus.js';
import { DefaultPermissionGate, type Approver, type PermissionPolicy } from '../../runtime/permission/index.js';
import type { SessionStore } from '../../runtime/session/index.js';
import type { CheckpointPhase } from '../../runtime/checkpoint/index.js';
import type { AgentEventWriter } from '../../runtime/agent-events.js';
import {
  SubagentManager,
  createDelegateTool,
  TASK_TOOL_NAME,
  type AgentRole,
} from '../../capabilities/subagents/index.js';
import type { HookRunner } from '../../capabilities/hooks/index.js';
import { initialRenderState, renderEvent } from './render.js';
import { renderApprovalRequest, parseApprovalChoice, safeInline } from './approval.js';
import { CLI_EXIT, exitCodeForRun, type CliExitCode } from './exit-codes.js';
import { createApprovalEventApprover } from './approval-events.js';

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
  /** Checkpoint controller bound to the current v2 Session. */
  checkpoints?: ReplCheckpointController;
  /** Seed the conversation from a resumed session. When absent/empty, a fresh system prompt is used. */
  initialMessages?: Message[];
  /** Optional first prompt supplied by `jarvis run <prompt>` before interactive input begins. */
  initialPrompt?: string;
  /** Stable lifecycle identity for machine mode. */
  sessionId?: string;
  agentEvents?: AgentEventWriter;
  /** Run exactly the supplied initial prompt and never wait for another line. */
  singlePrompt?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface ReplCheckpointController {
  capture(
    phase: CheckpointPhase,
    messages: readonly Message[],
  ): Promise<{ checkpointId: string }>;
}

/** How many unrecognized approval answers to tolerate before failing closed (deny). */
const MAX_APPROVAL_RETRIES = 3;

/** Max subagent nesting depth (main → child → grandchild). Bounds runaway recursion / cost (R4). */
const MAX_SUBAGENT_DEPTH = 2;

/** The per-run surface hooks: human-facing notes and every EventBus event of the run. */
export interface ReplRunIo {
  write(text: string): void;
  event(event: Event): void;
}

/** How one {@link ReplRunner.runPrompt} ended. Exactly one terminal outcome per call. */
export type ReplRunResult =
  | { status: 'ok'; outcome: RunOutcome }
  | { status: 'interrupted'; error: unknown }
  | { status: 'error'; error: unknown }
  | { status: 'checkpoint-failed'; error: unknown };

/** The surface-independent half of the REPL: everything except line reading and text rendering. */
export interface ReplRunner {
  /** Conversation state shared across prompts (mutated in place by runPrompt, as runAgent expects). */
  readonly messages: readonly Message[];
  runPrompt(text: string, io: ReplRunIo): Promise<ReplRunResult>;
  /** Abort the active run (Ctrl-C / TUI stop). No-op when idle. */
  abort(): void;
  /** True exactly while a runPrompt call is in flight (drives the line REPL's SIGINT policy). */
  isRunning(): boolean;
  /** `/checkpoint`: sync the Session then capture a manual checkpoint. */
  manualCheckpoint(): Promise<{ checkpointId: string }>;
  sessionStart(): Promise<void>;
  sessionEnd(): Promise<void>;
}

export type ReplRunnerDeps = Omit<
  ReplDeps,
  'approver' | 'input' | 'output' | 'initialPrompt' | 'singlePrompt'
> & {
  /** Surface-supplied approver: the readline prompt (line REPL) or the y/s/n key flow (TUI). */
  approver: Approver;
};

/**
 * Build the reusable session driver: permission gate (approver wrapped with approval_request /
 * approval_result bus events), optional subagent roster, the persistent conversation, and the
 * per-prompt pipeline — durable-prefix checkpoint → user turn → Session sync → fresh EventBus →
 * runAgent → cleanup. Both terminal surfaces drive prompts through this single implementation.
 */
export function createReplRunner(deps: ReplRunnerDeps): ReplRunner {
  let activeRun: AbortController | null = null;
  let currentBus: InMemoryEventBus | undefined;

  // The approver answer is observed onto the CURRENT run's bus so every surface renders and
  // audits the same approval_request/approval_result pair (approval-events.ts).
  const observedApprover: Approver = async (request) => {
    if (currentBus === undefined) return 'deny';
    return createApprovalEventApprover({
      approver: deps.approver,
      bus: currentBus,
      sessionId: deps.sessionId,
    })(request);
  };
  const gate = new DefaultPermissionGate({ approver: observedApprover, policy: deps.policy });

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
  // just above), so a derived prompt lists exactly the tools the model will be offered. Resume from
  // a prior session if given — it already carries its own system message; otherwise start fresh.
  const messages: Message[] =
    deps.initialMessages && deps.initialMessages.length > 0
      ? [...deps.initialMessages]
      : [{ role: 'system', content: resolveSystemPrompt(deps) }];

  return {
    messages,
    sessionStart: () => runAdvisoryHook(deps.hooks?.sessionStart),
    sessionEnd: () => runAdvisoryHook(deps.hooks?.sessionEnd),
    abort: () => {
      activeRun?.abort();
    },
    isRunning: () => activeRun !== null,
    manualCheckpoint: async () => {
      await deps.store?.sync(messages);
      if (deps.checkpoints === undefined) throw new Error('checkpoint unavailable for this session');
      return deps.checkpoints.capture('manual', messages);
    },
    runPrompt: async (text, io) => {
      try {
        // Capture the already-durable prefix before this prompt mutates it.
        await deps.store?.sync(messages);
        await deps.checkpoints?.capture('before-user-prompt', messages);
      } catch (err) {
        io.write(`  · checkpoint failed: ${safeInline(err instanceof Error ? err.message : String(err))}\n`);
        return { status: 'checkpoint-failed', error: err };
      }

      messages.push({ role: 'user', content: text });
      // Persist the user turn immediately so it survives even if the run errors before its own sync.
      await deps.store?.sync(messages);

      const bus = new InMemoryEventBus(deps.agentEvents === undefined ? undefined : (err) => { throw err; });
      currentBus = bus;
      const unsubscribe = bus.subscribe(io.event);
      const unsubscribeAgentEvents = deps.agentEvents === undefined
        ? undefined
        : bus.subscribe((event) => deps.agentEvents?.accept(event));

      activeRun = new AbortController();
      try {
        const checkpointController = deps.checkpoints;
        const outcome = await runAgent({
          model: deps.model,
          tools: deps.tools,
          bus,
          sessionId: deps.sessionId,
          messages,
          toolCtx: { cwd: deps.cwd },
          budget: { maxTurns: deps.maxTurns },
          context: deps.context,
          gate,
          hooks: deps.hooks,
          store: deps.store,
          ...(checkpointController === undefined
            ? {}
            : {
                beforeModelWave: async (current) => {
                  await checkpointController.capture('before-model-wave', current);
                },
              }),
          systemAddendum: deps.skills?.systemAddendum(text),
          signal: activeRun.signal,
        });
        return { status: 'ok', outcome };
      } catch (err) {
        const interrupted = activeRun.signal.aborted;
        io.write(
          interrupted
            ? '\n  · (已中断)\n'
            : `\n  · 出错: ${safeInline(err instanceof Error ? err.message : String(err))}\n`,
        );
        return interrupted ? { status: 'interrupted', error: err } : { status: 'error', error: err };
      } finally {
        unsubscribeAgentEvents?.();
        unsubscribe();
        currentBus = undefined;
        activeRun = null;
      }
    },
  };
}

export async function startRepl(deps: ReplDeps): Promise<CliExitCode | undefined> {
  const out = deps.output ?? process.stdout;
  const rl = createInterface({ input: deps.input ?? process.stdin, output: out });
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

  const runner = createReplRunner({
    ...deps,
    approver: deps.approver ?? interactiveApprover(),
  });

  rl.on('SIGINT', () => {
    if (inApproval) {
      out.write('\n');
      runner.abort(); // deny the approval (via the null below) AND stop the run
      deliver(null);
    } else if (runner.isRunning()) {
      runner.abort();
    } else {
      closed = true;
      deliver(null);
      rl.close();
    }
  });

  // The interactive approver: show the request, read one line, map it. EOF/Ctrl-C → deny
  // (fail-closed); too many unrecognized answers → deny.
  function interactiveApprover(): Approver {
    return async (req) => {
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
  }

  await runner.sessionStart();
  try {
    out.write(`Jarvis-Agent · ${safeInline(deps.modelName)}\n输入消息,Ctrl-C 退出(/exit 也可；/checkpoint 手动打点)\n\n`);

    for (;;) {
      out.write('› ');
      const line = await nextLine();
      if (line === null) break;
      const text = line.trim();
      if (text === '') continue;
      if (text === '/exit' || text === '/quit') break;

      if (text === '/checkpoint') {
        if (deps.checkpoints === undefined) {
          out.write('  · checkpoint unavailable for this session\n');
          continue;
        }
        try {
          const checkpoint = await runner.manualCheckpoint();
          out.write(`  · checkpoint ${safeInline(checkpoint.checkpointId)}\n`);
        } catch (err) {
          out.write(`  · checkpoint failed: ${safeInline(err instanceof Error ? err.message : String(err))}\n`);
        }
        continue;
      }

      let rstate = initialRenderState();
      const result = await runner.runPrompt(text, {
        write: (text_) => out.write(text_),
        event: (event) => {
          const rendered = renderEvent(rstate, event);
          rstate = rendered.state;
          if (rendered.output) out.write(rendered.output);
        },
      });
      if (deps.singlePrompt) return singlePromptExitCode(result, deps.agentEvents);
      out.write('\n');
    }
  } finally {
    await runner.sessionEnd();
    rl.close();
  }
}

/** Map one run result to the machine-surface exit contract; never grants completion. */
function singlePromptExitCode(
  result: ReplRunResult,
  agentEvents: AgentEventWriter | undefined,
): CliExitCode {
  const completion = { granted: false, authority: 'none' } as const;
  if (result.status === 'ok') {
    const outcome = result.outcome;
    const exitCode = exitCodeForRun(outcome);
    agentEvents?.runFinished({
      status: outcome.finalText !== undefined
        ? 'completed'
        : outcome.halted === 'turnTimeout'
          ? 'failed'
          : outcome.halted === 'toolExecutionUnknown'
            ? 'needs-human'
            : 'blocked',
      exitCode,
      completion,
    });
    return exitCode;
  }
  if (result.status === 'checkpoint-failed') {
    agentEvents?.runFinished({ status: 'failed', exitCode: CLI_EXIT.RUNTIME, completion });
    return CLI_EXIT.RUNTIME;
  }
  const interrupted = result.status === 'interrupted';
  const exitCode = interrupted ? CLI_EXIT.INTERRUPTED : CLI_EXIT.RUNTIME;
  agentEvents?.runFinished({ status: interrupted ? 'interrupted' : 'failed', exitCode, completion });
  return exitCode;
}

/** A fixed prompt passes through; a builder gets the tool names the model will actually see. */
function resolveSystemPrompt(deps: ReplRunnerDeps): string {
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
