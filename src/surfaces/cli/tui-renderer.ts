/**
 * Pure fullscreen TUI rendering and key parsing (checkpoint/TUI contract §4–5).
 *
 * Everything here is a pure function of (state, view, bytes): no streams, no timers, no reducer
 * calls. The reducer in tui-state.ts stays frozen — this layer only projects a TuiState plus a
 * host-fed view into frame lines and maps key bytes to TuiAction values; mode semantics (queue
 * vs redirect) and stop/exit policy stay with the reducer.
 *
 * Frame lines carry no control characters: entry/header strings pass safeInline (approval.ts),
 * and the input line is filtered twice — at key intake (parseTuiKeys drops the same control set)
 * and at render time (replace-only, so the display still mirrors the buffer) — so pasted or
 * injected text cannot smuggle ANSI escapes, extra lines, or bidi overrides into the fullscreen
 * layout.
 */
import type { TuiAction, TuiState } from './tui-state.js';
import { safeInline } from './approval.js';

/** Whether one code point is a terminal/bidi control that must never enter the
 *  input buffer — the same set safeInline strips, applied at intake so pasted
 *  text can neither execute as an escape sequence nor visually reorder the
 *  input line the way a Trojan-source path would. */
function isTerminalControlCode(code: number): boolean {
  return code < 32
    || (code >= 127 && code <= 159)
    || code === 0x2028
    || code === 0x2029
    || code === 0x200e
    || code === 0x200f
    || code === 0x061c
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069);
}

/** One message-flow row. The host appends these from EventBus / REPL events. */
export interface TuiViewEntry {
  kind: 'user' | 'assistant' | 'system' | 'error';
  text: string;
  /** Optional bounded detail (tool arguments, approval detail) shown after the text. */
  meta?: string;
  /** Streaming marker: a trailing assistant entry still accepts message_delta appends. */
  open?: boolean;
}

/** Immutable scroll buffer owned by the session driver; `input` is spliced in by the terminal
 * host (the input line is terminal state, never reducer state). */
export interface TuiView {
  entries: readonly TuiViewEntry[];
  input?: string;
}

export interface TuiFrameSize {
  columns: number;
  rows: number;
}

/** Frame lines one entry may occupy before folding truncates it (bounds long tool output). */
const MAX_ENTRY_LINES = 3;

const KIND_LABEL: Record<TuiViewEntry['kind'], string> = {
  user: 'you',
  assistant: 'jarvis',
  system: 'sys',
  error: 'err',
};

/** Explicit redirect spelling: typing this prefix + Enter submits with mode 'redirect'. */
export const TUI_REDIRECT_PREFIX = '/redirect ';

/**
 * Render one fullscreen frame as content lines (no ANSI codes — the terminal host owns those).
 * Layout: header (identity + status), message-flow window (tail-following, folded), input line,
 * key hints. Lines never exceed `columns` display cells and never contain control characters.
 */
export function renderTuiFrame(state: TuiState, view: TuiView, size: TuiFrameSize): string[] {
  const columns = Math.max(1, Math.floor(size.columns) || 1);
  const rows = Math.max(1, Math.floor(size.rows) || 1);
  const header = clipLine(headerText(state), columns);
  const input = clipLine(inputText(view.input ?? '', state), columns);
  const hint = clipLine(hintText(state), columns);
  const middleHeight = rows - 3;
  const middle = middleHeight > 0 ? renderMiddle(view.entries, columns, middleHeight) : [];
  return [header, ...middle, input, hint].slice(0, rows);
}

function headerText(state: TuiState): string {
  const parts: string[] = ['jarvis', state.status];
  if (state.runId !== undefined) parts.push(`run ${safeInline(state.runId)}`);
  if (state.tool !== undefined) parts.push(`tool ${safeInline(state.tool.toolName)}`);
  if (state.approval !== undefined) {
    const decision = state.approval.decision === undefined ? '' : ` (${state.approval.decision})`;
    parts.push(`approval ${safeInline(state.approval.requestId)}${decision}`);
  }
  if (state.redirect !== undefined) parts.push('redirect waiting');
  if (state.queue.length > 0) parts.push(`queue ${state.queue.length}`);
  return ` ${parts.join(' · ')}`;
}

