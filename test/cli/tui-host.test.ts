import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { initialTuiState, reduceTui, type TuiAction, type TuiEffect, type TuiState } from '../../src/surfaces/cli/tui-state.js';
import {
  canConstructTuiHost,
  createTuiHost,
  type TuiRawInput,
  type TuiResizeOutput,
} from '../../src/surfaces/cli/tui-host.js';
import { displayWidth, type TuiView } from '../../src/surfaces/cli/tui-renderer.js';

class FakeInput extends Readable {
  public readonly isTTY = true;
  public readonly rawModes: boolean[] = [];
  public setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }
  _read(): void {
    // push-driven; nothing to pull
  }
}

class FakeOutput extends Writable {
  public readonly isTTY = true;
  public columns: number;
  public rows: number;
  private readonly chunks: string[] = [];
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  public _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  public text(): string {
    return this.chunks.join('');
  }
}

function countFrames(output: FakeOutput): number {
  return output.text().split('\x1b[2J').length - 1;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal session-driver stand-in: reduces forwarded actions and records their effects, so the
 *  adapter tests exercise the same onAction contract the real driver implements. */
function harness(columns = 80, rows = 24): {
  host: ReturnType<typeof createTuiHost>;
  input: FakeInput;
  output: FakeOutput;
  actions: TuiAction[];
  effects: TuiEffect[];
  setView(view: TuiView): void;
} {
  const input = new FakeInput();
  const output = new FakeOutput(columns, rows);
  let state: TuiState = initialTuiState();
  let view: TuiView = { entries: [] };
  const actions: TuiAction[] = [];
  const effects: TuiEffect[] = [];
  const host = createTuiHost({
    input,
    output,
    columns,
    rows,
    getState: () => state,
    getView: () => view,
    onAction: (action) => {
      actions.push(action);
      const transition = reduceTui(state, action);
      state = transition.state;
      effects.push(...transition.effects);
    },
  });
  return { host, input, output, actions, effects, setView: (next) => { view = next; } };
}

describe('createTuiHost', () => {
  it('enables raw mode and paints the first frame on start; stop restores cooked mode and the cursor', () => {
    const h = harness();
    h.host.start();
    expect(h.input.rawModes[0]).toBe(true);
    expect(h.output.text()).toContain('\x1b[?25l'); // cursor hidden for fullscreen
    expect(h.output.text()).toContain('idle'); // header line from the initial state

    h.host.stop();
    expect(h.input.rawModes[h.input.rawModes.length - 1]).toBe(false);
    expect(h.output.text()).toContain('\x1b[?25h');
    expect(h.output.text()).toContain('\r\n'); // leaves the fullscreen line behind

    // Stopped means detached: keys no longer produce actions.
    h.input.push(Buffer.from('\x03'));
    expect(h.actions.length).toBe(0);
    h.host.stop(); // idempotent
    expect(h.input.rawModes.length).toBe(2);
  });

  it('forwards parsed key actions: submit, esc, ctrlC, eof', async () => {
    const h = harness();
    h.host.start();
    h.input.push(Buffer.from('hello tui\r'));
    await wait(0); // stream data events fire on the next tick
    expect(h.actions).toEqual([{ type: 'submit', text: 'hello tui', mode: 'queue' }]);

    h.input.push(Buffer.from('\x1b'));
    await wait(0);
    expect(h.actions.at(-1)).toEqual({ type: 'esc' });

    h.input.push(Buffer.from('\x04'));
    await wait(0);
    expect(h.actions.at(-1)).toEqual({ type: 'eof' });
  });

  it('maps stream end to the eof action (piped input)', async () => {
    const h = harness();
    h.host.start();
    h.input.push(null);
    await wait(0);
    expect(h.actions.some((action) => action.type === 'eof')).toBe(true);
  });

  it('renders the typed input buffer inside the frame', async () => {
    const h = harness();
    h.host.start();
    h.input.push(Buffer.from('abc'));
    await wait(80); // throttled repaint
    expect(h.output.text()).toContain('abc_'); // caret marker follows the buffer
  });

  it('walks the exit-130 path: idle Ctrl-C closes with exit 130', async () => {
    const h = harness();
    h.host.start();
    h.input.push(Buffer.from('\x03'));
    await wait(0);
    expect(h.effects).toContainEqual({ type: 'exit', code: 130 });
  });

  it('walks the exit-130 path: two Ctrl-C presses from a running state', async () => {
    const h = harness();
    h.host.start();
    h.input.push(Buffer.from('go\r')); // reducer: idle submit → model-running (+startRun effect)
    await wait(0);
    h.input.push(Buffer.from('\x03')); // first: abort + interrupt audit
    await wait(0);
    expect(h.effects).toContainEqual({ type: 'abortRun' });
    h.input.push(Buffer.from('\x03')); // second: close with 130
    await wait(0);
    expect(h.effects).toContainEqual({ type: 'exit', code: 130 });
  });

  it('repaints at the new geometry immediately on resize', () => {
    const h = harness(80, 24);
    h.host.start();
    h.setView({ entries: [{ kind: 'assistant', text: 'x'.repeat(100) }] });
    h.output.columns = 30;
    h.output.rows = 8;
    h.output.emit('resize');
    const lastFrame = h.output.text().split('\x1b[2J').at(-1) ?? '';
    // eslint-disable-next-line no-control-regex -- the escape-stripping pattern is the assertion itself
    const lines = lastFrame.split('\r\n').map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, ''));
    expect(lines.length).toBeLessThanOrEqual(8);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it('coalesces a refresh storm into throttled whole frames', async () => {
    const h = harness();
    h.host.start();
    const initial = countFrames(h.output);
    for (let index = 0; index < 20; index++) h.host.refresh();
    await wait(120);
    const painted = countFrames(h.output) - initial;
    expect(painted).toBeGreaterThanOrEqual(1);
    expect(painted).toBeLessThanOrEqual(4); // ~30fps: one coalesced frame per interval
  });
});

describe('canConstructTuiHost', () => {
  it('requires a TTY on both directions', () => {
    const ttyIn = new FakeInput() as unknown as TuiRawInput;
    const ttyOut = new FakeOutput(80, 24) as unknown as TuiResizeOutput;
    expect(canConstructTuiHost(ttyIn, ttyOut)).toBe(true);

    const plainIn = new Readable({ read() {} }) as unknown as TuiRawInput;
    expect(canConstructTuiHost(plainIn, ttyOut)).toBe(false);
    expect(canConstructTuiHost(ttyIn, plainIn)).toBe(false);
    expect(canConstructTuiHost(null, ttyOut)).toBe(false);
  });
});
