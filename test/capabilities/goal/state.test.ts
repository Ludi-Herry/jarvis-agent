import { describe, expect, it } from 'vitest';
import { advanceGoalState } from '../../../src/capabilities/goal/state.js';

describe('advanceGoalState', () => {
  it('maps each verdict outcome to the next goal state', () => {
    expect(advanceGoalState('verified')).toBe('complete');
    expect(advanceGoalState('rejected')).toBe('active'); // keep going with a continuation
    expect(advanceGoalState('couldNotVerify')).toBe('blocked'); // fail-closed: hand to a human
  });

  it('forceBlocked routes straight to blocked (the circuit-breaker escape hatch)', () => {
    expect(advanceGoalState('verified', true)).toBe('blocked');
    expect(advanceGoalState('rejected', true)).toBe('blocked');
    expect(advanceGoalState('couldNotVerify', true)).toBe('blocked');
  });
});
