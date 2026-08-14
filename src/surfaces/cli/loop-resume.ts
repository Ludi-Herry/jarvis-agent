import { readFile } from 'node:fs/promises';
import { isGoalRecord, replayGoal, type GoalResumeState } from '../../capabilities/index.js';
import {
  diffSessionComposition,
  loadSession,
  type SessionComposition,
  type SessionFormat,
} from '../../runtime/index.js';
import { assertOperationalJsonlIntegrity, parseJsonlWithDiagnostics } from '../../runtime/jsonl-integrity.js';

export interface LoadedLoopGoalResume {
  resume: GoalResumeState;
  initialCursor: number;
  sessionFormat: SessionFormat;
  initialSequence: number;
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

  const replayedSession = await loadSession(sessionPath, { validateIntegrity: true });
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
  if (expectedComposition && 'schemaVersion' in replayedSession.header) {
    if (replayedSession.header.composition.coverage !== 'full' || expectedComposition.coverage !== 'full') {
      throw new Error(`cannot resume in-flight goal ${goalId}: session composition coverage is partial`);
    }
    const differences = diffSessionComposition(replayedSession.header.composition, expectedComposition);
    if (differences.length > 0) {
      throw new Error(
        `cannot resume in-flight goal ${goalId}: session composition changed (${differences.map((item) => item.field).join(', ')})`,
      );
    }
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
