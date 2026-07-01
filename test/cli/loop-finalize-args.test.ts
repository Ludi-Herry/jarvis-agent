import { describe, expect, it } from 'vitest';
import { parseLoopFinalizeArgs } from '../../src/surfaces/cli/loop-finalize-args.js';

describe('parseLoopFinalizeArgs', () => {
  it('parses a loop id and optional worktree root', () => {
    expect(parseLoopFinalizeArgs(['--loop', 'L1', '--worktree-root', 'C:\\trusted\\worktrees'])).toEqual({
      loopId: 'L1',
      worktreeRootPath: 'C:\\trusted\\worktrees',
      merge: false,
      cleanup: false,
    });
  });

  it('parses interactive merge mode', () => {
    expect(parseLoopFinalizeArgs(['--loop', 'L1', '--merge'])).toEqual({
      loopId: 'L1',
      merge: true,
      cleanup: false,
    });
  });

  it('parses interactive cleanup mode', () => {
    expect(parseLoopFinalizeArgs(['--loop', 'L1', '--cleanup'])).toEqual({
      loopId: 'L1',
      merge: false,
      cleanup: true,
    });
  });

  it('rejects missing loop id and unknown flags', () => {
    expect(() => parseLoopFinalizeArgs([])).toThrow(/--loop/);
    expect(() => parseLoopFinalizeArgs(['--loop'])).toThrow(/requires an id/);
    expect(() => parseLoopFinalizeArgs(['--wat'])).toThrow(/unknown flag/);
  });

  it('rejects combining merge and cleanup in one invocation', () => {
    expect(() => parseLoopFinalizeArgs(['--loop', 'L1', '--merge', '--cleanup'])).toThrow(/combine/);
  });
});
