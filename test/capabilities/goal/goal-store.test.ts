import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileGoalStore,
  hashObjective,
  loadGoal,
  parseGoalLog,
  replayGoal,
} from '../../../src/capabilities/goal/goal-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-goal-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('hashObjective', () => {
  it('is deterministic and distinguishes objectives', () => {
    expect(hashObjective('build X')).toBe(hashObjective('build X'));
    expect(hashObjective('build X')).not.toBe(hashObjective('build Y'));
  });
});

describe('FileGoalStore round-trip', () => {
  it('replays created → round → state into the current goal', async () => {
    const path = join(dir, 'g1.jsonl');
    const store = new FileGoalStore(path);
    const objective = 'add a feature';
    await store.writeCreated({
      id: 'g1',
      objective,
      objectiveHash: hashObjective(objective),
      budget: { maxRounds: 5 },
      testBaseline: { headSha: 'abc', testFiles: [{ path: 'test/x.test.ts', blobHash: 'def' }] },
      sessionId: 's1',
      createdAt: 't0',
    });
    await store.recordRound({
      round: 1,
      claim: { status: 'complete' },
      checks: { objectiveChecksPassed: false, results: [], testTamper: 'clean', tamperReason: '' },
      verdict: { outcome: 'rejected', rationale: 'checks failed' },
      at: 't1',
    });
    await store.recordState('blocked', 't2');

    const { goal, rounds } = await loadGoal(path);
    expect(goal?.id).toBe('g1');
    expect(goal?.objective).toBe(objective);
    expect(goal?.objectiveHash).toBe(hashObjective(objective));
    expect(goal?.state).toBe('blocked'); // last state transition wins
    expect(goal?.sessionId).toBe('s1');
    expect(goal?.testBaseline?.headSha).toBe('abc');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].verdict?.outcome).toBe('rejected');
  });
});

describe('parseGoalLog / replayGoal crash safety', () => {
  it('skips a truncated/garbage trailing line and recovers the rest', async () => {
    const path = join(dir, 'g2.jsonl');
    await writeFile(
      path,
      '{"t":"goal-created","id":"g2","objective":"o","objectiveHash":"h","budget":{"maxRounds":3},"sessionId":"s","createdAt":"t0"}\n' +
        '{"t":"goal-state","state":"complete","at":"t1"}\n' +
        '{"t":"goal-st', // truncated tail line
      'utf8',
    );
    const records = parseGoalLog(await readFile(path, 'utf8'));
    expect(records).toHaveLength(2); // the half-written line is skipped
    expect(replayGoal(records).goal?.state).toBe('complete');
  });

  it('fails closed when operational replay encounters a structurally invalid middle record', async () => {
    const path = join(dir, 'g-corrupt.jsonl');
    await writeFile(
      path,
      '{"t":"goal-created","id":"g","objective":"o","objectiveHash":"h","budget":{"maxRounds":1},"sessionId":"s","createdAt":"t0"}\n'
        + '{}\n'
        + '{"t":"goal-state","state":"blocked","at":"t1"}\n',
      'utf8',
    );

    await expect(loadGoal(path)).rejects.toThrow('goal state is corrupt at line 2 (invalid-record)');
  });
});
