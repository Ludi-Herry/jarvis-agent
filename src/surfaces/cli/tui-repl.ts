/**
 * tui-repl — the fullscreen TUI session driver (checkpoint/TUI contract §4–5).
 *
 * Owns the frozen reducer loop and the view buffer: keys arrive as TuiAction values from the
 * terminal adapter (tui-host.ts), reduceTui produces declarative effects, and THIS driver is the
 * only place effects execute — startRun/abortRun/resolveApproval/exit/appendAudit. Agent runs go
 * through {@link createReplRunner} from repl.ts, so the approval gate, checkpoint capture, Session
 * persistence, subagent roster, and EventBus subscription have exactly ONE implementation shared
 * with the line REPL. What is TUI-specific: the key-driven approver (y/s/n), the reducer wiring,
 * the action-audit log (data/tui/<sessionId>.jsonl), and the view projection of EventBus events.
 *
 * Redirect never jumps the queue here — the reducer only emits startRun for it after runClosed,
 * and pending/unknown effects land in needs-human instead of auto-starting work.
 */
import type { ApprovalRequest, Approver } from '../../runtime/permission/index.js';
import type { Event } from '../../runtime/event-bus.js';
import { FileTuiActionAuditStore } from './tui-audit.js';
import {
  initialTuiState,
  reduceTui,
  type ApprovalDecision,
  type TuiAction,
  type TuiAuditDetail,
  type TuiEffect,
  type TuiState,
} from './tui-state.js';
import { createTuiHost, type TuiRawInput, type TuiResizeOutput } from './tui-host.js';
import type { TuiView, TuiViewEntry } from './tui-renderer.js';
import { createReplRunner, type ReplDeps, type ReplRunResult } from './repl.js';
import { detailOf } from './approval.js';
import { isSessionGrantAllowed } from './interactive-approver.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';

export interface TuiReplDeps extends Omit<ReplDeps, 'approver' | 'input' | 'output' | 'singlePrompt'> {
  input: TuiRawInput;
  output: TuiResizeOutput;
  columns: number;
  rows: number;
}

/** View entries beyond this count drop the OLDEST (bounded memory; display is already bounded). */
const MAX_VIEW_ENTRIES = 500;

