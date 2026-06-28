/**
 * Approval rendering + choice parsing — the pure half of the B4 interactive approval UX
 * (plan §3.5). Like render.ts, all formatting and input interpretation lives here as pure
 * functions so it's unit-testable without a TTY; repl.ts owns only the actual read/write.
 *
 * When the PermissionGate resolves a tool call to `ask`, the REPL shows this prompt and reads
 * one line, mapping it to allow-once / allow-session / deny. A blank or unrecognized line is
 * NOT a silent yes — it re-asks; only an explicit deny (or Ctrl-C / EOF in repl.ts) denies.
 */
import type { ApprovalRequest } from '../../runtime/permission/index.js';

/** Format the approval prompt: what's being asked, its key detail, and WHY (the gate's reason). */
export function renderApprovalRequest(req: ApprovalRequest): string {
  return (
    `\n  ⚠ 需要批准: ${req.toolName} (${req.capability})\n` +
    `    ${detailOf(req)}\n` +
    `    原因: ${req.reason}\n` +
    `    [a] 本次允许   [s] 本会话允许   [d] 拒绝\n`
  );
}

/** The most relevant one-line detail for the request: a shell command, a file path, or the raw
 *  args. Truncated so a huge command can't flood the prompt. */
function detailOf(req: ApprovalRequest): string {
  const a = req.args;
  const raw =
    typeof a.command === 'string'
      ? a.command
      : typeof a.path === 'string'
        ? `路径: ${a.path}`
        : JSON.stringify(a);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/** The three choices the gate understands. */
export type ApprovalChoice = 'allow-once' | 'allow-session' | 'deny';

/** Map a typed line to a choice, or `undefined` when it's blank/unrecognized (→ re-ask). Case-
 *  and whitespace-insensitive; accepts short keys and a few natural words. A blank line is
 *  deliberately undefined (re-ask), never a silent allow OR a silent deny. */
export function parseApprovalChoice(input: string): ApprovalChoice | undefined {
  switch (input.trim().toLowerCase()) {
    case 'a':
    case 'o':
    case 'allow':
    case 'once':
    case 'allow-once':
    case 'y':
    case 'yes':
      return 'allow-once';
    case 's':
    case 'session':
    case 'allow-session':
      return 'allow-session';
    case 'd':
    case 'n':
    case 'no':
    case 'deny':
      return 'deny';
    default:
      return undefined;
  }
}
