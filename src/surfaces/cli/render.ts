/**
 * Pure terminal rendering — one EventBus {@link Event} → the text to write, plus a tiny
 * carry state. No I/O here, so every line of formatting is unit-testable without a TTY
 * (the readline shell in repl.ts just writes whatever this returns).
 *
 * The only state we carry is `midLine`: whether the cursor sits mid-line because we just
 * streamed `message_delta` text with no trailing newline. A following structured line (tool
 * call, usage, status) inserts a break first so it never glues onto the streamed answer.
 */
import type { Event } from '../../runtime/event-bus.js';
import { safeInline } from './approval.js';

export interface RenderState {
  /** True when the last write was streamed text with no trailing newline. */
  midLine: boolean;
}

export function initialRenderState(): RenderState {
  return { midLine: false };
}

/** Longest tool-result/preview text shown inline before eliding. */
const PREVIEW_CHARS = 200;

/** Map one event to its terminal text and the next carry state. Returns `''` output for
 *  events the CLI doesn't surface. Pure: same (state, event) always yields the same pair. */
export function renderEvent(
  state: RenderState,
  event: Event,
): { output: string; state: RenderState } {
  switch (event.type) {
    case 'message_delta':
      // Stream the chunk raw; we're now mid-line until something breaks it.
      return { output: event.text, state: { midLine: true } };
    case 'tool_call':
      return {
        output: `${breakBefore(state)}  ⏺ ${event.call.name}(${event.call.arguments})\n`,
        state: { midLine: false },
      };
    case 'tool_result': {
      const body = event.out.error ? `ERROR: ${event.out.error}` : event.out.content;
      return { output: `    ↳ ${preview(body)}\n`, state: { midLine: false } };
    }
    case 'usage':
      return {
        output: `${breakBefore(state)}  · usage ${event.inputTokens} in / ${event.outputTokens} out\n`,
        state: { midLine: false },
      };
    case 'state':
      return { output: `${breakBefore(state)}  · ${event.phase}…\n`, state: { midLine: false } };
    case 'final':
      // The answer already streamed via message_delta; just close the line if needed.
      return { output: breakBefore(state), state: { midLine: false } };
    case 'halt':
      return {
        output: `${breakBefore(state)}  · halted: ${event.reason}\n`,
        state: { midLine: false },
      };
    case 'verdict':
      return {
        output: `${breakBefore(state)}  · 验收: ${event.outcome} — ${event.rationale}\n`,
        state: { midLine: false },
      };
    case 'goal_state':
      return {
        output: `${breakBefore(state)}  · 目标 → ${event.state}\n`,
        state: { midLine: false },
      };
    case 'loop_halt': {
      // verifier-health is the one halt that demands a human: the shared judge looks broken, so the
      // loop refuses to keep feeding the queue to it. Make that explicit; other reasons are routine.
      const note =
        event.reason === 'verifier-health'
          ? `\n  ⚠ 跨 goal 健康监控触发：独立裁判疑似失效（couldNotVerify 频发）——已停下，请人工检查裁判/模型后再 --resume`
          : '';
      return {
        output: `${breakBefore(state)}  · loop 停止: ${event.reason}${note}\n`,
        state: { midLine: false },
      };
    }
    case 'hook_output':
      // A PostToolUse hook spoke. safeInline strips any ANSI/control/bidi its stdout carries so it
      // can't inject into the terminal; preview bounds + single-lines it. (The full text still reaches
      // the model via the conversation message run-agent injects.)
      return {
        output: `${breakBefore(state)}  · hook(${safeInline(event.toolName)}) → ${preview(safeInline(event.output))}\n`,
        state: { midLine: false },
      };
    default:
      return { output: '', state };
  }
}

function breakBefore(state: RenderState): string {
  return state.midLine ? '\n' : '';
}

function preview(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine;
}
