import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLoopGoalResume } from '../../src/surfaces/cli/loop-resume.js';
import { FileGoalStore, hashObjective } from '../../src/capabilities/index.js';
import { FileSessionStore } from '../../src/runtime/index.js';
import type { Message } from '../../src/core/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loop-resume-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadLoopGoalResume', () => {
  it('loads an in-flight goal and session with the correct append cursor', async () => {
    const goalPath = join(dir, 'g.jsonl');
    const sessionPath = join(dir, 's.jsonl');
    const goalStore = new FileGoalStore(goalPath);
    await goalStore.writeCreated({
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 'g1',
      createdAt: 't0',
    });
    await goalStore.recordRound({
      round: 1,
      claim: { status: 'complete' },
      verdict: { outcome: 'rejected', rationale: 'failed' },
      at: 't1',
    });

    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'working' },
    ];
    const sessionStore = new FileSessionStore(sessionPath);
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0' });
    await sessionStore.sync(messages);

    const loaded = await loadLoopGoalResume(goalPath, sessionPath, 'g1');

    expect(loaded.resume.goal.id).toBe('g1');
    expect(loaded.resume.rounds).toHaveLength(1);
    expect(loaded.resume.messages).toEqual(messages);
    expect(loaded.initialCursor).toBe(messages.length);
  });

  it('fails closed on duplicate goal-created headers instead of letting the later one overwrite replay state', async () => {
    const goalPath = join(dir, 'g-dup.jsonl');
    const sessionPath = join(dir, 's-dup.jsonl');
    const goalStore = new FileGoalStore(goalPath);
    const base = {
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 'g1',
      createdAt: 't0',
    };
    await goalStore.writeCreated(base);
    await goalStore.writeCreated({ ...base, budget: { maxRounds: 999 }, createdAt: 't1' });
    const sessionStore = new FileSessionStore(sessionPath);
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0' });

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1')).rejects.toThrow(/duplicate goal-created/);
  });

  it('fails closed when the session header belongs to a different goal id', async () => {
    const goalPath = join(dir, 'g-session.jsonl');
    const sessionPath = join(dir, 's-session.jsonl');
    const goalStore = new FileGoalStore(goalPath);
    await goalStore.writeCreated({
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 'g1',
      createdAt: 't0',
    });
    const sessionStore = new FileSessionStore(sessionPath);
    await sessionStore.writeHeader({ id: 'other', model: 'm', cwd: dir, startedAt: 't0' });

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1')).rejects.toThrow(/session log belongs to other/);
  });

  it('fails closed when the session log has no header', async () => {
    const goalPath = join(dir, 'g-no-session-header.jsonl');
    const sessionPath = join(dir, 's-no-session-header.jsonl');
    const goalStore = new FileGoalStore(goalPath);
    await goalStore.writeCreated({
      id: 'g1',
      objective: 'do the thing',
      objectiveHash: hashObjective('do the thing'),
      budget: { maxRounds: 3 },
      pinned: [],
      sessionId: 'g1',
      createdAt: 't0',
    });
    const sessionStore = new FileSessionStore(sessionPath);
    await sessionStore.sync([{ role: 'user', content: 'forged message without header' }]);

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1')).rejects.toThrow(/missing session header/);
  });
});
