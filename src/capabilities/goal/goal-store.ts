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
import {
  assertOperationalJsonlIntegrity,
  hasFiniteNumberFields,
  hasStringFields,
  isJsonObject,
  parseJsonlWithDiagnostics,
} from '../../runtime/jsonl-integrity.js';
import type {
  DeterministicChecks,
  Goal,
  GoalBudget,
  GoalClaim,
  GoalState,
  PinnedRequirement,
  TestBaseline,
  Verdict,
  WorktreeStatusBaseline,
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
      worktreeBaseline?: WorktreeStatusBaseline;
      /** Harness-pinned requirement list (leg 3), fixed at creation. Absent in pre-leg-3 logs. */
      pinned?: PinnedRequirement[];
      sessionId: string;
      createdAt: string;
    }
  | {
      t: 'goal-round';
      round: number;
      turns?: number;
      tokens?: number;
      claim?: GoalClaim;
      checks?: DeterministicChecks;
      verdict?: Verdict;
      /** Abnormal builder/goal stop retained with the round for durable audit. */
      haltReason?: string;
      rawFinishReason?: string;
      timeoutMs?: number;
      at: string;
    }
  | { t: 'goal-state'; state: GoalState; at: string };

export type GoalCreatedRecord = Extract<GoalRecord, { t: 'goal-created' }>;
export type GoalRoundRecord = Extract<GoalRecord, { t: 'goal-round' }>;

export function isGoalRecord(value: unknown): value is GoalRecord {
  if (!isJsonObject(value) || typeof value.t !== 'string') return false;
  switch (value.t) {
    case 'goal-created':
      return hasStringFields(value, 'id', 'objective', 'objectiveHash', 'sessionId', 'createdAt')
        && isGoalBudget(value.budget)
        && (value.pinned === undefined || (Array.isArray(value.pinned) && value.pinned.every(isPinnedRequirement)))
        && (value.testBaseline === undefined || isTestBaseline(value.testBaseline))
        && (value.worktreeBaseline === undefined || isWorktreeBaseline(value.worktreeBaseline));
    case 'goal-round':
      return hasFiniteNumberFields(value, 'round')
        && typeof value.at === 'string'
        && optionalFiniteNumbers(value, 'turns', 'tokens', 'timeoutMs')
        && optionalStrings(value, 'haltReason', 'rawFinishReason')
        && (value.claim === undefined || isGoalClaim(value.claim))
        && (value.checks === undefined || isDeterministicChecks(value.checks))
        && (value.verdict === undefined || isVerdict(value.verdict));
    case 'goal-state':
      return (value.state === 'active' || value.state === 'complete' || value.state === 'blocked')
        && typeof value.at === 'string';
    default:
      return false;
  }
}

function isGoalBudget(value: unknown): boolean {
  return isJsonObject(value)
    && hasFiniteNumberFields(value, 'maxRounds')
    && optionalFiniteNumbers(value, 'maxTotalTurns', 'maxTotalTokens', 'maxWallClockMs');
}

function isTestBaseline(value: unknown): boolean {
  return isJsonObject(value)
    && typeof value.headSha === 'string'
    && Array.isArray(value.testFiles)
    && value.testFiles.every((file) => isJsonObject(file) && hasStringFields(file, 'path', 'blobHash'));
}

function isWorktreeBaseline(value: unknown): boolean {
  return isJsonObject(value)
    && value.command === 'git status --porcelain --untracked-files=all'
    && typeof value.baseline === 'string';
}

function isPinnedRequirement(value: unknown): boolean {
  return isJsonObject(value)
    && hasStringFields(value, 'id', 'text')
    && (value.route === undefined || value.route === 'sandbox-command' || value.route === 'llm' || value.route === 'human');
}

function isGoalClaim(value: unknown): boolean {
  return isJsonObject(value)
    && (value.status === 'complete' || value.status === 'blocked')
    && (value.verification === undefined || typeof value.verification === 'string');
}

function isDeterministicChecks(value: unknown): boolean {
  return isJsonObject(value)
    && typeof value.objectiveChecksPassed === 'boolean'
    && Array.isArray(value.results)
    && value.results.every(isCheckResult)
    && (value.testTamper === 'clean' || value.testTamper === 'weakened-or-deleted' || value.testTamper === 'unavailable')
    && typeof value.tamperReason === 'string'
    && (value.heldOut === undefined || isHeldOut(value.heldOut))
    && (value.worktreeStatus === undefined || isWorktreeStatus(value.worktreeStatus));
}

function isWorktreeStatus(value: unknown): boolean {
  return isWorktreeBaseline(value)
    && isJsonObject(value)
    && (value.policy === 'audit' || value.policy === 'forbid')
    && typeof value.current === 'string'
    && typeof value.changed === 'boolean'
    && Array.isArray(value.changedEntries)
    && value.changedEntries.every((entry) => typeof entry === 'string')
    && optionalStrings(value, 'trackedDiffHash', 'error');
}

function isCheckResult(value: unknown): boolean {
  return isJsonObject(value)
    && hasStringFields(value, 'command', 'output')
    && (value.code === null || (typeof value.code === 'number' && Number.isFinite(value.code)));
}

function isHeldOut(value: unknown): boolean {
  return isJsonObject(value)
    && typeof value.passed === 'boolean'
    && Array.isArray(value.results)
    && value.results.every(isCheckResult);
}

function isVerdict(value: unknown): boolean {
  return isJsonObject(value)
    && (value.outcome === 'verified'
      || value.outcome === 'checksOnly'
      || value.outcome === 'rejected'
      || value.outcome === 'couldNotVerify')
    && typeof value.rationale === 'string'
    && (value.report === undefined || isVerifierReport(value.report));
}

function isVerifierReport(value: unknown): boolean {
  return isJsonObject(value)
    && (value.feature === 'works' || value.feature === 'broken')
    && hasStringFields(value, 'expected', 'observed', 'evidence', 'rationale')
    && Array.isArray(value.couldNotVerify)
    && value.couldNotVerify.every((item) => typeof item === 'string')
    && Array.isArray(value.perRequirement)
    && value.perRequirement.every((item) => isJsonObject(item)
      && typeof item.requirementId === 'string'
      && (item.strength === 'proves'
        || item.strength === 'contradicts'
        || item.strength === 'incomplete'
        || item.strength === 'tooWeak'
        || item.strength === 'missing'
        || item.strength === 'cannotVerify')
      && (item.scope === 'matched' || item.scope === 'narrowerThanClaim'));
}

function optionalFiniteNumbers(value: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => value[field] === undefined
    || (typeof value[field] === 'number' && Number.isFinite(value[field])));
}

function optionalStrings(value: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === 'string');
}

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
  return parseJsonlWithDiagnostics(text, isGoalRecord).records;
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
          worktreeBaseline: record.worktreeBaseline,
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
  const parsed = parseJsonlWithDiagnostics(text, isGoalRecord);
  const replayed = replayGoal(parsed.records);
  assertOperationalJsonlIntegrity('goal', parsed.malformed, replayed.goal !== undefined);
  return replayed;
}
