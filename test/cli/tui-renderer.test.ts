import { describe, expect, it } from 'vitest';
import { initialTuiState, reduceTui, type TuiState } from '../../src/surfaces/cli/tui-state.js';
import {
  TUI_REDIRECT_PREFIX,
  displayWidth,
  parseTuiKeys,
  renderTuiFrame,
  splitCompleteUtf8,
  type TuiView,
} from '../../src/surfaces/cli/tui-renderer.js';
import type { Event } from '../../src/runtime/event-bus.js';

/** Every character class safeInline strips must never appear inside a frame content line. */
// eslint-disable-next-line no-control-regex -- enumerating stripped control characters is the assertion itself
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/u;

function runningState(): TuiState {
  return reduceTui(initialTuiState(), {
    type: 'event',
    event: { type: 'model_started', modelRunId: 'run-1', turn: 0, messageCount: 2, toolSchemaCount: 1 },
  }).state;
}

function approvalState(): TuiState {
  return reduceTui(runningState(), {
    type: 'event',
    event: {
      type: 'approval_request',
      requestId: 'approval-1',
      toolName: 'bash',
      capability: 'executes-code',
      reason: 'needs review',
      detail: 'rm -rf /tmp/x',
      at: 'now',
    },
  }).state;
}

function entryView(texts: string[]): TuiView {
  return {
    entries: texts.map((text, index) => ({
      kind: index % 2 === 0 ? 'assistant' as const : 'user' as const,
      text,
    })),
  };
}

function assertCleanFrame(frame: readonly string[], columns: number): void {
  for (const line of frame) {
    expect(UNSAFE.test(line), `unsafe characters in frame line: ${JSON.stringify(line)}`).toBe(false);
    expect(displayWidth(line), `frame line exceeds ${columns} cells: ${JSON.stringify(line)}`)
      .toBeLessThanOrEqual(columns);
  }
}

describe('renderTuiFrame', () => {
  it('renders idle, model-running, and approval-pending headers with identity and status', () => {
    const idle = renderTuiFrame(initialTuiState(), entryView([]), { columns: 80, rows: 12 });
    expect(idle[0]).toContain('idle');
    expect(idle.length).toBeLessThanOrEqual(12);
    assertCleanFrame(idle, 80);

    const running = renderTuiFrame(runningState(), entryView([]), { columns: 80, rows: 12 });
    expect(running[0]).toContain('model-running');
    expect(running[0]).toContain('run run-1');

    const approval = renderTuiFrame(approvalState(), entryView([]), { columns: 80, rows: 12 });
    expect(approval[0]).toContain('approval-pending');
    expect(approval[0]).toContain('approval approval-1');
    // The hint line names the approval keys only in approval-pending.
    expect(approval[approval.length - 1]).toContain('y allow-once');
    expect(running[running.length - 1]).not.toContain('y allow-once');
  });

  it('lays out entries between header and the input/hint footer', () => {
    const frame = renderTuiFrame(initialTuiState(), entryView(['hello', 'hi']), { columns: 60, rows: 12 });
    expect(frame[0]).toContain('jarvis');
    const body = frame.slice(1, -2);
    expect(body.some((line) => line.includes('hello'))).toBe(true);
    expect(frame[frame.length - 2]).toContain('input');
    expect(frame[frame.length - 1]).toContain('enter send');
    assertCleanFrame(frame, 60);
  });

  it('folds a long entry into a bounded block and marks the truncation', () => {
    const frame = renderTuiFrame(initialTuiState(), entryView([`head ${'x'.repeat(300)} tail`]), {
      columns: 40,
      rows: 12,
    });
    const body = frame.slice(1, -2);
    expect(body.length).toBeLessThanOrEqual(3);
    expect(body.some((line) => line.endsWith('…'))).toBe(true);
    assertCleanFrame(frame, 40);
  });

  it('keeps the newest entries in the scroll window and drops older ones with a marker', () => {
    const texts = Array.from({ length: 40 }, (_, index) => `message-${index}`);
    const frame = renderTuiFrame(initialTuiState(), entryView(texts), { columns: 60, rows: 10 });
    const flat = frame.join('\n');
    expect(flat).toContain('message-39');
    expect(flat).toContain('message-38');
    expect(flat).not.toContain('message-0');
    expect(flat).toContain('· · ·'); // dropped-history marker
    assertCleanFrame(frame, 60);
  });

  it('survives extreme sizes without crashing or overflowing', () => {
    for (const columns of [1, 8, 19]) {
      for (const rows of [1, 2, 3]) {
        const frame = renderTuiFrame(runningState(), entryView(['plain entry', '中文条目测试']), {
          columns,
          rows,
        });
        expect(frame.length).toBeLessThanOrEqual(rows);
        assertCleanFrame(frame, columns);
      }
    }
  });

  it('neutralizes ESC sequences, line breaks, and bidi controls from message text', () => {
    const attack = `visible${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[31m`
      + `${String.fromCharCode(13)}${String.fromCharCode(10)}FORGED`
      + `\u202e\u202a\u2066reversed\u2069`;
    const frame = renderTuiFrame(initialTuiState(), entryView([attack]), { columns: 80, rows: 12 });
    assertCleanFrame(frame, 80);
    expect(frame.join('\n')).not.toContain('FORGED\n');
    expect(frame.join('\n')).toContain('visible');
  });

  it('neutralizes C1 escapes and bidi controls pasted into the input line', () => {
    // Intake: parseTuiKeys must drop the same control set instead of buffering it.
    const typed = parseTuiKeys(
      Buffer.from(`x${String.fromCharCode(0x9b)}[31mz\u202eRLO\u2069n`, 'utf8'),
      initialTuiState(),
      '',
    );
    expect(typed.input).toBe('x[31mzRLOn');

    // Render: even a hostile view.input (bypassing intake) cannot reach a frame line.
    const frame = renderTuiFrame(initialTuiState(), {
      entries: [],
      input: `a${String.fromCharCode(0x9b)}[2J forged\u202eb`,
    }, { columns: 80, rows: 12 });
    assertCleanFrame(frame, 80);
    expect(frame.join('\n')).toContain('forged');
  });

  it('accounts CJK text as double width when clipping', () => {
    const frame = renderTuiFrame(initialTuiState(), entryView(['中文'.repeat(40)]), {
      columns: 20,
      rows: 8,
    });
    assertCleanFrame(frame, 20);
  });
});

