import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileLoopStore,
  latestLoopPath,
  loadLoop,
  parseLoopLog,
  replayLoop,
  type LoopRecord,
} from '../../../src/capabilities/goal/loop-store.js';
import type { LoopContract } from '../../../src/capabilities/goal/loop.js';

const CONTRACT: LoopContract = {
  maxGoals: 5,
  maxTotalTokens: 1000,
  maxWallClockMs: 60_000,
  maxConsecutiveBlocked: 3,
  cnvWindow: 3,
  cnvThreshold: 3,
  perGoalBudget: { maxRounds: 8 },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-loop-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileLoopStore round-trip', () => {
  it('replays created → started → finished → halted into resume state', async () => {
    const path = join(dir, 'L1.jsonl');
    const store = new FileLoopStore(path);
    await store.writeCreated({ id: 'L1', contract: CONTRACT, objectives: ['a', 'b', 'c'], createdAt: 't0' });
    await store.recordStarted({ index: 0, goalId: 'L1-g0-x', at: 't1' });
    await store.recordFinished({ index: 0, goalId: 'L1-g0-x', state: 'complete', outcome: 'verified', rounds: 2, tokens: 100, at: 't2' });
    await store.recordStarted({ index: 1, goalId: 'L1-g1-x', at: 't3' });
    await store.recordFinished({ index: 1, goalId: 'L1-g1-x', state: 'blocked', outcome: 'couldNotVerify', rounds: 1, tokens: 50, at: 't4' });
    await store.recordHalted('verifier-health', 't5');

    const replay = await loadLoop(path);
    expect(replay.id).toBe('L1');
    expect(replay.contract).toEqual(CONTRACT);
    expect(replay.objectives).toEqual(['a', 'b', 'c']);
    expect([...replay.finished]).toEqual([0, 1]);
    expect(replay.goalsFinished).toBe(2);
    expect(replay.cumulativeTokens).toBe(150);
    expect(replay.outcomes).toEqual(['verified', 'couldNotVerify']); // defined outcomes, in order
    expect(replay.halted).toBe('verifier-health');
  });

  it('a goal-started without a goal-finished (a crash) stays out of finished but remains in-flight', async () => {
    const path = join(dir, 'L2.jsonl');
    const store = new FileLoopStore(path);
    await store.writeCreated({ id: 'L2', contract: CONTRACT, objectives: ['a', 'b'], createdAt: 't0' });
    await store.recordStarted({ index: 0, goalId: 'L2-g0-x', at: 't1' });
    await store.recordFinished({ index: 0, goalId: 'L2-g0-x', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' });
    await store.recordStarted({ index: 1, goalId: 'L2-g1-x', at: 't3' }); // crashed here — no finished

    const replay = await loadLoop(path);
    expect([...replay.finished]).toEqual([0]); // index 1 NOT finished
    expect(replay.halted).toBeUndefined(); // no loop-halted → resumable
  });

  it('replays the latest started-without-finished goal as an in-flight resume attempt', async () => {
    const path = join(dir, 'L-inflight.jsonl');
    const store = new FileLoopStore(path);
    await store.writeCreated({ id: 'L', contract: CONTRACT, objectives: ['a', 'b', 'c'], createdAt: 't0' });
    await store.recordStarted({ index: 0, goalId: 'L-g0-old', at: 't1' });
    await store.recordFinished({ index: 0, goalId: 'L-g0-old', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' });
    await store.recordStarted({ index: 1, goalId: 'L-g1-first', at: 't3' });
    await store.recordStarted({ index: 1, goalId: 'L-g1-resume', at: 't4' });

    const replay = await loadLoop(path);

    expect([...replay.finished]).toEqual([0]);
    expect([...replay.inFlight]).toEqual([[1, 'L-g1-resume']]);
  });
});

describe('replayLoop — consecutive-blocked folding (mirrors runLoop)', () => {
  it('a complete resets, cnv is neutral, a non-cnv block increments', () => {
    const fin = (index: number, state: 'complete' | 'blocked', outcome: 'verified' | 'rejected' | 'couldNotVerify'): LoopRecord => ({
      t: 'goal-finished',
      index,
      goalId: `g${index}`,
      state,
      outcome,
      rounds: 1,
      tokens: 0,
      at: 't',
    });
    // block(rejected), block(rejected), complete, block(cnv), block(rejected) → counter: 1,2,0,0(neutral),1
    const records: LoopRecord[] = [
      { t: 'loop-created', id: 'L', contract: CONTRACT, objectives: ['a', 'b', 'c', 'd', 'e'], createdAt: 't' },
      fin(0, 'blocked', 'rejected'),
      fin(1, 'blocked', 'rejected'),
      fin(2, 'complete', 'verified'),
      fin(3, 'blocked', 'couldNotVerify'),
      fin(4, 'blocked', 'rejected'),
    ];
    const replay = replayLoop(records);
    expect(replay.consecutiveBlocked).toBe(1); // reset by complete, cnv neutral, then one rejected block
    expect(replay.outcomes).toEqual(['rejected', 'rejected', 'verified', 'couldNotVerify', 'rejected']);
  });
});

describe('parseLoopLog — crash safety', () => {
  it('skips a truncated trailing line and recovers the rest', async () => {
    const path = join(dir, 'L3.jsonl');
    await writeFile(
      path,
      '{"t":"loop-created","id":"L3","contract":' +
        JSON.stringify(CONTRACT) +
        ',"objectives":["a","b"],"createdAt":"t0"}\n' +
        '{"t":"goal-finished","index":0,"goalId":"g0","state":"complete","outcome":"verified","rounds":1,"tokens":7,"at":"t1"}\n' +
        '{"t":"goal-fin', // truncated tail
      'utf8',
    );
    const records = parseLoopLog(await readFile(path, 'utf8'));
    expect(records).toHaveLength(2); // half-written line skipped
    const replay = replayLoop(records);
    expect([...replay.finished]).toEqual([0]);
    expect(replay.cumulativeTokens).toBe(7);
  });
});

describe('latestLoopPath', () => {
  it('returns null when the dir does not exist', async () => {
    expect(await latestLoopPath(join(dir, 'nope'))).toBeNull();
  });

  it('picks the most recently modified *.jsonl', async () => {
    const older = join(dir, 'old.jsonl');
    const newer = join(dir, 'new.jsonl');
    await writeFile(older, '{}\n', 'utf8');
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(newer, '{}\n', 'utf8');
    expect(await latestLoopPath(dir)).toBe(newer);
  });
});
