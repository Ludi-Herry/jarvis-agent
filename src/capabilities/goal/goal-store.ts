/**
 * GoalStore — append-only JSONL persistence for a Goal's lifecycle (Phase D), mirroring the
 * SessionStore range (runtime/session/session-store.ts): durable, human-readable, crash-safe.
 *
 * A Goal is a DIFFERENT object from a conversation: it carries an immutable objective, a state
 * machine, a budget, and a leg-2 test baseline — distinct from the message log. So it gets its own
 * store rather than polluting SessionStore's "faithfully replay messages" contract. The builder's
 * messages still go to a FileSessionStore; this records only the goal's life. The two cross-reference
 * via `goal-created.sessionId`.
 *
 * (Lives under capabilities/goal/ with the rest of the goal module — NOT runtime/goal/ — so it can
 * import the goal types without forcing a runtime → capabilities back-dependency.)
 *
 * Each line is one record:
 *   {t:'goal-created', …}  — header (objective, immutable hash, budget, test baseline, sessionId)
 *   {t:'goal-round', …}    — one verification round (builder claim + deterministic checks + verdict)
 *   {t:'goal-state', …}    — a state transition
 * Crash safety is the SessionStore's: each record is one append; a truncated tail line is skipped.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  DeterministicChecks,
  Goal,
  GoalBudget,
  GoalClaim,
  GoalState,
  PinnedRequirement,
  TestBaseline,
  Verdict,
} from './goal.js';

/** One line of the goal log. */
export type GoalRecord =
  | {
      t: 'goal-created';
      id: string;
      objective: string;
      objectiveHash: string;
      budget: GoalBudget;
      testBaseline?: TestBaseline;
      /** Harness-pinned requirement list (leg 3), fixed at creation. Absent in pre-leg-3 logs. */
      pinned?: PinnedRequirement[];
      sessionId: string;
      createdAt: string;
    }
  | { t: 'goal-round'; round: number; claim?: GoalClaim; checks?: DeterministicChecks; verdict?: Verdict; at: string }
  | { t: 'goal-state'; state: GoalState; at: string };

export type GoalCreatedRecord = Extract<GoalRecord, { t: 'goal-created' }>;
export type GoalRoundRecord = Extract<GoalRecord, { t: 'goal-round' }>;

/** sha256 of the objective — stored at creation, asserted unchanged before each verification
 *  (objective is immutable; Part7). Also a restart-time integrity self-check. */
export function hashObjective(objective: string): string {
  return createHash('sha256').update(objective, 'utf8').digest('hex');
}

/** Fail closed if the objective no longer matches its creation-time hash — the objective is immutable
 *  (Part7). Pure; called before each verification as defense-in-depth + a restart integrity check. */
export function assertObjectiveUnchanged(objective: string, expectedHash: string): void {
  if (hashObjective(objective) !== expectedHash) {
    throw new Error('objective changed since creation (immutability violated) — failing closed');
  }
}

/** Serialize one record as a JSONL line. */
export function serializeGoalRecord(record: GoalRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Parse a JSONL goal log, skipping blank/corrupt lines (the crash-truncated tail). Pure. */
export function parseGoalLog(text: string): GoalRecord[] {
  const records: GoalRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as GoalRecord);
    } catch {
      // truncated/corrupt line — skip and recover the rest
    }
  }
  return records;
}

/** Fold records back into the current Goal + its round history. `goal-created` seeds the goal (state
 *  starts `active`), `goal-state` advances it, `goal-round` accumulates. Pure. */
export function replayGoal(records: GoalRecord[]): { goal?: Goal; rounds: GoalRoundRecord[] } {
  let goal: Goal | undefined;
  const rounds: GoalRoundRecord[] = [];
  for (const record of records) {
    switch (record.t) {
      case 'goal-created':
        goal = {
          id: record.id,
          objective: record.objective,
          objectiveHash: record.objectiveHash,
          state: 'active',
          budget: record.budget,
          testBaseline: record.testBaseline,
          // `?? []` so a pre-leg-3 log (no `pinned`) replays as the batch-1 deterministic-only goal.
          pinned: record.pinned ?? [],
          sessionId: record.sessionId,
          createdAt: record.createdAt,
        };
        break;
      case 'goal-state':
        if (goal) goal = { ...goal, state: record.state };
        break;
      case 'goal-round':
        rounds.push(record);
        break;
    }
  }
  return { goal, rounds };
}

/** A file-backed append-only goal store (mirrors FileSessionStore). */
export class FileGoalStore {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  /** Write the goal header. Call once when creating a NEW goal (not on resume). */
  async writeCreated(record: Omit<GoalCreatedRecord, 't'>): Promise<void> {
    await this.append({ t: 'goal-created', ...record });
  }

  async recordRound(record: Omit<GoalRoundRecord, 't'>): Promise<void> {
    await this.append({ t: 'goal-round', ...record });
  }

  async recordState(state: GoalState, at: string): Promise<void> {
    await this.append({ t: 'goal-state', state, at });
  }

  private async append(record: GoalRecord): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.path, serializeGoalRecord(record), 'utf8');
  }
}

/** Load and replay a goal log from disk. */
export async function loadGoal(path: string): Promise<{ goal?: Goal; rounds: GoalRoundRecord[] }> {
  const text = await readFile(path, 'utf8');
  return replayGoal(parseGoalLog(text));
}
