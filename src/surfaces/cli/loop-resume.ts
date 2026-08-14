import { readFile } from 'node:fs/promises';
import { isGoalRecord, replayGoal, type GoalResumeState } from '../../capabilities/index.js';
import {
  loadSession,
  resolveNoDynamicAddendum,
  type SessionComposition,
  type SessionFormat,
} from '../../runtime/index.js';
import { assertOperationalJsonlIntegrity, parseJsonlWithDiagnostics } from '../../runtime/jsonl-integrity.js';
import { safeInline } from './approval.js';

export interface LoadedLoopGoalResume {
  resume: GoalResumeState;
  initialCursor: number;
  sessionFormat: SessionFormat;
  initialSequence: number;
}

export function formatLoopCliError(prefix: string, err: unknown): string {
  const detail = safeInline(err instanceof Error ? err.message : String(err));
  return prefix === '' ? detail : `${prefix} ${detail}`;
}

export async function loadLoopGoalResume(
  goalPath: string,
  sessionPath: string,
  goalId: string,
  expectedCwd?: string,
  expectedComposition?: SessionComposition,
  expectedModel?: string,
): Promise<LoadedLoopGoalResume> {
  const parsedGoal = parseJsonlWithDiagnostics(await readFile(goalPath, 'utf8'), isGoalRecord);
  const goalRecords = parsedGoal.records;
  const created = goalRecords.filter((record) => record.t === 'goal-created');
  assertOperationalJsonlIntegrity('goal', parsedGoal.malformed, created.length > 0);
  if (created.length > 1) throw new Error(`cannot resume in-flight goal ${goalId}: duplicate goal-created records`);
  const replayedGoal = replayGoal(goalRecords);
  if (!replayedGoal.goal) throw new Error(`cannot resume in-flight goal ${goalId}: missing goal-created`);
  if (replayedGoal.goal.id !== goalId) throw new Error(`cannot resume in-flight goal ${goalId}: goal log belongs to ${replayedGoal.goal.id}`);

  const replayedSession = await loadSession(sessionPath, {
    validateIntegrity: true,
    ...(expectedComposition === undefined
      ? {}
      : {
          resume: {
            expectedComposition,
            resolveDynamicAddendum: resolveNoDynamicAddendum,
          },
        }),
  });
  if (!replayedSession.header) throw new Error(`cannot resume in-flight goal ${goalId}: missing session header`);
  if (replayedSession.header.id !== goalId) {
    throw new Error(`cannot resume in-flight goal ${goalId}: session log belongs to ${replayedSession.header.id}`);
  }
  if (expectedCwd && replayedSession.header.cwd !== expectedCwd) {
    throw new Error(`cannot resume in-flight goal ${goalId}: session cwd ${replayedSession.header.cwd} does not match ${expectedCwd}`);
  }
  if (expectedModel && replayedSession.header.model !== expectedModel) {
    throw new Error(`cannot resume in-flight goal ${goalId}: session model ${replayedSession.header.model} does not match ${expectedModel}`);
  }
  if (replayedSession.pendingTools.length > 0) {
    const pending = replayedSession.pendingTools[0];
    throw new Error(
      `cannot resume in-flight goal ${goalId}: ${replayedSession.pendingTools.length} unresolved tool execution(s); ` +
      `first=${pending.toolName}/${pending.callId} reason=${pending.reason}`,
    );
  }
  if (replayedSession.format === 'v2' && expectedComposition === undefined) {
    throw new Error(
      `cannot resume in-flight goal ${goalId}: current session composition proof is required for v2 resume`,
    );
  }
  const resume: GoalResumeState = {
    goal: replayedGoal.goal,
    rounds: replayedGoal.rounds,
    messages: replayedSession.messages,
  };
  return {
    resume,
    initialCursor: replayedSession.messages.length,
    sessionFormat: replayedSession.format,
    initialSequence: replayedSession.lastSequence,
  };
}
