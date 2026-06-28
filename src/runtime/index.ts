/**
 * runtime layer — EventBus (A phase) · PermissionGate (B1); SessionStore · Persistence (later).
 *
 * A1 lands the EventBus (see docs/phase-A-plan.md §3.2). B1 lands the PermissionGate, the
 * runtime enforcer the agent loop consults before any tool side effect (docs/phase-B-plan.md §3.2).
 */
export { InMemoryEventBus, type EventBus, type Event, type Subscriber } from './event-bus.js';
export * from './permission/index.js';
