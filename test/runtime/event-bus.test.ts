import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, type Event } from '../../src/runtime/event-bus.js';

describe('InMemoryEventBus', () => {
  it('delivers events to subscribers in emission order', () => {
    const bus = new InMemoryEventBus();
    const seen: Event[] = [];
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

  it('carries a not-yet-canonical event type without throwing (runtime forward-compat)', () => {
    const bus = new InMemoryEventBus();
    const seen: Event[] = [];
    bus.subscribe((e) => seen.push(e));

    // Simulate a producer outside the type system (a future event type / JS caller).
    const rogue = { type: 'not_a_canonical_event', payload: 42 } as unknown as Event;
    expect(() => bus.emit(rogue)).not.toThrow();
    expect(seen).toEqual([rogue]);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new InMemoryEventBus();
    const seen: Event[] = [];
    const off = bus.subscribe((e) => seen.push(e));

    bus.emit({ type: 'final', text: '1' });
    off();
    bus.emit({ type: 'final', text: '2' });

    expect(seen).toEqual([{ type: 'final', text: '1' }]);
  });

  it('treats the same handler subscribed twice as two independent registrations', () => {
    const bus = new InMemoryEventBus();
    const fn = vi.fn();
    const off1 = bus.subscribe(fn);
    bus.subscribe(fn);

    bus.emit({ type: 'final', text: 'x' }); // fires twice
    expect(fn).toHaveBeenCalledTimes(2);

    off1(); // removes only the first registration
    bus.emit({ type: 'final', text: 'y' }); // the second still fires
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('isolates a throwing subscriber: others still receive and emit never throws', () => {
    const onError = vi.fn();
    const bus = new InMemoryEventBus(onError);
    const seen: Event[] = [];

    bus.subscribe(() => {
      throw new Error('bad listener');
    });
    bus.subscribe((e) => seen.push(e));

    expect(() => bus.emit({ type: 'final', text: 'ok' })).not.toThrow();
    expect(seen).toEqual([{ type: 'final', text: 'ok' }]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