export async function startTuiRepl(deps: TuiReplDeps): Promise<CliExitCode | undefined> {
  let state: TuiState = initialTuiState();
  let view: TuiView = { entries: [] };
  let finished = false;
  let finishResolve!: (code: CliExitCode | undefined) => void;
  const finishedPromise = new Promise<CliExitCode | undefined>((resolve) => {
    finishResolve = resolve;
  });

  // The action audit is the one TUI-owned sink; queue/redirect/interrupt/approval decisions are
  // recorded with bounded metadata only. A write failure surfaces in the view and never blocks a
  // key action (this log observes; it holds no completion authority).
  let auditStore: FileTuiActionAuditStore | undefined;
  if (deps.sessionId !== undefined) {
    try {
      auditStore = new FileTuiActionAuditStore({ cwd: deps.cwd, sessionId: deps.sessionId });
    } catch {
      auditStore = undefined;
      view = appendEntry(view, { kind: 'error', text: 'tui action audit unavailable for this session' });
    }
  }
  /** In-flight audit appends; shutdown drains these before finishing. */
  const auditWrites: Promise<void>[] = [];

  // The key-driven approver: the gate's ask parks here until a y/s/n action (via the reducer's
  // resolveApproval effect) resolves it, or shutdown fails closed to deny. The approval_request /
  // approval_result bus pair still comes from the shared approval-events wrapper in repl.ts.
  let pendingApproval: {
    request: ApprovalRequest;
    resolve(decision: ApprovalDecision): void;
  } | undefined;
  const tuiApprover: Approver = (request) => new Promise((resolve) => {
    pendingApproval = {
      request,
      resolve: (decision) => {
        pendingApproval = undefined;
        resolve(decision);
      },
    };
    view = appendEntry(view, {
      kind: 'system',
      text: `approval: ${request.toolName} (${request.capability})`,
      meta: detailOf(request),
    });
    scheduleFrame();
  });

  const runner = createReplRunner({
    model: deps.model,
    tools: deps.tools,
    context: deps.context,
    skills: deps.skills,
    roster: deps.roster,
    cwd: deps.cwd,
    modelName: deps.modelName,
    systemPrompt: deps.systemPrompt,
    maxTurns: deps.maxTurns,
    policy: deps.policy,
    hooks: deps.hooks,
    store: deps.store,
    checkpoints: deps.checkpoints,
    sessionId: deps.sessionId,
    agentEvents: deps.agentEvents,
    initialMessages: deps.initialMessages,
    approver: tuiApprover,
  });

  // Runner notes (checkpoint failures, run errors) and every EventBus event of a run: the note
  // path lands as a system entry, the event path feeds BOTH the reducer and the view.
  const io = {
    write: (text: string): void => {
      const line = text.trim();
      if (line !== '') view = appendEntry(view, { kind: 'system', text: line });
      scheduleFrame();
    },
    event: (event: Event): void => {
      state = reduceTui(state, { type: 'event', event }).state;
      view = applyEventToView(view, event);
      scheduleFrame();
    },
  };

  const host = createTuiHost({
    input: deps.input,
    output: deps.output,
    columns: deps.columns,
    rows: deps.rows,
    onAction: (action) => handleAction(action),
    getState: () => state,
    getView: () => view,
  });

  function scheduleFrame(): void {
    host.refresh();
  }

  function handleAction(action: TuiAction): void {
    if (finished) return;

    // The parse layer cannot see the live request's capability, so the session-grant rule
    // (executes-code only) is enforced HERE, before the reducer locks the decision in: an
    // ineligible 's' is refused and re-asked, never silently downgraded to allow-once.
    if (
      action.type === 'approvalDecision'
      && action.decision === 'allow-session'
      && pendingApproval !== undefined
      && !isSessionGrantAllowed(pendingApproval.request.capability)
    ) {
      view = appendEntry(view, { kind: 'system', text: 'session grant is shell-only: y = allow-once, n = deny' });
      scheduleFrame();
      return;
    }

    if (action.type === 'submit' && action.text.trim() !== '') {
      view = appendEntry(view, { kind: 'user', text: action.text });
    }

    const transition = reduceTui(state, action);
    state = transition.state;
    for (const effect of transition.effects) executeEffect(effect);
    scheduleFrame();
  }

  function executeEffect(effect: TuiEffect): void {
    switch (effect.type) {
      case 'startRun':
        // Fire-and-forget: the run reports back via the runClosed action below, which is the
        // only path that can start the next queued/redirected prompt.
        void runStart(effect.prompt);
        return;
      case 'abortRun':
        runner.abort();
        return;
      case 'resolveApproval':
        // Stale resolutions (no parked approver) are dropped: the gate only consults the
        // approver inside a live run, so an unmatched id cannot change a real decision.
        pendingApproval?.resolve(effect.decision);
        return;
      case 'exit':
        shutdown(effect.code === 130 ? CLI_EXIT.INTERRUPTED : CLI_EXIT.SUCCESS);
        return;
      case 'appendAudit':
        // Collected so shutdown can flush every record before the session ends —
        // an exit effect often carries its audit record in the same transition.
        auditWrites.push(appendAudit(effect.detail).catch(() => {}));
        return;
    }
  }

  async function runStart(prompt: string): Promise<void> {
    if (finished) return;
    const text = prompt.trim();

    // The line REPL's slash commands live at the same choke point here: they surface through the
    // reducer's startRun effect (so queued variants still work) but never reach the model.
    if (text === '/exit' || text === '/quit') {
      shutdown(CLI_EXIT.SUCCESS);
      return;
    }
    if (text === '/checkpoint') {
      if (deps.checkpoints === undefined) {
        view = appendEntry(view, { kind: 'system', text: 'checkpoint unavailable for this session' });
      } else {
        try {
          const checkpoint = await runner.manualCheckpoint();
          view = appendEntry(view, { kind: 'system', text: `checkpoint ${checkpoint.checkpointId}` });
        } catch (err) {
          view = appendEntry(view, { kind: 'error', text: `checkpoint failed: ${message(err)}` });
        }
      }
      handleAction({ type: 'runClosed', outcome: 'manual-checkpoint', pendingEffects: false });
      return;
    }

    const result = await runner.runPrompt(prompt, io);
    if (finished) return;
    handleAction({
      type: 'runClosed',
      outcome: runOutcomeLabel(result),
      // toolExecutionUnknown is the one outcome that leaves an unresolvable pending tool effect;
      // the reducer then fails closed to needs-human instead of auto-starting the queue.
      pendingEffects: result.status === 'ok' && result.outcome.halted === 'toolExecutionUnknown',
    });
  }

  async function appendAudit(detail: TuiAuditDetail): Promise<void> {
    if (auditStore === undefined) return;
    try {
      await auditStore.append(detail);
    } catch (err) {
      view = appendEntry(view, { kind: 'error', text: `tui audit failed: ${message(err)}` });
      scheduleFrame();
    }
  }

  function shutdown(code: CliExitCode): void {
    if (finished) return;
    finished = true;
    pendingApproval?.resolve('deny'); // fail-closed: no key answer can outlive the session
    host.stop();
    // Microtask deferral: the reducer's exit transitions list `exit` BEFORE its
    // `appendAudit` effect, so the drain must snapshot auditWrites only after
    // the whole effect list of this transition has been dispatched.
    queueMicrotask(() => {
      void Promise.all(auditWrites)
        .then(() => runner.sessionEnd())
        .then(() => finishResolve(code));
    });
  }

  await runner.sessionStart();
  host.start();
  view = appendEntry(view, {
    kind: 'system',
    text: `Jarvis-Agent TUI · ${deps.modelName}`,
    meta: 'enter sends · "/redirect <text>" steers · ctrl-c stops, twice exits',
  });
  if (deps.initialPrompt?.trim()) {
    handleAction({ type: 'submit', text: deps.initialPrompt, mode: 'queue' });
  }
  return await finishedPromise;
}

