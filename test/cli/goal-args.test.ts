import { describe, expect, it } from 'vitest';
import { parseGoalArgs } from '../../src/surfaces/cli/goal-args.js';

describe('parseGoalArgs', () => {
  it('parses a plain objective', () => {
    expect(parseGoalArgs(['do', 'the', 'thing'])).toEqual({
      objective: 'do the thing',
      failOnWorktreeChange: false,
    });
  });

  it('parses the explicit fail-on-worktree-change policy without adding it to the objective', () => {
    expect(parseGoalArgs(['--fail-on-worktree-change', 'do not edit files'])).toEqual({
      objective: 'do not edit files',
      failOnWorktreeChange: true,
    });
  });

  it('rejects unknown flags so typoed safety config is visible', () => {
    expect(() => parseGoalArgs(['--fail-on-worktree-chagne', 'objective'])).toThrow(/unknown flag/);
  });
});
