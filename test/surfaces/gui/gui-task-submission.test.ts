import { describe, expect, it, vi } from 'vitest';
import { submitTaskDraft } from '../../../src/surfaces/gui/app/src/live/api.js';
import type { GuiFreeTaskInput } from '../../../src/surfaces/gui/app/src/live/api.js';

const draft: GuiFreeTaskInput = {
  objective: 'Fix the description', cwd: 'H:/fixture', writePaths: ['answer.mjs'],
  checkCommands: ['node --check answer.mjs'], maxRounds: 2, maxTurns: 6, wallClockMs: 600_000,
};

describe('GUI task submission', () => {
  it('ignores a second click during validation and commits exactly the validated draft', async () => {
    let release!: (ok: boolean) => void;
    const validate = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const commit = vi.fn(async () => undefined);
    const lock = { current: false };
    const first = submitTaskDraft(lock, draft, validate, commit);
    await submitTaskDraft(lock, { ...draft, objective: 'Changed during validation' }, validate, commit);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    release(true);
    await first;
    expect(commit).toHaveBeenCalledExactlyOnceWith(draft);
    expect(lock.current).toBe(false);
  });

  it('does not create an invalid task and releases the lock after a failed request', async () => {
    const lock = { current: false };
    const commit = vi.fn(async () => undefined);
    await submitTaskDraft(lock, draft, async () => false, commit);
    expect(commit).not.toHaveBeenCalled();
    await expect(submitTaskDraft(lock, draft, async () => true, async () => {
      throw new Error('Creation failed');
    })).rejects.toThrow('Creation failed');
    expect(lock.current).toBe(false);
    await submitTaskDraft(lock, draft, async () => true, commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith(draft);
  });
});
