/**
 * tui-host — the thin terminal adapter around the pure TUI renderer (checkpoint/TUI contract §5).
 *
 * Owns raw mode, throttled full-clear redraw, resize, and the key-byte pipeline; owns NO policy:
 * parsed actions are forwarded through onAction, and reducer effects (startRun, abortRun,
 * resolveApproval, exit, appendAudit) stay with the session driver that created this host — the
 * adapter never touches AgentLoop, PermissionGate, or the audit store. Streams are injected so
 * the whole adapter runs against fakes in tests, no TTY required.
 */
import type { TuiAction, TuiState } from './tui-state.js';
import { parseTuiKeys, renderTuiFrame, splitCompleteUtf8, type TuiView } from './tui-renderer.js';

/** Redraw cap (~30fps): coalesces message_delta-driven refreshes into whole frames. */
const FRAME_MIN_INTERVAL_MS = 1000 / 30;

export interface TuiRawInput extends NodeJS.ReadableStream {
  setRawMode?(mode: boolean): void;
  isTTY?: boolean;
}

export interface TuiResizeOutput extends NodeJS.WritableStream {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}

/** The TUI exists only on a real TTY pair: raw key mode and fullscreen redraw both need one. */
export function canConstructTuiHost(input: unknown, output: unknown): boolean {
  return isTty(input) && isTty(output);
}

export interface TuiHostOptions {
  input: TuiRawInput;
  output: TuiResizeOutput;
  columns: number;
  rows: number;
  onAction(action: TuiAction): void;
  getState(): TuiState;
  getView(): TuiView;
  /** Clock seam for the redraw throttle (tests). */
  now?(): number;
}

export interface TuiHost {
  /** Enable raw mode, paint the first frame, and start listening. */
  start(): void;
  /** Schedule a throttled repaint; call after any state/view change. */
  refresh(): void;
  /** Restore cooked mode and the cursor, stop listening. Idempotent. */
  stop(): void;
}

export function createTuiHost(options: TuiHostOptions): TuiHost {
  const now = options.now ?? Date.now;
  let columns = Math.max(1, Math.floor(options.columns) || 1);
  let rows = Math.max(1, Math.floor(options.rows) || 1);
  let input = '';
  let pendingBytes: Buffer = Buffer.alloc(0);
  let started = false;
  let stopped = false;
  let rawApplied = false;
  let lastPaint = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  let scheduled = false;

  const writeFrame = (): void => {
    lastPaint = now();
    const lines = renderTuiFrame(options.getState(), { ...options.getView(), input }, { columns, rows })
      .slice(0, rows);
    // Full clear + home each frame (no line diffing); \x1b[K wipes each line's tail so shorter
    // content never leaves stale characters. The cursor stays hidden between frames.
    options.output.write(`\x1b[?25l\x1b[H\x1b[2J\x1b[3J${lines.map((line) => `${line}\x1b[K`).join('\r\n')}`);
  };

  const paint = (): void => {
    timer = undefined;
    if (stopped) {
      scheduled = false;
      return;
    }
    const wait = FRAME_MIN_INTERVAL_MS - (now() - lastPaint);
    if (wait > 0) {
      timer = setTimeout(paint, wait);
      return;
    }
    scheduled = false;
    writeFrame();
  };

  const refresh = (): void => {
    if (!started || stopped || scheduled) return;
    scheduled = true;
    const wait = Math.max(0, FRAME_MIN_INTERVAL_MS - (now() - lastPaint));
    timer = setTimeout(paint, wait);
  };

  const onData = (chunk: string | Buffer): void => {
    if (stopped) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const { complete, rest } = splitCompleteUtf8(
      pendingBytes.length === 0 ? bytes : Buffer.concat([pendingBytes, bytes]),
    );
    pendingBytes = rest;
    if (complete.length === 0) return;
    const parsed = parseTuiKeys(complete, options.getState(), input);
    input = parsed.input;
    for (const action of parsed.actions) options.onAction(action);
    refresh();
  };

  // Piped/EOF input can end without a Ctrl-D byte; the stream end is the same eof action.
  const onEnd = (): void => {
    if (!stopped) options.onAction({ type: 'eof' });
  };

  const onResize = (): void => {
    columns = Math.max(1, Math.floor(options.output.columns ?? columns) || 1);
    rows = Math.max(1, Math.floor(options.output.rows ?? rows) || 1);
    if (stopped) return;
    writeFrame(); // size changes redraw immediately, outside the throttle
  };

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      if (options.input.setRawMode !== undefined) {
        options.input.setRawMode(true);
        rawApplied = true;
      }
      options.input.on('data', onData);
      options.input.on('end', onEnd);
      options.input.on('close', onEnd);
      options.output.on('resize', onResize);
      options.input.resume();
      writeFrame();
    },
    refresh,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      options.input.removeListener('data', onData);
      options.input.removeListener('end', onEnd);
      options.input.removeListener('close', onEnd);
      options.output.removeListener('resize', onResize);
      if (rawApplied && options.input.setRawMode !== undefined) options.input.setRawMode(false);
      // Leave fullscreen below the frame, restore the cursor, and hand the line back.
      options.output.write('\r\n\x1b[?25h');
    },
  };
}

function isTty(stream: unknown): boolean {
  return typeof stream === 'object' && stream !== null && (stream as { isTTY?: unknown }).isTTY === true;
}