function hintText(state: TuiState): string {
  switch (state.status) {
    case 'approval-pending':
      return ' y allow-once · s allow-session (bash only) · n deny · esc cancel';
    case 'stopping':
      // Esc is a no-op while stopping (frozen reducer); the way out is Ctrl-C again.
      return ' stopping · ctrl-c again exits (130) · enter queue';
    case 'model-running':
    case 'tool-running':
      return ' enter queue · "/redirect <text>" steer · esc stop · ctrl-c stop/exit';
    case 'needs-human':
      // Ctrl-C is a no-op in needs-human (frozen reducer); only eof closes from here.
      return ' pending effect needs a human · enter queue · ctrl-d exit';
    default:
      return ' enter send · "/redirect <text>" steer · ctrl-c exit';
  }
}

function inputText(input: string, state: TuiState): string {
  const label = state.status === 'approval-pending' ? 'approval' : 'input';
  // Defense in depth beyond intake filtering: replace-only (no space collapsing
  // like safeInline) so the displayed line mirrors the buffer exactly while
  // still never emitting a control character into a frame.
  const shown = Array.from(input, (ch) => (isTerminalControlCode(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('');
  // The terminal cursor is hidden while fullscreen; '_' marks the caret position.
  return ` ${label} › ${shown}_`;
}

/** Tail-following window: fold entries newest-first until the height is used, then flip the
 * order back to chronological. Older entries are dropped and marked with an ellipsis line. */
function renderMiddle(entries: readonly TuiViewEntry[], columns: number, height: number): string[] {
  const blocks: string[][] = [];
  let used = 0;
  let index = entries.length - 1;
  while (index >= 0 && used < height) {
    const lines = foldEntry(entries[index], columns);
    if (lines.length === 0) {
      index--;
      continue;
    }
    // When an entry cannot fit whole, keep its TAIL: newest detail (end of tool output) matters.
    const take = Math.min(lines.length, height - used);
    blocks.unshift(lines.slice(lines.length - take));
    used += take;
    index--;
  }
  const flat = blocks.flat();
  if (index < 0) return flat;
  return flat.length < height ? [' · · ·', ...flat] : [' · · ·', ...flat.slice(1)];
}

function foldEntry(entry: TuiViewEntry, columns: number): string[] {
  const content = safeInline(entry.text)
    + (entry.meta === undefined || entry.meta === '' ? '' : ` (${safeInline(entry.meta)})`);
  if (content === '') return [];
  const prefix = KIND_LABEL[entry.kind];
  // Continuation lines repeat the prefix indent, so EVERY wrap width must
  // reserve it — wrapping at full width would push the truncation marker off
  // the line end once the prefix is prepended.
  const contentWidth = Math.max(1, columns - prefix.length - 1);
  const lines = wrapByWidth(content, contentWidth, contentWidth, MAX_ENTRY_LINES);
  return lines.map((line, position) =>
    clipLine(position === 0 ? `${prefix} ${line}` : `${' '.repeat(prefix.length + 1)}${line}`, columns));
}

/** Width-aware wrap into at most `maxLines` lines; an overflow tail is cut and marked with '…'. */
function wrapByWidth(text: string, firstWidth: number, restWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  let width = 0;
  let limit = firstWidth;
  let truncated = false;
  for (const ch of Array.from(text)) {
    const cell = displayWidth(ch);
    if (width + cell > limit) {
      lines.push(line);
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
      line = '';
      width = 0;
      limit = restWidth;
    }
    line += ch;
    width += cell;
  }
  if (!truncated) {
    lines.push(line);
    return lines;
  }
  // Make room for the ellipsis on the last emitted line, then mark the cut.
  const last = lines[lines.length - 1] ?? '';
  let kept = '';
  let keptWidth = 0;
  for (const ch of Array.from(last)) {
    const cell = displayWidth(ch);
    if (keptWidth + cell + 1 > limit) break;
    kept += ch;
    keptWidth += cell;
  }
  lines[lines.length - 1] = `${kept}…`;
  return lines;
}

/** Truncate to `columns` display cells (hard clip, no marker — for header/input/hint lines). */
function clipLine(text: string, columns: number): string {
  let width = 0;
  let out = '';
  for (const ch of Array.from(text)) {
    const cell = displayWidth(ch);
    if (width + cell > columns) break;
    out += ch;
    width += cell;
  }
  return out;
}

/**
 * Terminal display width of one code point: CJK/emoji ranges take two cells. An approximation
 * (no full wcwidth tables) that errs toward reserving space, which at worst leaves the right
 * margin short — never wrapping a frame line onto the next row.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of Array.from(text)) width += codePointWidth(ch.codePointAt(0) ?? 0);
  return width;
}

function codePointWidth(code: number): number {
  if (code >= 0x1100 && (
    code <= 0x115f
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  )) return 2;
  return 1;
}

export interface TuiKeyParseResult {
  actions: TuiAction[];
  /** Input buffer after applying printable/backspace edits (edits are never actions). */
  input: string;
}

/**
 * Map key bytes to TuiAction values. Enter submits the pending buffer (queue mode by default;
 * the {@link TUI_REDIRECT_PREFIX} spelling submits redirect mode — the reducer owns the mode
 * semantics and never starts a redirect before runClosed). Esc/Ctrl-C/Ctrl-D become esc/ctrlC/
 * eof actions; first-vs-second Ctrl-C judgement stays in the reducer. During approval-pending,
 * y/s/n become approvalDecision actions (the driver re-checks the session-grant capability rule
 * against the live request, which the parse layer cannot see). Printables and backspace edit
 * the input buffer instead of producing actions; CSI/SS3 sequences (arrows etc.) are consumed
 * and ignored so they never leak into the buffer.
 */
export function parseTuiKeys(bytes: Buffer, state: TuiState, input: string): TuiKeyParseResult {
  const actions: TuiAction[] = [];
  let buffer = input;
  const chars = Array.from(bytes.toString('utf8'));
  let index = 0;
  while (index < chars.length) {
    const ch = chars[index];
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      const next = chars[index + 1];
      if (next === '[' || next === 'O') {
        index += 2;
        while (index < chars.length) {
          const final = chars[index].codePointAt(0) ?? 0;
          index++;
          if (final >= 0x40 && final <= 0x7e) break;
        }
        continue;
      }
      actions.push({ type: 'esc' });
      index++;
      continue;
    }
    switch (code) {
      case 0x03:
        actions.push({ type: 'ctrlC' });
        index++;
        continue;
      case 0x04:
        actions.push({ type: 'eof' });
        index++;
        continue;
      case 0x0d:
      case 0x0a: {
        const text = buffer.trim();
        buffer = '';
        if (text.startsWith(TUI_REDIRECT_PREFIX)) {
          const redirected = text.slice(TUI_REDIRECT_PREFIX.length).trim();
          if (redirected !== '') actions.push({ type: 'submit', text: redirected, mode: 'redirect' });
        } else if (text !== '') {
          actions.push({ type: 'submit', text, mode: 'queue' });
        }
        index++;
        continue;
      }
      case 0x08:
      case 0x7f:
        buffer = Array.from(buffer).slice(0, -1).join('');
        index++;
        continue;
      default:
        break;
    }
    if (code >= 0x20 && !isTerminalControlCode(code)) {
      if (state.status === 'approval-pending' && (ch === 'y' || ch === 's' || ch === 'n')) {
        actions.push({
          type: 'approvalDecision',
          decision: ch === 'y' ? 'allow-once' : ch === 's' ? 'allow-session' : 'deny',
        });
      } else {
        buffer += ch;
      }
    }
    // Remaining controls (tab, other ctrl keys, C1, bidi formatting) are dropped:
    // no action, no buffer change — they can never reach a frame line.
    index++;
  }
  return { actions, input: buffer };
}

/**
 * Split a byte chunk into the decodable UTF-8 prefix and any trailing incomplete sequence, so a
 * multi-byte character split across terminal reads is held back and completed by the next chunk
 * (decoding early would corrupt it into replacement characters).
 */
export function splitCompleteUtf8(bytes: Buffer): { complete: Buffer; rest: Buffer } {
  let index = 0;
  while (index < bytes.length) {
    const length = expectedUtf8Length(bytes[index]);
    if (index + length > bytes.length) break;
    index += length;
  }
  return { complete: bytes.subarray(0, index), rest: bytes.subarray(index) };
}

function expectedUtf8Length(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc0 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  // A continuation byte at sequence start is invalid; treat it as one unit so the scan advances
  // (it decodes to U+FFFD downstream instead of wedging the buffer).
  return 1;
}
