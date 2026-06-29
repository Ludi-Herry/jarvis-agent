import { describe, expect, it } from 'vitest';
import {
  classifyTestDiff,
  runDeterministicChecks,
} from '../../../src/capabilities/goal/checks.js';
import { defaultShellPath } from '../../../src/core/tools/run-command.js';

describe('classifyTestDiff (pure)', () => {
  it('clean when a test file only ADDS cases', () => {
    const diff = [
      'diff --git a/test/foo.test.ts b/test/foo.test.ts',
      'index aaa..bbb 100644',
      '--- a/test/foo.test.ts',
      '+++ b/test/foo.test.ts',
      '@@ -1,1 +1,2 @@',
      "   it('a', () => {})",
      "+  it('b', () => {})",
    ].join('\n');
    expect(classifyTestDiff(diff).testTamper).toBe('clean');
  });

  it('weakened-or-deleted when a test file is deleted', () => {
    const diff = [
      'diff --git a/test/foo.test.ts b/test/foo.test.ts',
      'deleted file mode 100644',
      'index aaa..000',
      '--- a/test/foo.test.ts',
      '+++ /dev/null',
    ].join('\n');
    const r = classifyTestDiff(diff);
    expect(r.testTamper).toBe('weakened-or-deleted');
    expect(r.tamperReason).toContain('deleted');
  });

  it('weakened-or-deleted when a skip/only marker is added', () => {
    const diff = [
      'diff --git a/test/foo.test.ts b/test/foo.test.ts',
      '--- a/test/foo.test.ts',
      '+++ b/test/foo.test.ts',
      '@@ -1,1 +1,1 @@',
      "-  it('works', () => {})",
      "+  it.skip('works', () => {})",
    ].join('\n');
    expect(classifyTestDiff(diff).testTamper).toBe('weakened-or-deleted');
  });

  it('weakened-or-deleted when net test-case count drops', () => {
    const diff = [
      'diff --git a/test/foo.test.ts b/test/foo.test.ts',
      '--- a/test/foo.test.ts',
      '+++ b/test/foo.test.ts',
      '@@ -1,3 +1,1 @@',
      "-  it('a', () => {})",
      "-  it('b', () => {})",
      "+  it('a', () => {})",
    ].join('\n');
    const r = classifyTestDiff(diff);
    expect(r.testTamper).toBe('weakened-or-deleted');
    expect(r.tamperReason).toContain('dropped');
  });

  it('ignores non-test files (a deleted source file is not tampering)', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'deleted file mode 100644',
      "-  it('looks like a test but is not', () => {})",
    ].join('\n');
    expect(classifyTestDiff(diff).testTamper).toBe('clean');
  });

  it('H-1: flags a modified check-oracle file (neutralizing npm test via package.json)', () => {
    const diff = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -10,1 +10,1 @@',
      '-    "test": "vitest run",',
      '+    "test": "exit 0",',
    ].join('\n');
    const r = classifyTestDiff(diff);
    expect(r.testTamper).toBe('weakened-or-deleted');
    expect(r.tamperReason).toContain('package.json');
  });

  it('H-1: also flags tsconfig / eslint / vitest config edits as oracle tampering', () => {
    expect(classifyTestDiff('diff --git a/tsconfig.json b/tsconfig.json\n+{}').testTamper).toBe('weakened-or-deleted');
    expect(classifyTestDiff('diff --git a/eslint.config.js b/eslint.config.js\n+x').testTamper).toBe('weakened-or-deleted');
    expect(classifyTestDiff('diff --git a/vitest.config.ts b/vitest.config.ts\n+x').testTamper).toBe('weakened-or-deleted');
  });

  it('detects focus markers (fit/fdescribe) as tampering too', () => {
    const diff = ['diff --git a/test/x.test.ts b/test/x.test.ts', "+  fit('x', () => {})"].join('\n');
    expect(classifyTestDiff(diff).testTamper).toBe('weakened-or-deleted');
  });
});

