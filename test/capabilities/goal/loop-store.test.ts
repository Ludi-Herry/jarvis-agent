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
  it('replays created and attempts but does not trust finished state/outcome seeds', async () => {
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
    expect([...replay.finished]).toEqual([]);
    expect([...replay.inFlight]).toEqual([
      [0, 'L1-g0-x'],
      [1, 'L1-g1-x'],
    ]);
    expect(replay.goalsFinished).toBe(0);
    expect(replay.cumulativeTokens).toBe(0);
    expect(replay.outcomes).toEqual([]);
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
    expect([...replay.finished]).toEqual([]);
    expect([...replay.inFlight]).toEqual([
      [0, 'L2-g0-x'],
      [1, 'L2-g1-x'],
    ]);
    expect(replay.halted).toBeUndefined(); // no loop-halted → resumable
  });

  it('does not trust log verifier outcomes or verifierKey for keyed health resume', async () => {
    const path = join(dir, 'L-keyed-verifier.jsonl');
    const store = new FileLoopStore(path);
    await store.writeCreated({ id: 'L', contract: CONTRACT, objectives: ['a'], createdAt: 't0' });
    await store.recordFinished({
      index: 0,
      goalId: 'L-g0-x',
      state: 'blocked',
      outcome: 'couldNotVerify',
      verifierKey: 'model:judge-a',
      rounds: 1,
      tokens: 10,
      at: 't1',
    });

    const replay = await loadLoop(path);

    expect(replay.outcomes).toEqual([]);
    expect([...replay.inFlight]).toEqual([[0, 'L-g0-x']]);
  });

  it('replays the trusted verifier-map path metadata from loop-created', async () => {
    const path = join(dir, 'L-verifier-map.jsonl');
    const store = new FileLoopStore(path);
    await store.writeCreated({
      id: 'L',
      contract: CONTRACT,
      objectives: ['a'],
      createdAt: 't0',
      verifierMapPath: 'C:\\Users\\Luis\\.jarvis\\loop-verifiers.json',
    });

    const replay = await loadLoop(path);

    expect(replay.verifierMapPath).toBe('C:\\Users\\Luis\\.jarvis\\loop-verifiers.json');
  });

  it('replays the trusted hook-map path metadata from loop-created', async () => {
    const path = join(dir, 'L-hook-map.jsonl');
    const store = new FileLoopStore(path);
    await store.writeCreated({
      id: 'L',
      contract: CONTRACT,
      objectives: ['a'],
      createdAt: 't0',
      hookMapPath: 'C:\\Users\\Luis\\.jarvis\\loop-hooks.json',
    });

    const replay = await loadLoop(path);

    expect(replay.hookMapPath).toBe('C:\\Users\\Luis\\.jarvis\\loop-hooks.json');
  });

  it('replays the trusted sandbox-check-map path metadata from loop-created', async () => {
    const path = join(dir, 'L-sandbox-check-map.jsonl');
    const store = new FileLoopStore(path);
    const created = {
      id: 'L',
      contract: CONTRACT,
      objectives: ['a'],
      createdAt: 't0',
      sandboxCheckMapPath: 'C:\\Users\\Luis\\.jarvis\\loop-sandbox-checks.json',
    };
    await store.writeCreated(created);

    const replay = await loadLoop(path);

    expect((replay as { sandboxCheckMapPath?: string }).sandboxCheckMapPath).toBe('C:\\Users\\Luis\\.jarvis\\loop-sandbox-checks.json');
  });

  it('replays the trusted goal-setter requirements map path and hash metadata from loop-created', async () => {
    const path = join(dir, 'L-goal-setter-requirements-map.jsonl');
    const store = new FileLoopStore(path);
    await store.writeCreated({
      id: 'L',
      contract: CONTRACT,
      objectives: ['a'],
      createdAt: 't0',
      goalSetterRequirementsMapPath: 'C:\\Users\\Luis\\.jarvis\\loop-goal-setter-requirements.json',
      goalSetterRequirementsMapHash: 'sha256:abc',
    });

    const replay = await loadLoop(path);

    expect(replay.goalSetterRequirementsMapPath).toBe('C:\\Users\\Luis\\.jarvis\\loop-goal-setter-requirements.json');
    expect(replay.goalSetterRequirementsMapHash).toBe('sha256:abc');
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

    expect([...replay.finished]).toEqual([]);
    expect([...replay.inFlight]).toEqual([
      [0, 'L-g0-old'],
      [1, 'L-g1-resume'],
    ]);
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
    expect(replay.consecutiveBlocked).toBe(0);
    expect(replay.outcomes).toEqual([]);
    expect([...replay.inFlight]).toEqual([
      [0, 'g0'],
      [1, 'g1'],
      [2, 'g2'],
      [3, 'g3'],
      [4, 'g4'],
    ]);
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
    expect([...replay.finished]).toEqual([]);
    expect([...replay.inFlight]).toEqual([[0, 'g0']]);
    expect(replay.cumulativeTokens).toBe(0);
  });

  it('fails closed when operational replay encounters a structurally invalid middle record', async () => {
    const path = join(dir, 'L-corrupt.jsonl');
    await writeFile(
      path,
      '{"t":"loop-created","id":"L","contract":'
        + JSON.stringify(CONTRACT)
        + ',"objectives":["a"],"createdAt":"t0"}\n'
        + '{"t":"goal-started","index":0}\n',
      'utf8',
    );

    await expect(loadLoop(path)).rejects.toThrow('loop state is corrupt at line 2 (invalid-record)');
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