describe('parseTuiKeys', () => {
  it('submits the pending buffer as queue mode on Enter and clears it', () => {
    const idle = parseTuiKeys(Buffer.from('hello world\r'), initialTuiState(), '');
    expect(idle.actions).toEqual([{ type: 'submit', text: 'hello world', mode: 'queue' }]);
    expect(idle.input).toBe('');

    // While a run is active the same key still queues — mode semantics belong to the reducer.
    const running = parseTuiKeys(Buffer.from('steer later\r'), runningState(), '');
    expect(running.actions).toEqual([{ type: 'submit', text: 'steer later', mode: 'queue' }]);
  });

  it('submits redirect mode only through the explicit prefix', () => {
    const parsed = parseTuiKeys(Buffer.from(`${TUI_REDIRECT_PREFIX}change of plan\r`), runningState(), '');
    expect(parsed.actions).toEqual([{ type: 'submit', text: 'change of plan', mode: 'redirect' }]);
    expect(parsed.input).toBe('');

    // The prefix must start the line: leftover buffer text keeps it a queue
    // submit so mid-line '/redirect' can never hijack a normal prompt.
    const midline = parseTuiKeys(Buffer.from(`${TUI_REDIRECT_PREFIX}change\r`), runningState(), 'seed');
    expect(midline.actions).toEqual([{ type: 'submit', text: `seed${TUI_REDIRECT_PREFIX}change`, mode: 'queue' }]);
  });

  it('ignores an empty Enter', () => {
    expect(parseTuiKeys(Buffer.from('\r\n'), initialTuiState(), '').actions).toEqual([]);
  });

  it('maps Esc, Ctrl-C, and Ctrl-D to their actions', () => {
    expect(parseTuiKeys(Buffer.from('\x1b'), initialTuiState(), '').actions).toEqual([{ type: 'esc' }]);
    expect(parseTuiKeys(Buffer.from('\x03'), initialTuiState(), '').actions).toEqual([{ type: 'ctrlC' }]);
    expect(parseTuiKeys(Buffer.from('\x04'), initialTuiState(), '').actions).toEqual([{ type: 'eof' }]);
  });

  it('consumes CSI sequences and other controls without actions or buffer pollution', () => {
    const parsed = parseTuiKeys(Buffer.from('\x1b[D\x1b[1;2A\t\x01ok'), initialTuiState(), '');
    expect(parsed.actions).toEqual([]);
    expect(parsed.input).toBe('ok');
  });

  it('edits printable characters and code-point-aware backspace, never as actions', () => {
    const typed = parseTuiKeys(Buffer.from('cat 中'), initialTuiState(), '');
    expect(typed.actions).toEqual([]);
    expect(typed.input).toBe('cat 中');

    const backspaced = parseTuiKeys(Buffer.from('\x7f'), initialTuiState(), typed.input);
    expect(backspaced.input).toBe('cat ');

    const emoji = parseTuiKeys(Buffer.from('\x08'), initialTuiState(), 'a👍');
    expect(emoji.input).toBe('a');
  });

  it('maps y/s/n to approval decisions only while approval-pending', () => {
    const pending = approvalState();
    expect(parseTuiKeys(Buffer.from('y'), pending, '').actions)
      .toEqual([{ type: 'approvalDecision', decision: 'allow-once' }]);
    expect(parseTuiKeys(Buffer.from('s'), pending, '').actions)
      .toEqual([{ type: 'approvalDecision', decision: 'allow-session' }]);
    expect(parseTuiKeys(Buffer.from('n'), pending, '').actions)
      .toEqual([{ type: 'approvalDecision', decision: 'deny' }]);

    // Outside approval-pending the same keys are ordinary buffer edits.
    const idle = parseTuiKeys(Buffer.from('syn'), initialTuiState(), '');
    expect(idle.actions).toEqual([]);
    expect(idle.input).toBe('syn');
  });

  it('processes a mixed chunk in order', () => {
    const parsed = parseTuiKeys(Buffer.from('ab\x7fc\rnext'), initialTuiState(), '');
    expect(parsed.actions).toEqual([{ type: 'submit', text: 'ac', mode: 'queue' }]);
    expect(parsed.input).toBe('next');
  });
});

