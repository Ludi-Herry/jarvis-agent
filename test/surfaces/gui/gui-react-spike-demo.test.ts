import { describe, expect, it } from 'vitest';
import {
  createInitialDemoState,
  demoReducer,
} from '../../../src/surfaces/gui/app/src/demo/demo-reducer.js';

describe('GUI React Spike demo authority', () => {
  it('keeps completion ungranted after allow-once and grants it only after verified', () => {
    const initial = createInitialDemoState();
    const validating = demoReducer(initial, { type: 'approve-once' });

    expect(validating.runState).toBe('validating');
    expect(validating.approval).toBe('allowed');
    expect(validating.verified).toBe(false);

    const completed = demoReducer(validating, { type: 'finish-verified' });
    expect(completed.runState).toBe('completed');
    expect(completed.verified).toBe(true);
  });

  it('restores the real activity stage after pause, terminate and recover', () => {
    const initial = createInitialDemoState();
    const paused = demoReducer(initial, { type: 'pause' });
    const interrupted = demoReducer(paused, { type: 'terminate' });
    const restored = demoReducer(interrupted, { type: 'recover' });
    const continued = demoReducer(restored, { type: 'continue' });

    expect(paused.returnState).toBe('approval');
    expect(interrupted.returnState).toBe('approval');
    expect(restored.runState).toBe('restored');
    expect(continued.runState).toBe('approval');
    expect(continued.verified).toBe(false);
  });
});
