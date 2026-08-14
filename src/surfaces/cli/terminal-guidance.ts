export interface GoalTerminalGuidanceInput {
  state: string;
  verdict: string;
  haltReason?: string;
  goalLogPath: string;
  sessionLogPath: string;
}

export function formatGoalTerminalGuidance(input: GoalTerminalGuidanceInput): string[] {
  if (input.state === 'complete') return [];
  const reason = input.haltReason ?? (input.verdict === '—' ? 'builder-blocked' : input.verdict);
  const next = input.haltReason === 'turnTimeout' || input.haltReason === 'goalTimeout'
    ? '检查 provider/网络状态和 deadline 证据，处理后重新运行。'
    : input.verdict === 'checks-only' || input.verdict === 'couldNotVerify'
      ? '人工复核，或补充 trusted requirements / held-out checks / 独立 verifier。'
      : '查看 goal 证据，处理失败项后重新运行。';
  return [
    `[goal] reason: ${reason}`,
    `[goal] next: ${next}`,
    `[goal] log: ${input.goalLogPath} (session: ${input.sessionLogPath})`,
  ];
}

export interface LoopTerminalGuidanceInput {
  reason: string;
  needsVerification: number;
  runtimeFailures: number;
  loopLogPath: string;
}

export function formatLoopTerminalGuidance(input: LoopTerminalGuidanceInput): string[] {
  if (input.reason === 'queue-empty') return [];
  const next = input.runtimeFailures > 0
    ? '检查 provider/deadline 证据；处理后使用相同 trusted maps 恢复 loop。'
    : input.needsVerification > 0
      ? '人工复核，或补充 trusted requirements / held-out checks / 独立 verifier。'
      : '查看 loop 与关联 goal 日志，处理停止条件后再恢复。';
  return [
    `[loop] reason: ${input.reason}`,
    `[loop] next: ${next}`,
    `[loop] log: ${input.loopLogPath}`,
  ];
}
