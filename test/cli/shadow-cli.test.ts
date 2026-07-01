import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { runShadowCli, type ShadowCliShadow } from '../../src/surfaces/cli/shadow-cli.js';

function inputOf(lines: string[]): Readable {
  const r = new Readable({ read() {} });
  r.push(lines.map((line) => `${line}\n`).join(''));
  r.push(null);
  return r;
}

function sink(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function fakeShadow(): ShadowCliShadow & { restores: string[] } {
  const restores: string[] = [];
  return {
    restores,
    log: async () => [],
    restore: async (ref) => {
      restores.push(ref);
      return { ok: true };
    },
  };
}

describe('shadow-cli restore confirmation', () => {
  it('fails closed on EOF and does not restore', async () => {
    const shadow = fakeShadow();
    const out = sink();
    const err = sink();

    const code = await runShadowCli({
      argv: ['restore', 'abc123'],
      cwd: 'H:/repo',
      shadow,
      input: inputOf([]),
      output: out.stream,
      error: err.stream,
    });

    expect(code).toBe(1);
    expect(shadow.restores).toEqual([]);
    expect(out.text()).toContain('需要批准');
    expect(err.text()).toMatch(/已取消|拒绝/);
  });

  it.each(['', 'maybe', 's', 'allow-session'])('fails closed on non-allow answer %j and does not expose session allow', async (answer) => {
    const shadow = fakeShadow();
    const out = sink();
    const err = sink();

    const code = await runShadowCli({
      argv: ['restore', 'abc123'],
      cwd: 'H:/repo',
      shadow,
      input: inputOf([answer]),
      output: out.stream,
      error: err.stream,
    });

    expect(code).toBe(1);
    expect(shadow.restores).toEqual([]);
    expect(out.text()).toContain('[a] 本次允许');
    expect(out.text()).not.toContain('[s]');
    expect(err.text()).toMatch(/已取消|拒绝/);
  });

  it('restores only after an explicit allow answer', async () => {
    const shadow = fakeShadow();
    const out = sink();
    const err = sink();

    const code = await runShadowCli({
      argv: ['restore', 'abc123'],
      cwd: 'H:/repo',
      shadow,
      input: inputOf(['yes']),
      output: out.stream,
      error: err.stream,
    });

    expect(code).toBe(0);
    expect(shadow.restores).toEqual(['abc123']);
    expect(out.text()).toContain('已把工作树恢复到 abc123');
    expect(err.text()).toBe('');
  });
});
