import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createProcessInterruptSignal,
  persistInterruptedGoal,
  type ProcessSignalHost,
} from '../../src/surfaces/cli/process-interrupt.js';

function signalHost(): EventEmitter & ProcessSignalHost {
  return new EventEmitter() as EventEmitter & ProcessSignalHost;
}

describe('createProcessInterruptSignal', () => {
  it('turns the first SIGINT into one abort and one input-close request', () => {
    const host = signalHost();
    const onInterrupt = vi.fn();
    const interrupt = createProcessInterruptSignal({ host, onInterrupt });

    host.emit('SIGINT');
    host.emit('SIGTERM');

    expect(interrupt.signal.aborted).toBe(true);
    expect(interrupt.received()).toBe('SIGINT');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onInterrupt).toHaveBeenCalledWith('SIGINT');
    interrupt.dispose();
    expect(host.listenerCount('SIGINT')).toBe(0);
    expect(host.listenerCount('SIGTERM')).toBe(0);
  });

  it('removes listeners without aborting when disposed before a signal', () => {
    const host = signalHost();
    const interrupt = createProcessInterruptSignal({ host });

    interrupt.dispose();
    host.emit('SIGINT');

    expect(interrupt.signal.aborted).toBe(false);
    expect(interrupt.received()).toBeUndefined();
  });

  it('treats readline SIGINT as the same one-shot process interruption', () => {
    const host = signalHost();
    const input = signalHost();
    const onInterrupt = vi.fn();
    const interrupt = createProcessInterruptSignal({ host, input, onInterrupt });

    input.emit('SIGINT');

    expect(interrupt.signal.aborted).toBe(true);
    expect(interrupt.received()).toBe('SIGINT');
    expect(onInterrupt).toHaveBeenCalledOnce();
    interrupt.dispose();
    expect(input.listenerCount('SIGINT')).toBe(0);
  });
});

describe('persistInterruptedGoal', () => {
  it('records blocked before publishing the terminal goal state', async () => {
    const calls: string[] = [];
    await persistInterruptedGoal({
      goalId: 'goal-1',
      store: {
        async recordState(state, at) {
          calls.push(`store:${state}:${at}`);
        },
      },
      bus: {
        emit(event) {
          calls.push(`bus:${event.type}:${event.goalId}:${event.state}`);
        },
      },
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(calls).toEqual([
      'store:blocked:2026-08-31T00:00:00.000Z',
      'bus:goal_state:goal-1:blocked',
    ]);
  });
});
