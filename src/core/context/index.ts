/**
 * Context barrel — public face of `src/core/context`.
 *
 * The loop/demo build a {@link DefaultContextManager} and inject it as `ctx.context`; the
 * pure split helpers stay exported for direct testing (plan §3.5).
 */
export { DefaultContextManager, SUMMARY_MARKER } from './context-manager.js';
export type { ContextManager, ContextManagerOptions } from './context-manager.js';
export { canSplitAfter, findSplitPoint } from './split.js';
