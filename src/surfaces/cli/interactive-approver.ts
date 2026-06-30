/**
 * interactive-approver — the readline-backed PermissionGate approver shared by the goal & loop CLIs.
 *
 * Both `goal` and `loop` own a DEDICATED readline Interface (unlike the REPL, whose single `rl` also
 * reads ordinary commands and so needs its own buffered nextLine machinery). For them the approver is
 * identical, so it lives here once: render the SAME multi-line prompt the REPL shows (approval.ts's
 * renderApprovalRequest → detailOf three-some + [a]/[s]/[d]), map the typed line via
 * parseApprovalChoice, re-ask a blank/unrecognized line up to MAX_APPROVAL_RETRIES, and fail closed
 * (deny) on EOF or exhausted retries.
 *
 * Exposing `s` (allow-session) is the whole point. The PermissionGate already supports COMMAND-scoped
 * bash session grants (permission-gate.ts's bashCommandGrants — approving `git status` once unlocks
 * only that exact string, never the bash tool wholesale, and a deny is decided before any grant is
 * read), but the old goal/loop approvers only returned allow-once/deny, so that capability reached
 * the REPL alone. This hands it to attended goal/loop runs too — while an unattended loop, which
 * constructs NO approver at all, stays fail-closed on every gated call (memory restore-bash-session-allow).
 *
 * Formatting stays in approval.ts (pure, TTY-free); the loop logic here is made testable by injecting
 * ApproverIo, mirroring that same discipline.
 */
import type { Interface } from 'node:readline';
import type { Approver } from '../../runtime/permission/index.js';
import { renderApprovalRequest, parseApprovalChoice } from './approval.js';

/** Times a blank/unrecognized line is re-asked before failing closed (matches the REPL). */
export const MAX_APPROVAL_RETRIES = 3;

/** The minimal IO the approver loop needs, injected so the logic is unit-testable without a TTY
 *  (mirrors approval.ts keeping all formatting pure). `readLine` resolves null on EOF/close, which
 *  the approver treats as a fail-closed deny. */
export interface ApproverIo {
  write(text: string): void;
  readLine(prompt: string): Promise<string | null>;
}

/**
 * Build the interactive approver shared by the goal & loop CLIs. Renders the same prompt the REPL
 * does (renderApprovalRequest → detailOf + options); maps the line via parseApprovalChoice; re-asks a
 * blank/unrecognized line up to {@link MAX_APPROVAL_RETRIES}; EOF or exhausted retries → deny
 * (fail-closed, never a silent allow).
 *
 * `s` (allow-session) is offered ONLY for bash (executes-code), where the gate scopes the grant to
 * the EXACT command string (permission-gate.ts bashCommandGrants). For write/vision a session grant
 * would be TOOL-scoped (sessionGrants.add(toolName)) — a run/queue-wide write/vision exemption the old
 * goal/loop approver never gave and this slice does not intend (codex review MEDIUM). So non-bash
 * tools show [a]/[d] only and a typed `s` there is re-asked, never silently downgraded.
 *
 * Deferred (codex review HIGH): a command-scoped grant assumes "same command string == same behavior".
 * For SCHEDULER commands (npm/yarn/pnpm/bun/npx test|run, make, just, task) the string is stable but
 * the behavior lives in project files (package.json scripts, Makefile) the builder can later rewrite,
 * so an approved `npm test` could be repurposed. This is a pre-existing property of Path B
 * command-scoped grants (the REPL has it too); this slice widens its reach into autonomous goal/loop
 * (loop shares one gate across the queue). A real fix binds the grant to a behavior-file fingerprint
 * and is a permission-core change — tracked in docs/handoff-next.md (bash-allow) and memory restore-bash-session-allow.
 * Mitigation here: attended-only (the human sees the exact command at `s` time) + non-bash gets no
 * session grant at all.
 */
export function createInteractiveApprover(io: ApproverIo): Approver {
  return async (req) => {
    // Session grants are exposed only for bash (the gate scopes them per command string); see above.
    const sessionAllowed = req.capability === 'executes-code';
    io.write(renderApprovalRequest(req, { sessionAllowed }));
    const hint = sessionAllowed
      ? '    请输入 a(本次) / s(本会话) / d(拒绝)\n'
      : '    请输入 a(本次) / d(拒绝)\n';
    for (let attempt = 0; attempt < MAX_APPROVAL_RETRIES; attempt++) {
      const line = await io.readLine('    › ');
      if (line === null) return 'deny'; // EOF/closed → no human answer → fail closed
      const choice = parseApprovalChoice(line);
      if (choice === 'allow-session' && !sessionAllowed) {
        // Don't decide for the user (no silent downgrade to allow-once); re-ask within the cap.
        io.write('    会话级放行仅对 shell 命令开放，' + hint.trimStart());
        continue;
      }
      if (choice) return choice;
      io.write(hint);
    }
    return 'deny'; // exhausted retries → fail closed
  };
}

/**
 * Adapt a readline Interface into {@link ApproverIo}. readline's `question` callback never fires on
 * EOF/close, so we race it against the one-shot 'close' event and resolve null then — turning an
 * otherwise-hung approver into a fail-closed deny (the REPL handles EOF the same way via nextLine).
 */
export function readlineApproverIo(rl: Interface): ApproverIo {
  return {
    write: (text) => process.stdout.write(text),
    readLine: (prompt) =>
      new Promise<string | null>((resolve) => {
        let settled = false;
        const onClose = (): void => {
          if (settled) return;
          settled = true;
          resolve(null);
        };
        rl.once('close', onClose);
        rl.question(prompt, (answer) => {
          if (settled) return;
          settled = true;
          rl.removeListener('close', onClose);
          resolve(answer);
        });
      }),
  };
}
