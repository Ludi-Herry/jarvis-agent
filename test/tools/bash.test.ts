import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool, defaultShellPath } from '../../src/core/tools/bash.js';
import type { ToolRunCtx } from '../../src/core/tools/types.js';

// B3 exercises the REAL execution layer, so it runs real bash. Resolve it once; the suite is
// meaningless without a shell to run.
const shellPath = defaultShellPath();
const bash = createBashTool({ shellPath, defaultTimeoutMs: 10_000 });

let dir: string;
let ctx: ToolRunCtx;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bash-tool-'));
  ctx = { cwd: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bash tool — execution', () => {
  it('runs a command and returns its stdout', async () => {
    const out = await bash.run({ command: 'echo hello-from-bash' }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.content).toContain('hello-from-bash');
  });

  it('declares the executes-code capability (so the gate routes it through the parser)', () => {
    expect(bash.capability).toBe('executes-code');
  });

  it('merges stderr into the output', async () => {
    const out = await bash.run({ command: 'echo to-stderr 1>&2' }, ctx);
    expect(out.content).toContain('to-stderr');
  });

  it('surfaces a non-zero exit code as a result (not an error/throw)', async () => {
    const out = await bash.run({ command: 'echo partial; exit 3' }, ctx);
    expect(out.error).toBeUndefined(); // a command failure is a readable result, not an infra error
    expect(out.content).toContain('partial');
    expect(out.content).toContain('exit code: 3');
  });

  it('runs in the injected cwd (confinement anchor)', async () => {
    // Write a file via a RELATIVE path; it must land inside the injected cwd, nowhere else.
    const out = await bash.run({ command: 'echo data > out.txt' }, ctx);
    expect(out.error).toBeUndefined();
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toContain('data');
  });

  it('reports no output cleanly', async () => {
    const out = await bash.run({ command: 'true' }, ctx);
    expect(out.content).toBe('(no output)');
  });

  it('kills a command that exceeds its timeout', async () => {
    const start = Date.now();
    const out = await bash.run({ command: 'sleep 30', timeout_ms: 1_000 }, ctx);
    const elapsed = Date.now() - start;
    expect(out.content).toContain('timed out');
    expect(elapsed).toBeLessThan(10_000); // it was killed near the deadline, not after 30s
  }, 15_000);

  it('returns an error result when the shell cannot be started', async () => {
    const broken = createBashTool({ shellPath: join(dir, 'no-such-bash.exe') });
    const out = await broken.run({ command: 'echo x' }, ctx);
    expect(out.error).toMatch(/Failed to start shell/);
  });

  it('aborts a running command via the signal and settles promptly', async () => {
    const ac = new AbortController();
    const start = Date.now();
    const p = bash.run({ command: 'sleep 30', timeout_ms: 30_000 }, { cwd: dir, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 200)); // let the process start
    ac.abort();
    const out = await p;
    expect(out.content).toContain('aborted');
    expect(Date.now() - start).toBeLessThan(10_000); // settled near the abort, not at the 30s timeout
  }, 15_000);
});
