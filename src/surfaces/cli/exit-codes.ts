/** Stable process exit contract for automation-facing CLI surfaces. */
export const CLI_EXIT = {
  SUCCESS: 0,
  USAGE: 2,
  NEEDS_HUMAN: 3,
  UNVERIFIED: 4,
  RUNTIME: 5,
  DENIED: 6,
  STATE_CORRUPT: 7,
  INTERRUPTED: 130,
} as const;

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];

export function exitCodeForRun(result: { finalText?: string; halted?: string }): CliExitCode {
  if (result.finalText !== undefined && result.halted === undefined) return CLI_EXIT.SUCCESS;
  if (result.halted === 'turnTimeout') return CLI_EXIT.RUNTIME;
  return CLI_EXIT.NEEDS_HUMAN;
}

export interface LoopExitSummary {
  reason: string;
  blocked: number;
  needsVerification: number;
  runtimeFailures: number;
}

export function exitCodeForLoop(result: LoopExitSummary): CliExitCode {
  if (result.reason === 'emergency-stop') return CLI_EXIT.INTERRUPTED;
  if (result.reason === 'wall-clock' || result.runtimeFailures > 0) return CLI_EXIT.RUNTIME;
  if (result.needsVerification > 0) return CLI_EXIT.UNVERIFIED;
  if (result.reason === 'queue-empty' && result.blocked === 0) return CLI_EXIT.SUCCESS;
  return CLI_EXIT.NEEDS_HUMAN;
}

export function exitCodeForGoal(result: {
  state: string;
  outcome?: string;
  haltReason?: string;
}): CliExitCode {
  if (result.haltReason === 'emergency-stop') return CLI_EXIT.INTERRUPTED;
  if (result.haltReason === 'turnTimeout' || result.haltReason === 'goalTimeout') return CLI_EXIT.RUNTIME;
  if (result.outcome === 'checksOnly' || result.outcome === 'couldNotVerify') return CLI_EXIT.UNVERIFIED;
  if (result.state === 'complete' && result.outcome === 'verified') return CLI_EXIT.SUCCESS;
  return CLI_EXIT.NEEDS_HUMAN;
}

export function exitCodeForCron(result: { failed: number }, interrupted = false): CliExitCode {
  if (interrupted) return CLI_EXIT.INTERRUPTED;
  return result.failed > 0 ? CLI_EXIT.NEEDS_HUMAN : CLI_EXIT.SUCCESS;
}
