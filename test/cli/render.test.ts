import { describe, expect, it } from 'vitest';
import { initialRenderState, renderEvent } from '../../src/surfaces/cli/render.js';
import type { Event } from '../../src/runtime/event-bus.js';

/** Apply a sequence of events from the initial state, returning the concatenated output. */
function run(events: Event[]): string {
  let state = initialRenderState();
  let out = '';
  for (const e of events) {
    const r = renderEvent(state, e);
    state = r.state;
    out += r.output;
  }
  return out;
}

describe('renderEvent', () => {
  it('streams message_delta text raw and marks the cursor mid-line', () => {
    const r = renderEvent(initialRenderState(), { type: 'message_delta', text: 'hello' });
    expect(r.output).toBe('hello');
    expect(r.state.midLine).toBe(true);
  });

  it('breaks the streamed line before a tool call, then shows name(args)', () => {
    const out = run([
      { type: 'message_delta', text: 'let me check' },
      { type: 'tool_call', call: { id: 'c1', name: 'read', arguments: '{"path":"f.txt"}' } },
    ]);
    expect(out).toBe('let me check\n  ⏺ read({"path":"f.txt"})\n');
  });

  it('does not insert a leading break when already at line start', () => {
    const r = renderEvent(initialRenderState(), {
      type: 'tool_call',
      call: { id: 'c1', name: 'grep', arguments: '{}' },
    });
    expect(r.output).toBe('  ⏺ grep({})\n');
  });

  it('renders a tool result, and marks errors', () => {
    expect(
      renderEvent(initialRenderState(), {
        type: 'tool_result',
        out: { callId: 'c1', content: 'the answer' },
      }).output,
    ).toBe('    ↳ the answer\n');
    expect(
      renderEvent(initialRenderState(), {
        type: 'tool_result',
        out: { callId: 'c1', content: '', error: 'boom' },
      }).output,
    ).toBe('    ↳ ERROR: boom\n');
  });

  it('renders a usage line and a compacting status line', () => {
    expect(
      renderEvent(initialRenderState(), { type: 'usage', inputTokens: 702, outputTokens: 33 })
        .output,
    ).toBe('  · usage 702 in / 33 out\n');
    expect(
      renderEvent(initialRenderState(), { type: 'state', phase: 'compacting' }).output,
    ).toBe('  · compacting…\n');
  });

  it('closes the streamed line on final without re-printing the answer', () => {
    // final after streamed text → just a newline (text already shown via deltas)
    const out = run([
      { type: 'message_delta', text: 'done' },
      { type: 'final', text: 'done' },
    ]);
    expect(out).toBe('done\n');
    // final with nothing streamed → no output
    expect(renderEvent(initialRenderState(), { type: 'final', text: 'x' }).output).toBe('');
  });

  it('renders a halt line', () => {
    expect(
      renderEvent(initialRenderState(), { type: 'halt', reason: 'maxTurns' }).output,
    ).toBe('  · halted: maxTurns\n');
  });

  it('collapses whitespace and elides an over-long tool result', () => {
    const long = 'x'.repeat(500);
    const out = renderEvent(initialRenderState(), {
      type: 'tool_result',
      out: { callId: 'c1', content: `a\nb   c ${long}` },
    }).output;
    expect(out).toContain('a b c');
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(250);
  });

  it('renders a PostToolUse hook_output line and strips terminal injection from its stdout', () => {
    const ESC = String.fromCharCode(27);
    const out = renderEvent(initialRenderState(), {
      type: 'hook_output',
      hook: 'PostToolUse',
      toolName: 'bash',
      output: `lint${ESC}[31m failed`,
    }).output;
    expect(out).toContain('hook(bash) →');
    expect(out).toContain('lint');
    expect(out).not.toContain(ESC); // safeInline stripped the ANSI escape (no terminal injection)
  });
});