describe('splitCompleteUtf8', () => {
  it('holds back a trailing incomplete multi-byte sequence', () => {
    const emoji = Buffer.from('👍');
    const first = splitCompleteUtf8(emoji.subarray(0, 2));
    expect(first.complete.length).toBe(0);
    expect(first.rest.equals(emoji.subarray(0, 2))).toBe(true);

    const second = splitCompleteUtf8(Buffer.concat([first.rest, emoji.subarray(2)]));
    expect(second.complete.equals(emoji)).toBe(true);
    expect(second.rest.length).toBe(0);
  });

  it('passes complete ASCII through untouched', () => {
    const split = splitCompleteUtf8(Buffer.from('plain\r'));
    expect(split.complete.toString('utf8')).toBe('plain\r');
    expect(split.rest.length).toBe(0);
  });
});

describe('event projection coverage', () => {
  it('covers the reducer-facing statuses used by the frame header', () => {
    // The host feeds EventBus events into the reducer; these are the statuses the frame renders.
    const stopping = reduceTui(runningState(), { type: 'esc' }).state;
    expect(renderTuiFrame(stopping, entryView([]), { columns: 80, rows: 8 })[0]).toContain('stopping');
    const needsHuman = reduceTui(runningState(), {
      type: 'runClosed',
      outcome: 'completed',
      pendingEffects: { unknown: true },
    }).state;
    expect(renderTuiFrame(needsHuman, entryView([]), { columns: 80, rows: 8 })[0]).toContain('needs-human');
    const toolRunning = reduceTui(runningState(), {
      type: 'event',
      event: {
        type: 'tool_execution_started',
        modelRunId: 'run-1',
        toolCallId: 'call-1',
        toolName: 'read',
      },
    }).state;
    const frame = renderTuiFrame(toolRunning, entryView([]), { columns: 80, rows: 8 });
    expect(frame[0]).toContain('tool-running');
    expect(frame[0]).toContain('tool read');
  });

  it('exposes a typed event import compatible with the reducer', () => {
    const event: Event = { type: 'message_delta', text: 'chunk' };
    expect(reduceTui(initialTuiState(), { type: 'event', event }).state.status).toBe('idle');
  });
});