function runOutcomeLabel(result: ReplRunResult): string {
  switch (result.status) {
    case 'ok':
      return result.outcome.finalText !== undefined
        ? 'completed'
        : `halted:${result.outcome.halted ?? 'unknown'}`;
    case 'interrupted':
      return 'interrupted';
    case 'error':
      return 'error';
    case 'checkpoint-failed':
      return 'checkpoint-failed';
  }
}

/** Project one EventBus event onto the scroll buffer (the reducer state was already updated). */
function applyEventToView(view: TuiView, event: Event): TuiView {
  switch (event.type) {
    case 'message_delta': {
      const entries = [...view.entries];
      const last = entries[entries.length - 1];
      if (last !== undefined && last.kind === 'assistant' && last.open === true) {
        entries[entries.length - 1] = { ...last, text: last.text + event.text };
      } else {
        entries.push({ kind: 'assistant', text: event.text, open: true });
      }
      return capEntries({ entries });
    }
    case 'final': {
      const entries = [...view.entries];
      const last = entries[entries.length - 1];
      if (last !== undefined && last.kind === 'assistant' && last.open === true) {
        entries[entries.length - 1] = { ...last, open: false };
      }
      return { entries };
    }
    case 'tool_call':
      return appendEntry(view, { kind: 'system', text: `tool ${event.call.name}`, meta: event.call.arguments });
    case 'tool_result':
      return appendEntry(view, {
        kind: event.out.error === undefined ? 'system' : 'error',
        text: 'tool result',
        meta: event.out.error ?? event.out.content,
      });
    case 'approval_request':
      return appendEntry(view, { kind: 'system', text: `approval requested: ${event.toolName}`, meta: event.detail });
    case 'approval_result':
      return appendEntry(view, { kind: 'system', text: `approval ${event.decision}` });
    case 'halt':
      return appendEntry(view, { kind: 'error', text: `halted: ${event.reason}` });
    default:
      return view;
  }
}

function appendEntry(view: TuiView, entry: TuiViewEntry): TuiView {
  return capEntries({ entries: [...view.entries, entry] });
}

function capEntries(view: TuiView): TuiView {
  if (view.entries.length <= MAX_VIEW_ENTRIES) return view;
  return { entries: view.entries.slice(view.entries.length - MAX_VIEW_ENTRIES) };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
