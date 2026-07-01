import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookRunner, resolveHooks, HOOK_TIMEOUT_MS, HOOK_MAX_OUTPUT, type RunHookCommand } from '../../../src/capabilities/hooks/hook-runner.js';
import type { HookConfig } from '../../../src/capabilities/hooks/hook-config.js';
import { defaultShellPath, type ExecResult } from '../../../src/core/tools/run-command.js';
import type { ToolCall, ToolResult } from '../../../src/core/types.js';

/** Build an ExecResult with sensible defaults; override `code`/`output`/`timedOut` per test. */
function execResult(over: Partial<ExecResult> = {}): ExecResult {
  return { output: '', code: 0, timedOut: false, aborted: false, truncated: false, ...over };
}

/** A fake runCommand that returns a scripted result per call (last repeats) and records every call. */
function fakeRun(results: ExecResult[]): RunHookCommand & { calls: Parameters<RunHookCommand>[] } {
  const calls: Parameters<RunHookCommand>[] = [];
  const fn = ((...args: Parameters<RunHookCommand>) => {
    calls.push(args);
    return Promise.resolve(results[Math.min(calls.length - 1, results.length - 1)]);
  }) as RunHookCommand & { calls: Parameters<RunHookCommand>[] };
  fn.calls = calls;
  return fn;
}

const cfg = (over: Partial<HookConfig> = {}): HookConfig => ({
  PreToolUse: [],
  PostToolUse: [],
  RoundStart: [],
  RoundEnd: [],
  SessionStart: [],
  SessionEnd: [],
  ...over,
});
const deps = (run: RunHookCommand) => ({ shellPath: '/bin/sh', cwd: '/work', run });
const bashCall: ToolCall = { id: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' };
const okResult: ToolResult = { callId: 'c1', content: 'hi' };

describe('HookRunner — PreToolUse (fail-closed block)', () => {
  it('BLOCKS the call when a matching hook exits non-zero', async () => {
    const run = fakeRun([execResult({ code: 1, output: 'policy says no' })]);
    const runner = createHookRunner(cfg({ PreToolUse: [{ matcher: 'bash', command: 'guard' }] }), deps(run));
    const verdict = await runner.preToolUse(bashCall, 'executes-code');
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/PreToolUse hook blocked \(exit 1\)/);
    expect(verdict.reason).toContain('policy says no'); // the hook's output is fed back
  });

  it('BLOCKS on a timeout (code === null) — the safe default is deny', async () => {
    const run = fakeRun([execResult({ code: null, timedOut: true })]);
    const runner = createHookRunner(cfg({ PreToolUse: [{ matcher: '*', command: 'slow' }] }), deps(run));
    const verdict = await runner.preToolUse(bashCall, 'executes-code');
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/exit timeout/);
  });

  it('ALLOWS (does not block) when the hook exits 0', async () => {
    const run = fakeRun([execResult({ code: 0 })]);
    const runner = createHookRunner(cfg({ PreToolUse: [{ matcher: 'bash', command: 'guard' }] }), deps(run));
    expect(await runner.preToolUse(bashCall, 'executes-code')).toEqual({ blocked: false, reason: '' });
  });

  it('does not run a hook whose matcher does not match the tool', async () => {
    const run = fakeRun([execResult({ code: 1 })]); // would block IF it ran
    const runner = createHookRunner(cfg({ PreToolUse: [{ matcher: 'write', command: 'guard' }] }), deps(run));
    const verdict = await runner.preToolUse(bashCall, 'executes-code');
    expect(verdict.blocked).toBe(false);
    expect(run.calls).toHaveLength(0); // never invoked — bash ≠ write
  });

  it('short-circuits on the FIRST non-zero hook (does not run later ones)', async () => {
    const run = fakeRun([execResult({ code: 1 }), execResult({ code: 0 })]);
    const runner = createHookRunner(
      cfg({ PreToolUse: [{ matcher: '*', command: 'first' }, { matcher: '*', command: 'second' }] }),
      deps(run),
    );
    expect((await runner.preToolUse(bashCall, 'executes-code')).blocked).toBe(true);
    expect(run.calls).toHaveLength(1); // second hook never ran
  });

  it('runs every matching hook when each passes', async () => {
    const run = fakeRun([execResult({ code: 0 }), execResult({ code: 0 })]);
    const runner = createHookRunner(
      cfg({ PreToolUse: [{ matcher: '*', command: 'a' }, { matcher: '*', command: 'b' }] }),
      deps(run),
    );
    expect((await runner.preToolUse(bashCall, 'executes-code')).blocked).toBe(false);
    expect(run.calls).toHaveLength(2);
  });
});

