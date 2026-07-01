/**
 * hooks barrel — public face of `src/capabilities/hooks`.
 *
 * The composition root builds a {@link HookRunner} via {@link resolveHooks} from trusted sources
 * (`~/.jarvis/hooks.json` + launch-captured `JARVIS_HOOKS`) and threads it into runAgent; the pure
 * {@link parseHookConfig} / loaders stay exported for direct testing.
 */
export {
  loadHookConfig,
  loadHookConfigs,
  parseHookConfig,
  type HookConfig,
  type HookConfigSource,
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
