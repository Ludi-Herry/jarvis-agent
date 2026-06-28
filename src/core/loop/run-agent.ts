/**
 * runAgent — the heart: a stateful turn loop over an injected model + tools + event bus.
 *
 * Each turn: stream the model's reply (emitting text deltas as `message_delta`), record the
 * assistant turn, then DECIDE — if the model asked for no tools, that text is `final` and we
 * stop; otherwise run each tool call, feed every result back into the conversation, and loop.
 * A hard `maxTurns` ceiling (the guardrail) stops a model stuck calling tools forever before
 * it burns the budget. The per-turn judgments live in decisions.ts as pure functions.
 *
 * Events go to the injected {@link EventBus}, NOT a generator yield: the bus is the single
 * broadcast channel surfaces subscribe to (a1-demo already hands the loop this role —
 * "provider deltas → EventBus events"), so a CLI/GUI renders by subscribing while the caller
 * awaits this for the lifecycle. Compaction (decideCompact + ContextManager) is A3; the seam
 * is marked below.
 */
import type { Message, ToolCall, ToolResult } from '../types.js';
import type { ModelProvider, ModelResult } from '../model/types.js';
import type { ToolRegistry, ToolRunCtx } from '../tools/types.js';
import type { ContextManager } from '../context/context-manager.js';
import type { EventBus } from '../../runtime/event-bus.js';
import type { PermissionGate } from '../../runtime/permission/permission-gate.js';
import type { SessionStore } from '../../runtime/session/session-store.js';
import { type Budget, decideStop, withinBudget } from './decisions.js';

/** Everything the loop needs, injected so the loop owns no globals and stays testable. */
export interface AgentContext {
  model: ModelProvider;
  tools: ToolRegistry;
  bus: EventBus;
  /** Seeded with system + user messages by the caller; mutated in place across turns so the
   *  growing conversation (assistant turns + tool results) round-trips to the model. */
  messages: Message[];
  /** Base directory relative tool paths resolve against. */
  toolCtx: ToolRunCtx;
  budget: Budget;
  /** Optional context manager (A3). When present, the loop budgets oversized tool results
   *  and compacts the conversation once it nears the window. Absent → neither happens. */
  context?: ContextManager;
  /** Optional permission gate (B1). When present, every tool call is judged before it runs; a
   *  denied call is NOT executed — its reason is fed back to the model as the tool result so it
   *  can change course. Absent → tools run ungated (the A-phase behavior). */
  gate?: PermissionGate;
  /** Optional session store (persistence segment). When present, each turn's new messages are
   *  appended to an append-only log (and a compaction is checkpointed) so the session can be
   *  resumed after a crash/exit. Absent → nothing is persisted (the pre-persistence behavior). */
  store?: SessionStore;
  /** Optional per-run system addendum (A5): skill catalog + any activated skill bodies,
   *  folded into the system message at send time only — never stored in `messages`, so it
   *  refreshes each run and is never compacted. */
  systemAddendum?: string;
  signal?: AbortSignal;
}

/** How the loop ended. Exactly one of `finalText` (natural stop) / `halted` (guardrail) is
 *  set; `turns` is the number of model turns executed. */
export interface RunOutcome {
  finalText?: string;
  halted?: 'maxTurns';
  turns: number;
}