describe('HookRunner — reuses the hardened runCommand (invariant #4)', () => {
  it('passes scrubSecretEnv, the hook timeout, and JARVIS_HOOK_* context env', async () => {
    const run = fakeRun([execResult({ code: 0 })]);
    const runner = createHookRunner(cfg({ PreToolUse: [{ matcher: 'bash', command: 'guard' }] }), deps(run));
    await runner.preToolUse(bashCall, 'executes-code');
    const [shellPath, command, cwd, timeoutMs, , , options] = run.calls[0];
    expect(shellPath).toBe('/bin/sh');
    expect(command).toBe('guard');
    expect(cwd).toBe('/work');
    expect(timeoutMs).toBe(HOOK_TIMEOUT_MS);
    expect(options?.scrubSecretEnv).toBe(true); // hooks can't be a key-exfil side channel
    expect(options?.extraEnv).toMatchObject({
      JARVIS_HOOK_EVENT: 'PreToolUse',
      JARVIS_HOOK_TOOL: 'bash',
      JARVIS_HOOK_TOOL_INPUT: '{"command":"echo hi"}',
    });
  });
});

describe('HookRunner — PostToolUse (advisory feedback, slice-2)', () => {
  it('returns the hook stdout as feedback — exit code ignored (advisory), never blocks', async () => {
    const run = fakeRun([execResult({ code: 1, output: 'post failed' })]); // non-zero is ignored — advisory
    const runner = createHookRunner(cfg({ PostToolUse: [{ matcher: 'bash', command: 'notify' }] }), deps(run));
    await expect(runner.postToolUse(bashCall, okResult)).resolves.toBe('post failed');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0][6]?.extraEnv).toMatchObject({ JARVIS_HOOK_EVENT: 'PostToolUse' });
  });

  it('passes the observed tool result to PostToolUse hooks as valid JSON env', async () => {
    const run = fakeRun([execResult({ code: 0, output: 'noted' })]);
    const runner = createHookRunner(cfg({ PostToolUse: [{ matcher: 'bash', command: 'inspect-result' }] }), deps(run));
    await runner.postToolUse(bashCall, { callId: 'c1', content: '', error: 'boom' });
    const raw = run.calls[0][6]?.extraEnv?.JARVIS_HOOK_TOOL_RESULT ?? '';
    expect(JSON.parse(raw)).toEqual({ callId: 'c1', content: '', error: 'boom' });
  });

  it('replaces an over-cap tool result env with a VALID-JSON truncation sentinel', async () => {
    const run = fakeRun([execResult({ code: 0, output: 'noted' })]);
    const runner = createHookRunner(cfg({ PostToolUse: [{ matcher: '*', command: 'inspect-result' }] }), deps(run));
    await runner.postToolUse(bashCall, { callId: 'c1', content: 'x'.repeat(5000) });
    const raw = run.calls[0][6]?.extraEnv?.JARVIS_HOOK_TOOL_RESULT ?? '';
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toMatchObject({ _jarvis_truncated: true });
  });

  it('returns undefined when the hook printed nothing (a silent formatter does not speak)', async () => {
    const run = fakeRun([execResult({ code: 0, output: '   \n  ' })]); // whitespace-only → nothing to say
    const runner = createHookRunner(cfg({ PostToolUse: [{ matcher: '*', command: 'fmt' }] }), deps(run));
    await expect(runner.postToolUse(bashCall, okResult)).resolves.toBeUndefined();
  });

  it('joins the NON-EMPTY stdout of several matching hooks (empty ones contribute nothing)', async () => {
    const run = fakeRun([execResult({ output: 'a' }), execResult({ output: '' }), execResult({ output: 'b' })]);
    const runner = createHookRunner(
      cfg({ PostToolUse: [{ matcher: '*', command: '1' }, { matcher: '*', command: '2' }, { matcher: '*', command: '3' }] }),
      deps(run),
    );
    await expect(runner.postToolUse(bashCall, okResult)).resolves.toBe('a\nb');
    expect(run.calls).toHaveLength(3); // all three ran (advisory; no short-circuit)
  });

  it('caps the combined feedback at HOOK_MAX_OUTPUT so several hooks cannot flood the context', async () => {
    const run = fakeRun([execResult({ output: 'x'.repeat(9000) })]);
    const runner = createHookRunner(cfg({ PostToolUse: [{ matcher: '*', command: 'big' }] }), deps(run));
    const out = await runner.postToolUse(bashCall, okResult);
    expect(out?.length).toBe(HOOK_MAX_OUTPUT);
  });

  it('swallows a throwing runner (observability must not break the observed tool) → undefined', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom')) as unknown as RunHookCommand;
    const runner = createHookRunner(cfg({ PostToolUse: [{ matcher: '*', command: 'x' }] }), deps(run));
    await expect(runner.postToolUse(bashCall, okResult)).resolves.toBeUndefined();
  });

  it('uses a per-hook timeout override when configured', async () => {
    const run = fakeRun([execResult({ code: 0, output: 'ok' })]);
    const runner = createHookRunner(cfg({ PostToolUse: [{ matcher: '*', command: 'slow-check', timeoutMs: 1234 }] }), deps(run));
    await runner.postToolUse(bashCall, okResult);
    expect(run.calls[0][3]).toBe(1234);
  });
});

