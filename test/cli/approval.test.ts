import { describe, expect, it } from 'vitest';
import { renderApprovalRequest, parseApprovalChoice, safeInline, detailOf } from '../../src/surfaces/cli/approval.js';
import type { ApprovalRequest } from '../../src/runtime/permission/index.js';

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  toolName: 'bash',
  capability: 'executes-code',
  args: { command: 'npm test' },
  reason: 'runs a shell command',
  ...over,
});

describe('renderApprovalRequest', () => {
  it('shows the tool, capability, detail, reason, and the options', () => {
    const text = renderApprovalRequest(req());
    expect(text).toContain('bash');
    expect(text).toContain('executes-code');
    expect(text).toContain('npm test');
    expect(text).toContain('runs a shell command');
    expect(text).toContain('[a]');
    expect(text).toContain('[d]');
  });

  it('shows a file path for a file tool', () => {
    expect(renderApprovalRequest(req({ toolName: 'write', capability: 'writes-files', args: { path: 'src/a.ts' } }))).toContain('src/a.ts');
  });

  it('truncates a huge command so it cannot flood the prompt', () => {
    const text = renderApprovalRequest(req({ args: { command: 'x'.repeat(500) } }));
    expect(text).toContain('…');
  });

  it('shows [s] by default (REPL parity)', () => {
    expect(renderApprovalRequest(req())).toContain('[s]');
  });

  it('omits [s] when sessionAllowed is false (non-bash tools in goal/loop)', () => {
    const text = renderApprovalRequest(req({ toolName: 'write', capability: 'writes-files', args: { path: 'a.ts' } }), {
      sessionAllowed: false,
    });
    expect(text).toContain('[a]');
    expect(text).toContain('[d]');
    expect(text).not.toContain('[s]');
  });
});

describe('safeInline (terminal-injection guard)', () => {
  const ESC = String.fromCharCode(27);
  it('maps control chars (ESC, newline, tab) to a space and collapses runs', () => {
    expect(safeInline(`a${ESC}[31mred`)).toBe('a [31mred'); // ESC stripped — no ANSI color injected
    expect(safeInline('line1\nline2')).toBe('line1 line2'); // newline can't add a banner line
    expect(safeInline(`a${String.fromCharCode(0x2028)}b`)).toBe('a b'); // U+2028 line separator too
    expect(safeInline(`a${String.fromCharCode(0x202e)}b`)).toBe('a b'); // U+202E RLO — no visual reorder
    expect(safeInline('a\t\tb')).toBe('a b');
  });
  it('leaves ordinary text + unicode intact and trims the ends', () => {
    expect(safeInline('  doubao-vision-pro  ')).toBe('doubao-vision-pro');
    expect(safeInline('路径: src/a.png')).toBe('路径: src/a.png');
  });
});

describe('detailOf', () => {
  it('shows a vision call image + question, so a network egress is approved knowing what leaves', () => {
    const d = detailOf(req({ toolName: 'vision', capability: 'network', args: { image: 'private.png', question: 'describe it' } }));
    expect(d).toContain('private.png');
    expect(d).toContain('describe it');
  });
  it('sanitizes control chars in a command detail (no terminal injection)', () => {
    const ESC = String.fromCharCode(27);
    const d = detailOf(req({ args: { command: `echo${ESC}[2Khi` } }));
    expect(d).not.toContain(ESC);
    expect(d).toContain('echo');
  });
  it('truncates a huge value so it cannot flood the prompt', () => {
    expect(detailOf(req({ args: { command: 'x'.repeat(500) } }))).toContain('…');
  });

  it('vision: a decoy command or padding arg cannot hide the image egress target', () => {
    // tool-aware: a prompt-injected builder adds a fake `command` (Zod strips it before the call) —
    // the prompt must still show the image that actually leaves the machine, not the decoy.
    const decoy = detailOf(req({ toolName: 'vision', capability: 'network', args: { command: 'npm test', image: 'private.png', question: 'q' } }));
    expect(decoy).toContain('private.png');
    expect(decoy).not.toContain('npm test');
    // a long leading field can't shove the image past truncation either.
    const padded = detailOf(req({ toolName: 'vision', capability: 'network', args: { pad: 'x'.repeat(300), image: 'secret.png', question: 'q' } }));
    expect(padded).toContain('secret.png');
  });

  it('write: a decoy command arg cannot hide the real path', () => {
    const d = detailOf(req({ toolName: 'write', capability: 'writes-files', args: { command: 'echo hi', path: 'out.txt' } }));
    expect(d).toContain('out.txt');
    expect(d).not.toContain('echo hi');
  });

  it('vision/write show the FULL target — a long path cannot hide its basename past truncation', () => {
    const longImage = `deep/${'a'.repeat(260)}/secret.png`;
    expect(detailOf(req({ toolName: 'vision', capability: 'network', args: { image: longImage, question: 'q' } }))).toContain('secret.png');
    const longPath = `deep/${'b'.repeat(260)}/target.ts`;
    expect(detailOf(req({ toolName: 'write', capability: 'writes-files', args: { path: longPath } }))).toContain('target.ts');
  });
});

describe('parseApprovalChoice', () => {
  it('maps allow-once forms', () => {
    for (const s of ['a', 'A', ' allow ', 'o', 'once', 'y', 'yes']) {
      expect(parseApprovalChoice(s)).toBe('allow-once');
    }
  });

  it('maps allow-session forms', () => {
    for (const s of ['s', 'session', 'allow-session']) expect(parseApprovalChoice(s)).toBe('allow-session');
  });

  it('maps deny forms', () => {
    for (const s of ['d', 'n', 'no', 'deny', 'DENY']) expect(parseApprovalChoice(s)).toBe('deny');
    expect(parseApprovalChoice(`d wording is inaccurate\n${'x'.repeat(300)}`)).toEqual({
      decision: 'deny',
      reason: `wording is inaccurate ${'x'.repeat(218)}`,
    });
  });

  it('returns undefined (re-ask) for blank or unrecognized — never a silent allow/deny', () => {
    for (const s of ['', '   ', 'maybe', 'q']) expect(parseApprovalChoice(s)).toBeUndefined();
  });
});