export async function runAgent(ctx: AgentContext): Promise<RunOutcome> {
  let turn = 0;

  while (withinBudget(turn, ctx.budget)) {
    const res = await streamTurn(ctx);

    // The model's own token report for this turn (never estimated).
    ctx.bus.emit({
      type: 'usage',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
    });

    // Record the assistant turn BEFORE running tools so the conversation stays well-formed
    // (assistant-with-tool_calls, then the matching tool messages).
    ctx.messages.push(assistantMessage(res));

    if (decideStop(res).done) {
      await ctx.store?.sync(ctx.messages); // persist the final assistant turn before stopping
      ctx.bus.emit({ type: 'final', text: res.text });
      return { finalText: res.text, turns: turn + 1 };
    }

    for (const call of res.toolCalls) {
      ctx.bus.emit({ type: 'tool_call', call });
      // Gate the call BEFORE the side effect (B1) — the seam A2 deliberately left here. A denied
      // call never reaches the tool; its reason becomes the result so the model can change course.
      const ran = await gatedRun(ctx, call);
      // Budget oversized output to disk BEFORE it enters the context (A3); a no-op without
      // a context manager or for small results.
      const out = ctx.context ? await ctx.context.budgetToolResult(ran) : ran;
      ctx.messages.push({ role: 'tool', toolCallId: out.callId, content: toolMessageContent(out) });
      ctx.bus.emit({ type: 'tool_result', out });
    }

    // Compact once the prompt nears the window, so the NEXT turn fits (A3). Persist after: a
    // compaction rewrites the array (checkpoint a full snapshot), otherwise append the new tail.
    if (ctx.context?.shouldCompact(res.usage)) {
      ctx.bus.emit({ type: 'state', phase: 'compacting' });
      await ctx.context.compact(ctx.messages);
      await ctx.store?.checkpoint(ctx.messages);
    } else {
      await ctx.store?.sync(ctx.messages);
    }

    turn++;
  }

  ctx.bus.emit({ type: 'halt', reason: 'maxTurns' });
  return { halted: 'maxTurns', turns: turn };
}

/** Drive one model stream to completion, emitting text increments as `message_delta`, and
 *  return the aggregated result. Tool-call deltas are partial, so the assembled tool calls
 *  are emitted by the caller AFTER the stream; reasoning has no A-phase event yet. */
async function streamTurn(ctx: AgentContext): Promise<ModelResult> {
  const sent = withSystemAddendum(ctx.messages, ctx.systemAddendum);
  const stream = ctx.model.call(sent, ctx.tools.schemasForModel(), ctx.signal);
  let next = await stream.next();
  while (!next.done) {
    const delta = next.value;
    if (delta.type === 'text' && delta.text.length > 0) {
      ctx.bus.emit({ type: 'message_delta', text: delta.text });
    }
    next = await stream.next();
  }
  return next.value;
}

/** Build the assistant message to round-trip: content + reasoning + tool calls, each
 *  included only when present so we never send empty noise the endpoint may reject. */
function assistantMessage(res: ModelResult): Message {
  const msg: Extract<Message, { role: 'assistant' }> = { role: 'assistant' };
  if (res.text.length > 0) msg.content = res.text;
  if (res.reasoning) msg.reasoning = res.reasoning;
  if (res.toolCalls.length > 0) msg.toolCalls = res.toolCalls;
  return msg;
}

/** Run one tool call through the gate (B1). With no gate the call runs as in A2. With a gate, a
 *  denied call is never executed: it comes back as a {@link ToolResult} with the denial reason in
 *  `error`, so the loop feeds "denied + why" to the model (identical shape to a tool failure, so
 *  the existing tool_result path renders it). The synthetic result reuses the call id; the wire
 *  layer normalizes ids at send time, so it pairs with its assistant tool_call. */
async function gatedRun(ctx: AgentContext, call: ToolCall): Promise<ToolResult> {
  // Pass the turn's abort signal so a long-running tool (bash) can be cancelled on Ctrl-C.
  const runCtx = ctx.signal ? { ...ctx.toolCtx, signal: ctx.signal } : ctx.toolCtx;
  if (!ctx.gate) return ctx.tools.run(call, runCtx);
  const verdict = await ctx.gate.check(call, ctx.tools.capabilityOf(call.name));
  if (verdict.allowed) return ctx.tools.run(call, runCtx);
  return { callId: call.id, content: '', error: `Permission denied: ${verdict.reason}` };
}

/** A tool's failure is surfaced to the model as text (so it can recover), not hidden. */
function toolMessageContent(out: ToolResult): string {
  return out.error !== undefined ? `ERROR: ${out.error}` : out.content;
}

/** Fold the per-run system addendum into the leading system message for THIS send only,
 *  returning a new array so `ctx.messages` is never mutated (the addendum must not persist
 *  or be compacted). No addendum → the original array, untouched. */
function withSystemAddendum(messages: Message[], addendum?: string): Message[] {
  if (!addendum) return messages;
  const [first, ...rest] = messages;
  if (first && first.role === 'system') {
    return [{ role: 'system', content: `${first.content}\n\n${addendum}` }, ...rest];
  }
  return [{ role: 'system', content: addendum }, ...messages];
}