describe('HookRunner — hardening (codex 2026-06-30 review)', () => {
  it('replaces an over-cap tool input with a VALID-JSON truncation sentinel (no broken JSON)', async () => {
    const run = fakeRun([execResult({ code: 0 })]);
    const big = JSON.stringify({ path: 'x.txt', content: 'y'.repeat(5000) }); // > 4096 cap
    const runner = createHookRunner(cfg({ PreToolUse: [{ matcher: '*', command: 'g' }] }), deps(run));
    await runner.preToolUse({ id: 'c', name: 'write', arguments: big }, 'writes-files');
    const input = run.calls[0][6]?.extraEnv?.JARVIS_HOOK_TOOL_INPUT ?? '';
    expect(() => JSON.parse(input)).not.toThrow(); // a JSON.parse'ing hook must not choke
    expect(JSON.parse(input)).toMatchObject({ _jarvis_truncated: true });
  });

  it('surfaces a spawn error (hook process could not start) in the block reason', async () => {
    const run = fakeRun([execResult({ code: null, spawnError: 'spawn /bin/guard ENOENT' })]);
    const runner = createHookRunner(cfg({ PreToolUse: [{ matcher: '*', command: 'g' }] }), deps(run));
    const verdict = await runner.preToolUse(bashCall, 'executes-code');
    expect(verdict.blocked).toBe(true); // spawn failure is still fail-closed
    expect(verdict.reason).toContain('ENOENT');
  });

  it('matches a prefix wildcard matcher (linear matcher, no ReDoS)', async () => {
    const hit = fakeRun([execResult({ code: 1 })]);
    const r1 = createHookRunner(cfg({ PreToolUse: [{ matcher: 're*', command: 'g' }] }), deps(hit));
    expect((await r1.preToolUse({ id: 'c', name: 'read', arguments: '{}' }, 'read-only')).blocked).toBe(true);

    const miss = fakeRun([execResult({ code: 1 })]);
    const r2 = createHookRunner(cfg({ PreToolUse: [{ matcher: 're*', command: 'g' }] }), deps(miss));
    expect((await r2.preToolUse({ id: 'c', name: 'write', arguments: '{}' }, 'writes-files')).blocked).toBe(false);
    expect(miss.calls).toHaveLength(0); // write ≠ re*
  });
});

