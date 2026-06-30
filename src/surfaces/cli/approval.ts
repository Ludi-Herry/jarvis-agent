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

/**
 * Make a value safe to splice into a single-line terminal prompt or banner: map every control
 * character (C0 0–31, DEL 127, C1 128–159 — so ESC and newlines included) to a space, then
 * collapse runs of spaces. A model- or env-derived string (a vision image path, an attacker-
 * authored model id) then cannot inject ANSI escapes or extra lines into the terminal / a log.
 * Implemented by code point (no literal control chars in this source) and shared by detailOf and
 * the CLI startup banners.
 */
export function safeInline(s: string): string {
  return Array.from(s, (ch) => {
    const c = ch.codePointAt(0) ?? 32;
    // Map to a space:
    //  - C0 (0–31), DEL (127), C1 (128–159) — covers ESC and CR/LF;
    //  - U+2028/U+2029 line/paragraph separators a terminal/log may treat as a new line;
    //  - the Unicode bidi formatting controls (LRM/RLM/ALM, the embeddings/overrides U+202A–U+202E,
    //    and the isolates U+2066–U+2069) — without these an RLO in a path can visually REORDER the
    //    approval line to spoof which target is being approved (Trojan-source-style).
    const stripped =
      c < 32 ||
      (c >= 127 && c <= 159) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x200e ||
      c === 0x200f ||
      c === 0x061c ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069);
    return stripped ? ' ' : ch;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}

/**
 * One-line detail of the call for the approval prompt, safeInline-d (no terminal injection) and
 * truncated (can't flood the prompt). Exported so the goal/loop approvers show the same detail the
 * REPL does — without it a network `vision` call would be approved blind, the image path unseen.
 *
 * Rendered BY TOOL (req.toolName), not by whichever arg key happens to be present: a prompt-injected
 * builder controls the raw args and could otherwise hide the real side effect behind a decoy key (a
 * fake `command` on a vision call so the prompt shows the command, not the image) or a padding field
 * that shoves the real arg past the truncation. Zod strips those decoys before the call runs, so this
 * prompt is the ONLY place a human could be misled. Only ask-gated tools reach an approver
 * (vision=network, write=writes-files, bash=executes-code); read/grep are allowed without asking.
 */
export function detailOf(req: ApprovalRequest): string {
  const a = req.args;
  const str = (v: unknown): string => safeInline(typeof v === 'string' ? v : '');
  const trunc = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);
  switch (req.toolName) {
    case 'vision':
      // The image is the EGRESS target and the gate does NOT inspect it (network is a flat `ask`), so
      // this prompt is the only place a human sees what leaves the machine — show it in FULL, never
      // truncated (a cut tail could hide the real basename). The question is non-critical → truncated.
      return `image: ${str(a.image) || '(missing)'} · question: ${trunc(str(a.question), 120)}`;
    case 'write':
      // Show the write target path in FULL too: the gate already denied sensitive paths, but a cut
      // tail must not hide the real basename of what is being written.
      return `路径: ${str(a.path) || '(missing)'}`;
    case 'bash':
      // The command is analyzed by the gate on its FULL text (dangerous/secret forms are denied before
      // this prompt), so truncating only the DISPLAY here is safe — it just bounds the prompt length.
      return trunc(str(a.command), 400) || '(missing command)';
    default:
      return trunc(str(JSON.stringify(a)), 400);
  }
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