describe('runDeterministicChecks — leg 1 trusts the real exit code', () => {
  const shellPath = defaultShellPath();

  it('passes when every check exits 0', async () => {
    const r = await runDeterministicChecks({ shellPath, cwd: process.cwd(), checkCommands: ['exit 0'] });
    expect(r.objectiveChecksPassed).toBe(true);
  });

  it('fails on any non-zero exit (records the real codes, not a self-report)', async () => {
    const r = await runDeterministicChecks({
      shellPath,
      cwd: process.cwd(),
      checkCommands: ['exit 0', 'exit 3'],
    });
    expect(r.objectiveChecksPassed).toBe(false);
    expect(r.results.map((x) => x.code)).toEqual([0, 3]);
  });

  it('with no baseline, leg 2 is inert (clean)', async () => {
    const r = await runDeterministicChecks({ shellPath, cwd: process.cwd(), checkCommands: ['exit 0'] });
    expect(r.testTamper).toBe('clean');
  });

  it('fails closed when git diff fails against a PRESENT baseline (unreachable sha) — not silently clean', async () => {
    // A present baseline whose sha git can't resolve must NOT pass leg 2 as "clean" — we cannot confirm
    // the tests are untampered, so fail closed. (Trigger test for the impure scanTestTamper git-fail path.)
    const r = await runDeterministicChecks(
      { shellPath, cwd: process.cwd(), checkCommands: ['exit 0'] },
      { headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', testFiles: [] },
    );
    expect(r.testTamper).toBe('weakened-or-deleted');
    expect(r.tamperReason).toContain('git diff failed');
  });

  it('fails closed when there are no check commands (a vacuous AND must not pass)', async () => {
    const r = await runDeterministicChecks({ shellPath, cwd: process.cwd(), checkCommands: [] });
    expect(r.objectiveChecksPassed).toBe(false);
  });
});

describe('runDeterministicChecks — held-out leg (secret hidden assertions)', () => {
  const shellPath = defaultShellPath();

  it('runs the held-out commands when leg 1 is green and ANDs their real exit codes', async () => {
    const r = await runDeterministicChecks({
      shellPath,
      cwd: process.cwd(),
      checkCommands: ['exit 0'],
      heldOutCommands: ['exit 0', 'exit 0'],
    });
    expect(r.heldOut?.passed).toBe(true);
    expect(r.heldOut?.results).toHaveLength(2);
  });

  it('held-out fails on any non-zero hidden assertion, even though leg 1 is green (the anti-gaming catch)', async () => {
    const r = await runDeterministicChecks({
      shellPath,
      cwd: process.cwd(),
      checkCommands: ['exit 0'], // builder's own (weak) checks pass
      heldOutCommands: ['exit 0', 'exit 1'], // a hidden assertion the builder never saw fails
    });
    expect(r.objectiveChecksPassed).toBe(true);
    expect(r.heldOut?.passed).toBe(false);
  });

  it('does NOT run held-out when leg 1 is red (already rejecting; held-out stays absent)', async () => {
    const r = await runDeterministicChecks({
      shellPath,
      cwd: process.cwd(),
      checkCommands: ['exit 1'],
      heldOutCommands: ['exit 0'],
    });
    expect(r.objectiveChecksPassed).toBe(false);
    expect(r.heldOut).toBeUndefined();
  });

  it('held-out is absent when no held-out commands are configured (the leg is not run)', async () => {
    const r = await runDeterministicChecks({ shellPath, cwd: process.cwd(), checkCommands: ['exit 0'] });
    expect(r.heldOut).toBeUndefined();
  });

  it('an empty held-out list is treated as absent, not a vacuous pass', async () => {
    const r = await runDeterministicChecks({
      shellPath,
      cwd: process.cwd(),
      checkCommands: ['exit 0'],
      heldOutCommands: [],
    });
    expect(r.heldOut).toBeUndefined();
  });
});