describe('HookRunner — lifecycle hooks (advisory)', () => {
  it('runs SessionStart / SessionEnd / RoundStart / RoundEnd hooks with event env', async () => {
    const run = fakeRun([execResult(), execResult(), execResult(), execResult()]);
    const runner = createHookRunner(
      cfg({
        SessionStart: [{ matcher: '*', command: 'session-start' }],
        SessionEnd: [{ matcher: '*', command: 'session-end' }],
        RoundStart: [{ matcher: '*', command: 'round-start' }],
        RoundEnd: [{ matcher: '*', command: 'round-end' }],
      }),
      deps(run),
    );

    await runner.sessionStart();
    await runner.sessionEnd();
    await runner.roundStart();
    await runner.roundEnd();

    expect(run.calls.map((c) => c[1])).toEqual(['session-start', 'session-end', 'round-start', 'round-end']);
    expect(run.calls.map((c) => c[6]?.extraEnv?.JARVIS_HOOK_EVENT)).toEqual(['SessionStart', 'SessionEnd', 'RoundStart', 'RoundEnd']);
  });

  it('swallows lifecycle hook failures (consulting only, never blocks)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom')) as unknown as RunHookCommand;
    const runner = createHookRunner(cfg({ RoundStart: [{ matcher: '*', command: 'explode' }] }), deps(run));
    await expect(runner.roundStart()).resolves.toBeUndefined();
  });

  it('uses per-hook timeoutMs for lifecycle hooks too', async () => {
    const run = fakeRun([execResult()]);
    const runner = createHookRunner(cfg({ SessionStart: [{ matcher: '*', command: 'slow-session', timeoutMs: 2345 }] }), deps(run));
    await runner.sessionStart();
    expect(run.calls[0][3]).toBe(2345);
  });
});

describe('HookRunner — real shell smoke', () => {
  it('PostToolUse can read JARVIS_HOOK_TOOL_RESULT from env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-hook-result-'));
    const runner = createHookRunner(
      cfg({ PostToolUse: [{ matcher: 'bash', command: 'printf %s "$JARVIS_HOOK_TOOL_RESULT"' }] }),
      { shellPath: defaultShellPath(), cwd },
    );
    const out = await runner.postToolUse(bashCall, { callId: 'c1', content: 'hello-result' });
    expect(JSON.parse(out ?? '')).toEqual({ callId: 'c1', content: 'hello-result' });
  });

  it('PostToolUse result env uses a valid JSON sentinel when over cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-hook-result-big-'));
    const runner = createHookRunner(
      cfg({ PostToolUse: [{ matcher: 'bash', command: 'printf %s "$JARVIS_HOOK_TOOL_RESULT"' }] }),
      { shellPath: defaultShellPath(), cwd },
    );
    const out = await runner.postToolUse(bashCall, { callId: 'c1', content: 'x'.repeat(5000) });
    expect(JSON.parse(out ?? '')).toMatchObject({ _jarvis_truncated: true });
  });

  it('PreToolUse timeoutMs kills a slow real hook and blocks fail-closed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-hook-timeout-'));
    const runner = createHookRunner(
      cfg({ PreToolUse: [{ matcher: 'bash', command: 'sleep 5', timeoutMs: 1000 }] }),
      { shellPath: defaultShellPath(), cwd },
    );
    const verdict = await runner.preToolUse(bashCall, 'executes-code');
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('exit timeout');
  });

  it('resolveHooks merges user-home and JARVIS_HOOKS sources in order', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-hook-merge-cwd-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'jarvis-hook-merge-src-'));
    const homeHooks = join(sourceDir, 'home-hooks.json');
    const envHooks = join(sourceDir, 'env-hooks.json');
    await writeFile(homeHooks, JSON.stringify({ PostToolUse: [{ matcher: 'bash', command: 'printf home' }] }), 'utf8');
    await writeFile(envHooks, JSON.stringify({ PostToolUse: [{ matcher: 'bash', command: 'printf env' }] }), 'utf8');

    const { hooks, warning } = await resolveHooks({
      userHooksPath: homeHooks,
      hooksPath: envHooks,
      cwd,
      shellPath: defaultShellPath(),
    });

    expect(warning).toBeUndefined();
    expect(hooks).toBeDefined();
    await expect(hooks?.postToolUse(bashCall, okResult)).resolves.toBe('home\nenv');
  });

  it('resolveHooks can disable the user-home source for an explicit single-source hook runner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-hook-single-cwd-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'jarvis-hook-single-src-'));
    const envHooks = join(sourceDir, 'env-hooks.json');
    await writeFile(envHooks, JSON.stringify({ PostToolUse: [{ matcher: 'bash', command: 'printf env' }] }), 'utf8');

    const { hooks, warning } = await resolveHooks({
      userHooksPath: false,
      hooksPath: envHooks,
      cwd,
      shellPath: defaultShellPath(),
    });

    expect(warning).toBeUndefined();
    expect(hooks).toBeDefined();
    await expect(hooks?.postToolUse(bashCall, okResult)).resolves.toBe('env');
  });
});
