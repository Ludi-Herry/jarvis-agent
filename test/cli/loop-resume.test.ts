import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLoopCliError, loadLoopGoalResume } from '../../src/surfaces/cli/loop-resume.js';
import { FileGoalStore, hashObjective } from '../../src/capabilities/index.js';
import {
  FileSessionStore,
  NO_DYNAMIC_ADDENDUM,
  createModelRequestReceipt,
  createSessionComposition,
} from '../../src/runtime/index.js';
import type { Message } from '../../src/core/index.js';

let dir: string;
const composition = createSessionComposition({
  root: 'loop',
  runtimeVersion: 'test',
  permissionMode: 'interactive',
  toolSchemas: [],
  systemPrompt: 'test prompt',
  dynamicAddendum: NO_DYNAMIC_ADDENDUM,
});

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
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition });
    await sessionStore.sync(messages);

    const loaded = await loadLoopGoalResume(goalPath, sessionPath, 'g1', dir, composition, 'm');

    expect(loaded.resume.goal.id).toBe('g1');
    expect(loaded.resume.rounds).toHaveLength(1);
    expect(loaded.resume.messages).toEqual(messages);
    expect(loaded.initialCursor).toBe(messages.length);
    expect(loaded.sessionFormat).toBe('v2');
    expect(loaded.initialSequence).toBeGreaterThan(0);
  });

  it('requires a current composition proof for every v2 loop resume', async () => {
    const goalPath = join(dir, 'g-proof.jsonl');
    const sessionPath = join(dir, 's-proof.jsonl');
    const goalStore = new FileGoalStore(goalPath);
    await goalStore.writeCreated({
      id: 'g1', objective: 'do the thing', objectiveHash: hashObjective('do the thing'), budget: { maxRounds: 3 },
      pinned: [], sessionId: 'g1', createdAt: 't0',
    });
    const sessionStore = new FileSessionStore(sessionPath);
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition });

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1'))
      .rejects.toThrow(/current session composition proof is required/);
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
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition });

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
    await sessionStore.writeHeader({ id: 'other', model: 'm', cwd: dir, startedAt: 't0', composition });

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

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1')).rejects.toThrow(/missing (session )?header/);
  });

  it('fails closed when the session cwd does not match the expected resumed worktree', async () => {
    const goalPath = join(dir, 'g-cwd.jsonl');
    const sessionPath = join(dir, 's-cwd.jsonl');
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
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: join(dir, 'wrong-worktree'), startedAt: 't0', composition });

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1', join(dir, 'expected-worktree'))).rejects.toThrow(/does not match/);
  });

  it('fails closed when a persisted tool intent has no terminal receipt', async () => {
    const goalPath = join(dir, 'g-pending.jsonl');
    const sessionPath = join(dir, 's-pending.jsonl');
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
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition });
    const initialMessages: Message[] = [{ role: 'system', content: 'system' }];
    await sessionStore.sync(initialMessages);
    await sessionStore.recordRequest(createModelRequestReceipt({
      requestId: 'req-1',
      runId: 'run-1',
      turn: 0,
      messages: initialMessages,
      tools: [],
    }));
    await sessionStore.sync([
      ...initialMessages,
      {
        role: 'assistant',
        requestId: 'req-1',
        toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"a.txt","content":"x","createOnly":true}' }],
      },
    ]);

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1')).rejects.toThrow(/unresolved tool execution/);
  });

  it('fails closed when compaction omits a persisted assistant tool intent', async () => {
    const goalPath = join(dir, 'g-compacted-pending.jsonl');
    const sessionPath = join(dir, 's-compacted-pending.jsonl');
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
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition });
    const initialMessages: Message[] = [{ role: 'system', content: 'system' }];
    await sessionStore.sync(initialMessages);
    await sessionStore.recordRequest(createModelRequestReceipt({
      requestId: 'req-1', runId: 'run-1', turn: 0, messages: initialMessages, tools: [],
    }));
    await sessionStore.sync([
      ...initialMessages,
      {
        role: 'assistant',
        requestId: 'req-1',
        toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"a.txt","content":"x","createOnly":true}' }],
      },
    ]);
    await sessionStore.checkpoint(initialMessages);

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1')).rejects.toThrow(/unresolved tool execution/);
  });

  it('fails closed when the v2 composition changed', async () => {
    const goalPath = join(dir, 'g-composition.jsonl');
    const sessionPath = join(dir, 's-composition.jsonl');
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
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition });
    const changed = createSessionComposition({
      root: 'loop',
      runtimeVersion: 'changed',
      permissionMode: 'interactive',
      toolSchemas: [],
      systemPrompt: 'test prompt',
      dynamicAddendum: NO_DYNAMIC_ADDENDUM,
    });

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1', dir, changed, 'm')).rejects.toThrow(/composition changed/);
  });

  it('fails closed when a v2 session has only partial composition coverage', async () => {
    const goalPath = join(dir, 'g-partial-composition.jsonl');
    const sessionPath = join(dir, 's-partial-composition.jsonl');
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
    const partial = createSessionComposition({
      root: 'loop', runtimeVersion: 'test', permissionMode: 'interactive', systemPrompt: 'test prompt',
      dynamicAddendum: NO_DYNAMIC_ADDENDUM,
    });
    const sessionStore = new FileSessionStore(sessionPath);
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition: partial });

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1', dir, composition, 'm')).rejects.toThrow(/coverage is partial/);
  });

  it('fails closed when an older v2 loop session lacks dynamic addendum provenance', async () => {
    const goalPath = join(dir, 'g-dynamic-provenance.jsonl');
    const sessionPath = join(dir, 's-dynamic-provenance.jsonl');
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
    const oldComposition = createSessionComposition({
      root: 'loop', runtimeVersion: 'test', permissionMode: 'interactive', toolSchemas: [], systemPrompt: 'test prompt',
    });
    const sessionStore = new FileSessionStore(sessionPath);
    await sessionStore.writeHeader({ id: 'g1', model: 'm', cwd: dir, startedAt: 't0', composition: oldComposition });

    await expect(loadLoopGoalResume(goalPath, sessionPath, 'g1', dir, composition, 'm'))
      .rejects.toThrow(/dynamic addendum provenance is incomplete/);
  });
});

describe('formatLoopCliError', () => {
  it.each(['[loop resume]', '[loop] fatal:'])('single-lines hostile %s output', (prefix) => {
    const escape = String.fromCharCode(27);
    const attack = new Error(`blocked${escape}[2J${escape}[31m\r\nFORGED-LOOP-LINE`);

    const text = formatLoopCliError(prefix, attack);

    expect(text).not.toContain(escape);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\nFORGED-LOOP-LINE');
    expect(text).toContain(`${prefix} blocked [2J [31m FORGED-LOOP-LINE`);
  });
});
