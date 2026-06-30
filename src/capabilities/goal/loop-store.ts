/**
 * LoopStore — append-only JSONL persistence for a Loop's orchestration (Phase E), mirroring
 * goal-store.ts / session-store.ts exactly: durable, human-readable, crash-safe, pure replay.
 *
 * It records ONLY orchestration — which queue index started/finished, with what state/outcome and how
 * many tokens, and why the loop halted. Per-goal round detail still lives in the goal's own
 * data/goals/<goalId>.jsonl (written by runGoal); this log cross-references it by goalId, exactly as a
 * goal-created record cross-references its session log by sessionId. No per-goal detail is duplicated.
 *
 * The crux of crash-safe resume: a queue item's durable identity is its INDEX in `loop-created`'s
 * `objectives` array, NOT a goalId. The goalId is per-ATTEMPT (timestamped), so a goal that crashed
 * mid-run (a `goal-started` with no `goal-finished`) is simply re-attempted under a FRESH goalId — a
 * clean new goal log, no double header, finished goals never touched. `finished` (the set of indices
 * with a `goal-finished`) is the only state resume needs; the cumulative token/goal counts and the
 * monitor window are re-folded from the same records so a resume cannot reset a budget ceiling.
 *
 * Each line is one record:
 *   {t:'loop-created', …}  — header (contract + the immutable objectives queue)
 *   {t:'goal-started', …}  — a queue index was started (audit; a started-without-finished = a crash)
 *   {t:'goal-finished', …} — a queue index finished (state/outcome/rounds/tokens)
 *   {t:'loop-halted', …}   — the loop stopped, and why
 * Crash safety is the SessionStore's: each record is one append; a truncated tail line is skipped.
 */
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GoalState, VerdictOutcome } from './goal.js';
import type { LoopContract, LoopHaltReason, LoopStore } from './loop.js';

/** One line of the loop log. */
export type LoopRecord =
  | { t: 'loop-created'; id: string; contract: LoopContract; objectives: string[]; createdAt: string }
  | { t: 'goal-started'; index: number; goalId: string; at: string }
  | {
      t: 'goal-finished';
      index: number;
      goalId: string;
      state: GoalState;
      outcome?: VerdictOutcome;
      rounds: number;
      tokens: number;
      at: string;
    }
  | { t: 'loop-halted'; reason: LoopHaltReason; at: string };

export type LoopCreatedRecord = Extract<LoopRecord, { t: 'loop-created' }>;

/** What replayLoop reconstructs — exactly the state a `--resume` needs to seed runLoop deps. */
export interface LoopReplay {
  /** The original loop id (from `loop-created`) so a resume reuses it for goalId prefixes. */
  id?: string;
  contract?: LoopContract;
  objectives: string[];
  /** Indices with a `goal-finished` — resume skips these. */
  finished: Set<number>;
  /** Defined verifier outcomes in finish order — re-warms the health monitor window. */
  outcomes: VerdictOutcome[];
  /** = finished.size — seeds the cumulative maxGoals ceiling. */
  goalsFinished: number;
  /** Σ goal-finished.tokens — seeds the cumulative maxTotalTokens ceiling. */
  cumulativeTokens: number;
  /** Re-folded consecutive-blocked count (complete→0, blocked non-cnv→+1, cnv→unchanged). */
  consecutiveBlocked: number;
  /** Set only by a `loop-halted` record — a crash (no such record) leaves it undefined → resumable. */
  halted?: LoopHaltReason;
}

/** Serialize one record as a JSONL line. */
export function serializeLoopRecord(record: LoopRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Parse a JSONL loop log, skipping blank/corrupt lines (the crash-truncated tail). Pure. */
export function parseLoopLog(text: string): LoopRecord[] {
  const records: LoopRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as LoopRecord);
    } catch {
      // truncated/corrupt line — skip and recover the rest
    }
  }
  return records;
}

/** Fold records back into the resume state. Pure. `goal-finished` records are folded in log order, so
 *  the consecutive-blocked count and the outcome window reconstruct exactly what the live run held. */
export function replayLoop(records: LoopRecord[]): LoopReplay {
  let id: string | undefined;
  let contract: LoopContract | undefined;
  let objectives: string[] = [];
  const finished = new Set<number>();
  const outcomes: VerdictOutcome[] = [];
  let cumulativeTokens = 0;
  let consecutiveBlocked = 0;
  let halted: LoopHaltReason | undefined;

  for (const record of records) {
    switch (record.t) {
      case 'loop-created':
        id = record.id;
        contract = record.contract;
        objectives = record.objectives;
        break;
      case 'goal-finished':
        finished.add(record.index);
        cumulativeTokens += record.tokens;
        if (record.outcome !== undefined) outcomes.push(record.outcome);
        if (record.state === 'complete') consecutiveBlocked = 0;
        else if (record.outcome !== 'couldNotVerify') consecutiveBlocked++; // cnv neutral (matches runLoop)
        break;
      case 'loop-halted':
        halted = record.reason;
        break;
      // 'goal-started' is audit-only: a started-without-finished index stays OUT of `finished`, so it
      // is re-attempted on resume.
    }
  }
  return { id, contract, objectives, finished, outcomes, goalsFinished: finished.size, cumulativeTokens, consecutiveBlocked, halted };
}

/** A file-backed append-only loop store (mirrors FileGoalStore). Implements {@link LoopStore} so it
 *  can be injected straight into runLoop. */
export class FileLoopStore implements LoopStore {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  /** Write the loop header. Call once when creating a NEW loop (not on resume). */
  async writeCreated(record: Omit<LoopCreatedRecord, 't'>): Promise<void> {
    await this.append({ t: 'loop-created', ...record });
  }

  async recordStarted(record: { index: number; goalId: string; at: string }): Promise<void> {
    await this.append({ t: 'goal-started', ...record });
  }

  async recordFinished(record: {
    index: number;
    goalId: string;
    state: GoalState;
    outcome?: VerdictOutcome;
    rounds: number;
    tokens: number;
    at: string;
  }): Promise<void> {
    await this.append({ t: 'goal-finished', ...record });
  }

  async recordHalted(reason: LoopHaltReason, at: string): Promise<void> {
    await this.append({ t: 'loop-halted', reason, at });
  }

  private async append(record: LoopRecord): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.path, serializeLoopRecord(record), 'utf8');
  }
}

/** Load and replay a loop log from disk. */
export async function loadLoop(path: string): Promise<LoopReplay> {
  const text = await readFile(path, 'utf8');
  return replayLoop(parseLoopLog(text));
}

/** The most recently modified `*.jsonl` loop file in `dir`, or null if there are none (mirrors
 *  latestSessionPath). Used by `--resume` to find the loop to continue. */
export async function latestLoopPath(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null; // dir doesn't exist yet
  }
  const loops = entries.filter((e) => e.endsWith('.jsonl'));
  if (loops.length === 0) return null;

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of loops) {
    const full = join(dir, name);
    const info = await stat(full);
    if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: info.mtimeMs };
  }
  return newest?.path ?? null;
}
