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
});
