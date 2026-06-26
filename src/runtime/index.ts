/**
 * runtime layer — EventBus (A phase); SessionStore · PermissionGate · Persistence (later).
 *
 * A1 lands the EventBus (see docs/phase-A-plan.md §3.2).
 */
export { InMemoryEventBus, type EventBus, type Event, type Subscriber } from './event-bus.js';
