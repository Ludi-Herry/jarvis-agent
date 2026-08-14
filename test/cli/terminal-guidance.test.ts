import { describe, expect, it } from 'vitest';
import {
  formatGoalTerminalGuidance,
  formatLoopTerminalGuidance,
} from '../../src/surfaces/cli/terminal-guidance.js';

describe('terminal actionable guidance', () => {
  it('locks the checks-only goal summary to reason, next action, and evidence paths', () => {
    expect(formatGoalTerminalGuidance({
      state: 'blocked',
      verdict: 'checks-only',
      goalLogPath: 'data/goals/g1.jsonl',
      sessionLogPath: 'data/sessions/s1.jsonl',
    })).toEqual([
      '[goal] reason: checks-only',
      '[goal] next: 人工复核，或补充 trusted requirements / held-out checks / 独立 verifier。',
      '[goal] log: data/goals/g1.jsonl (session: data/sessions/s1.jsonl)',
    ]);
  });

  it('locks the goal-timeout summary to runtime recovery guidance', () => {
    expect(formatGoalTerminalGuidance({
      state: 'blocked',
      verdict: 'couldNotVerify',
      haltReason: 'goalTimeout',
      goalLogPath: 'data/goals/g1.jsonl',
      sessionLogPath: 'data/sessions/s1.jsonl',
    })).toEqual([
      '[goal] reason: goalTimeout',
      '[goal] next: 检查 provider/网络状态和 deadline 证据，处理后重新运行。',
      '[goal] log: data/goals/g1.jsonl (session: data/sessions/s1.jsonl)',
    ]);
  });

  it('locks the blocked-goals loop summary to verification guidance and loop evidence', () => {
    expect(formatLoopTerminalGuidance({
      reason: 'blocked-goals',
      needsVerification: 1,
      runtimeFailures: 0,
      loopLogPath: 'data/loops/L1.jsonl',
    })).toEqual([
      '[loop] reason: blocked-goals',
      '[loop] next: 人工复核，或补充 trusted requirements / held-out checks / 独立 verifier。',
      '[loop] log: data/loops/L1.jsonl',
    ]);
  });
});
