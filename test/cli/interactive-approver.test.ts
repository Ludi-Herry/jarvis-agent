import { describe, expect, it } from 'vitest';
import {
  createInteractiveApprover,
  readlineApproverIo,
  MAX_APPROVAL_RETRIES,
  type ApproverIo,
} from '../../src/surfaces/cli/interactive-approver.js';
import type { ApprovalRequest } from '../../src/runtime/permission/index.js';
import type { Interface } from 'node:readline';
import { EventEmitter } from 'node:events';

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  toolName: 'bash',
  capability: 'executes-code',
  args: { command: 'git status' },
  reason: 'runs a shell command',
  ...over,
});

/** A scripted ApproverIo: readLine pops the next queued line (null = EOF once drained), write
 *  collects everything shown to the user — so the loop logic is exercised without a TTY. */
function scriptedIo(lines: (string | null)[]): { io: ApproverIo; written: string[] } {
  const written: string[] = [];
  const queue = [...lines];
  const io: ApproverIo = {
    write: (text) => {
      written.push(text);
    },
    readLine: async () => {
      const next = queue.shift();
      return next === undefined ? null : next; // drained → EOF
    },
  };
  return { io, written };
}

describe('createInteractiveApprover', () => {
  it('maps a → allow-once and d → deny', async () => {
    expect(await createInteractiveApprover(scriptedIo(['a']).io)(req())).toBe('allow-once');
    expect(await createInteractiveApprover(scriptedIo(['d']).io)(req())).toBe('deny');
  });

  it('exposes s → allow-session — the whole point, so the command-scoped bash grant reaches goal/loop', async () => {
    expect(await createInteractiveApprover(scriptedIo(['s']).io)(req())).toBe('allow-session');
  });

  it('re-asks a blank/unrecognized line, then honors the next valid choice', async () => {
    const { io, written } = scriptedIo(['', 's']);
    expect(await createInteractiveApprover(io)(req())).toBe('allow-session');
    expect(written.some((w) => w.includes('a(本次)'))).toBe(true); // a re-ask hint was shown
  });

  it('fails closed (deny) after MAX_APPROVAL_RETRIES unrecognized lines — never a silent allow', async () => {
    const garbage = Array.from({ length: MAX_APPROVAL_RETRIES }, () => 'maybe');
    expect(await createInteractiveApprover(scriptedIo(garbage).io)(req())).toBe('deny');
  });

  it('fails closed (deny) on EOF/closed input (readLine → null), even after some blanks', async () => {
    expect(await createInteractiveApprover(scriptedIo([null]).io)(req())).toBe('deny');
    expect(await createInteractiveApprover(scriptedIo(['', null]).io)(req())).toBe('deny');
  });

  it('bash: shows [s] and the detailOf command (approval three-some reused)', async () => {
    const { io, written } = scriptedIo(['a']);
    await createInteractiveApprover(io)(req()); // bash / executes-code
    const shown = written.join('');
    expect(shown).toContain('[s]'); // session option offered for bash
    expect(shown).toContain('git status'); // detailOf shows the command
  });

  it('non-bash: hides [s], re-asks an `s`, then honors a following `a` — no TOOL-scoped session escapes', async () => {
    // A typed `s` on a vision call must NOT become allow-session (that would be a queue-wide vision
    // exemption); it is re-asked, and a following `a` is honored. detailOf still shows the egress target.
    const { io, written } = scriptedIo(['s', 'a']);
    const verdict = await createInteractiveApprover(io)(
      req({ toolName: 'vision', capability: 'network', args: { image: 'secret.png', question: 'q' } }),
    );
    expect(verdict).toBe('allow-once'); // never allow-session for a non-bash tool
    const shown = written.join('');
    expect(shown).not.toContain('[s]'); // session option not offered for non-bash
    expect(shown).toContain('secret.png'); // detailOf still shows the egress target
    expect(shown).toContain('shell 命令'); // "session only for shell commands" hint
  });

  it('non-bash: an `s` is never accepted as allow-session, even repeated → fails closed (deny)', async () => {
    const { io } = scriptedIo(['s', 's', 's']); // 3× s on a write → exhausted → deny, never a session grant
    const verdict = await createInteractiveApprover(io)(
      req({ toolName: 'write', capability: 'writes-files', args: { path: 'out.txt' } }),
    );
    expect(verdict).toBe('deny');
  });
});

/** A minimal readline-Interface stand-in: EventEmitter (for once/removeListener) + a question that
 *  parks the callback until we answer or emit 'close'. */
function fakeRl(): { rl: Interface; answer: (text: string) => void; close: () => void } {
  const emitter = new EventEmitter();
  let pending: ((answer: string) => void) | null = null;
  const rl = Object.assign(emitter, {
    question: (_prompt: string, cb: (answer: string) => void) => {
      pending = cb;
    },
  }) as unknown as Interface;
  return { rl, answer: (text) => pending?.(text), close: () => emitter.emit('close') };
}

describe('readlineApproverIo', () => {
  it('resolves the answered line', async () => {
    const f = fakeRl();
    const p = readlineApproverIo(f.rl).readLine('> ');
    f.answer('s');
    expect(await p).toBe('s');
  });

  it('resolves null when input closes before an answer (EOF → fail-closed deny upstream)', async () => {
    const f = fakeRl();
    const p = readlineApproverIo(f.rl).readLine('> ');
    f.close();
    expect(await p).toBeNull();
  });
});
