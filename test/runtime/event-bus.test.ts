import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, type AnyEvent } from '../../src/runtime/event-bus.js';

describe('InMemoryEventBus', () => {
  it('delivers events to subscribers in emission order', () => {
    const bus = new InMemoryEventBus();
    const seen: AnyEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.emit({ type: 'message_delta', text: 'a' });
    bus.emit({ type: 'usage', inputTokens: 1, outputTokens: 2 });
    bus.emit({ type: 'final', text: 'done' });

    expect(seen).toEqual([
      { type: 'message_delta', text: 'a' },
      { type: 'usage', inputTokens: 1, outputTokens: 2 },
      { type: 'final', text: 'done' },
    ]);
  });

  it('carries an unknown event type without throwing', () => {
    const bus = new InMemoryEventBus();
    const seen: AnyEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    expect(() => bus.emit({ type: 'not_a_canonical_event', payload: 42 })).not.toThrow();
    expect(seen).toEqual([{ type: 'not_a_canonical_event', payload: 42 }]);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new InMemoryEventBus();
    const seen: AnyEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));

    bus.emit({ type: 'final', text: '1' });
    off();
    bus.emit({ type: 'final', text: '2' });

    expect(seen).toEqual([{ type: 'final', text: '1' }]);
  });

  it('isolates a throwing subscriber: others still receive and emit never throws', () => {
    const onError = vi.fn();
    const bus = new InMemoryEventBus(onError);
    const seen: AnyEvent[] = [];

    bus.subscribe(() => {
      throw new Error('bad listener');
    });
    bus.subscribe((e) => seen.push(e));

    expect(() => bus.emit({ type: 'final', text: 'ok' })).not.toThrow();
    expect(seen).toEqual([{ type: 'final', text: 'ok' }]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
