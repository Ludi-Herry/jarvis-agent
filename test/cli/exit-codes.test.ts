import { describe, expect, it } from 'vitest';
import { CLI_EXIT, exitCodeForCron, exitCodeForGoal, exitCodeForLoop, exitCodeForRun } from '../../src/surfaces/cli/exit-codes.js';

describe('stable CLI exit contract', () => {
  it('maps conversational run outcomes without completion authority', () => {
    expect(exitCodeForRun({ finalText: 'done' })).toBe(CLI_EXIT.SUCCESS);
    expect(exitCodeForRun({ halted: 'turnTimeout' })).toBe(CLI_EXIT.RUNTIME);
    expect(exitCodeForRun({ halted: 'toolExecutionUnknown' })).toBe(CLI_EXIT.NEEDS_HUMAN);
    expect(exitCodeForRun({ halted: 'maxTurns' })).toBe(CLI_EXIT.NEEDS_HUMAN);
  });

  it('returns success only for a fully drained verified loop', () => {
    expect(exitCodeForLoop({ reason: 'queue-empty', blocked: 0, needsVerification: 0, runtimeFailures: 0 })).toBe(CLI_EXIT.SUCCESS);
    expect(exitCodeForLoop({ reason: 'blocked-goals', blocked: 1, needsVerification: 0, runtimeFailures: 0 })).toBe(CLI_EXIT.NEEDS_HUMAN);
  });

  it('distinguishes unverified, timeout, and interrupted loop outcomes', () => {
    expect(exitCodeForLoop({ reason: 'blocked-goals', blocked: 1, needsVerification: 1, runtimeFailures: 0 })).toBe(CLI_EXIT.UNVERIFIED);
    expect(exitCodeForLoop({ reason: 'wall-clock', blocked: 0, needsVerification: 0, runtimeFailures: 0 })).toBe(CLI_EXIT.RUNTIME);
    expect(exitCodeForLoop({ reason: 'blocked-goals', blocked: 1, needsVerification: 1, runtimeFailures: 1 })).toBe(CLI_EXIT.RUNTIME);
    expect(exitCodeForLoop({ reason: 'emergency-stop', blocked: 0, needsVerification: 0, runtimeFailures: 0 })).toBe(CLI_EXIT.INTERRUPTED);
  });

  it('grants goal success only to an independently verified completion', () => {
    expect(exitCodeForGoal({ state: 'complete', outcome: 'verified' })).toBe(CLI_EXIT.SUCCESS);
    expect(exitCodeForGoal({ state: 'blocked', outcome: 'checksOnly' })).toBe(CLI_EXIT.UNVERIFIED);
    expect(exitCodeForGoal({ state: 'blocked', outcome: 'couldNotVerify' })).toBe(CLI_EXIT.UNVERIFIED);
    expect(exitCodeForGoal({ state: 'blocked', haltReason: 'goalTimeout' })).toBe(CLI_EXIT.RUNTIME);
    expect(exitCodeForGoal({ state: 'blocked', haltReason: 'emergency-stop' })).toBe(CLI_EXIT.INTERRUPTED);
  });

  it('propagates cron child failures and interruption', () => {
    expect(exitCodeForCron({ failed: 0 })).toBe(CLI_EXIT.SUCCESS);
    expect(exitCodeForCron({ failed: 1 })).toBe(CLI_EXIT.NEEDS_HUMAN);
    expect(exitCodeForCron({ failed: 0 }, true)).toBe(CLI_EXIT.INTERRUPTED);
  });
});
