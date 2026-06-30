/**
 * hooks barrel — public face of `src/capabilities/hooks` (Hooks slice 1).
 *
 * The composition root builds a {@link HookRunner} via {@link resolveHooks} (opt-in on `JARVIS_HOOKS`)
 * and threads it into runAgent; the pure {@link parseHookConfig} / {@link loadHookConfig} stay exported
 * for direct testing.
 */
export {
  loadHookConfig,
  parseHookConfig,
  type HookConfig,
  type HookEntry,
  type HookEvent,
  type LoadHookResult,
} from './hook-config.js';
export {
  createHookRunner,
  resolveHooks,
  HOOK_TIMEOUT_MS,
  type HookRunner,
  type HookBlock,
  type HookRunnerDeps,
  type RunHookCommand,
} from './hook-runner.js';
