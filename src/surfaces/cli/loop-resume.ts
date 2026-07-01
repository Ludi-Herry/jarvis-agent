import { readFile } from 'node:fs/promises';
import { parseGoalLog, replayGoal, type GoalResumeState } from '../../capabilities/index.js';
import { loadSession } from '../../runtime/index.js';

export interface LoadedLoopGoalResume {
  resume: GoalResumeState;
  initialCursor: number;
}

export async function loadLoopGoalResume(goalPath: string, sessionPath: string, goalId: string, expectedCwd?: string): Promise<LoadedLoopGoalResume> {
  const goalRecords = parseGoalLog(await readFile(goalPath, 'utf8'));
  const created = goalRecords.filter((record) => record.t === 'goal-created');
  if (created.length > 1) throw new Error(`cannot resume in-flight goal ${goalId}: duplicate goal-created records`);
  const replayedGoal = replayGoal(goalRecords);
  if (!replayedGoal.goal) throw new Error(`cannot resume in-flight goal ${goalId}: missing goal-created`);
  if (replayedGoal.goal.id !== goalId) throw new Error(`cannot resume in-flight goal ${goalId}: goal log belongs to ${replayedGoal.goal.id}`);

  const replayedSession = await loadSession(sessionPath);
  if (!replayedSession.header) throw new Error(`cannot resume in-flight goal ${goalId}: missing session header`);
  if (replayedSession.header.id !== goalId) {
    throw new Error(`cannot resume in-flight goal ${goalId}: session log belongs to ${replayedSession.header.id}`);
  }
  if (expectedCwd && replayedSession.header.cwd !== expectedCwd) {
    throw new Error(`cannot resume in-flight goal ${goalId}: session cwd ${replayedSession.header.cwd} does not match ${expectedCwd}`);
  }
  const resume: GoalResumeState = {
    goal: replayedGoal.goal,
    rounds: replayedGoal.rounds,
    messages: replayedSession.messages,
  };
  return { resume, initialCursor: replayedSession.messages.length };
}
