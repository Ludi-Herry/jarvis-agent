/**
 * runtime layer — EventBus (A) · PermissionGate (B1) · SessionStore (persistence segment).
 *
 * A1 lands the EventBus (see docs/phase-A-plan.md §3.2). B1 lands the PermissionGate, the runtime
 * enforcer the loop consults before any tool side effect (docs/phase-B-plan.md §3.2). The
 * persistence segment lands the SessionStore — append-only JSONL so a session resumes after a
 * crash/exit (docs/persistence-plan.md §3.1).
 */
export { InMemoryEventBus, type EventBus, type Event, type Subscriber } from './event-bus.js';
export * from './agent-events.js';
export * from './control/index.js';
export * from './config/index.js';
export * from './permission/index.js';
export * from './sandbox/index.js';
export * from './session/index.js';
