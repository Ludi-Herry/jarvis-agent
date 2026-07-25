/**
 * Read the Ark (火山方舟) provider config from the environment.
 *
 * The only side effect is reading `env` (defaults to `process.env`); pass a fake
 * env to test it. The API key is required and has no default — it is never logged
 * or committed. baseURL/model fall back to the known ARK defaults so the harness
 * runs even when only the secret is set.
 */
import type { DoubaoConfig } from './types.js';
import { DEFAULT_ARK_BASE_URL } from './doubao-provider.js';

/** Ark model id used when ARK_MODEL is unset. Doubao stays the Ark default (user decision
 *  2026-07-25: a future DeepSeek switch will go through DeepSeek's own API, not Ark); DS-family
 *  ids on Ark remain valid for e.g. a cross-family ARK_VERIFIER_MODEL — capabilityForModel
 *  in doubao-provider.ts sizes the window per model id either way. */
export const DEFAULT_ARK_MODEL = 'doubao-seed-2-1-pro-260628';

export function loadDoubaoConfig(env: NodeJS.ProcessEnv = process.env): DoubaoConfig {
  const apiKey = env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ARK_API_KEY is not set. Set the environment variable or copy .env.example to .env and fill it in.',
    );
  }
  return {
    provider: 'doubao',
    apiKey,
    // `||` not `??`: a present-but-blank `ARK_BASE_URL=` / `ARK_MODEL=` should fall
    // back to the default (matching how `if (!apiKey)` above treats blank as unset),
    // otherwise an empty string would silently override the endpoint/model.
    baseURL: env.ARK_BASE_URL || DEFAULT_ARK_BASE_URL,
    model: env.ARK_MODEL || DEFAULT_ARK_MODEL,
    ...(env.ARK_REASONING_KEY ? { reasoningKey: env.ARK_REASONING_KEY } : {}),
  };
}

/**
 * After the provider has been built (it captured the key into its HTTP client), delete the API key from
 * the process environment. The child-env scrub only cleans a model-facing shell's COPY of the env; the
 * long-lived PARENT (node) env still holds the key, so on Linux a model-facing bash could read it back
 * via `/proc/<pid>/environ` or `ps e`. Removing it at the source closes that on every platform. Config
 * ids (`ARK_MODEL`/`ARK_BASE_URL`/`ARK_VERIFIER_MODEL`) are NOT secrets and stay (resolveVerifierConfig
 * still needs `ARK_VERIFIER_MODEL`). Call it right after `createProvider`, before any model-facing bash.
 */
export function scrubProviderKeyFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env.ARK_API_KEY;
}

/**
 * COMPLETE /proc closure (Linux): refuse to run when the API key came from the LAUNCH environment.
 *
 * `scrubProviderKeyFromEnv` deletes the key from the runtime env, but on Linux `/proc/<pid>/environ` is
 * a snapshot of the EXECVE-time environment — immutable to a runtime unset — readable by anything the
 * agent runs as the same uid (its own bash, `ps e`, or an interpreter reading /proc). Re-exec can't fix
 * it either: Node has no `execve`, so the relay-parent (and npm/shell above it) keep the key in their
 * own /proc. The only complete closure is to keep the key out of EVERY ancestor's launch env — load it
 * from a runtime source (`.env`), which `process.loadEnvFile` injects AFTER execve, so it never lands in
 * any /proc/environ. So on Linux we refuse a launch-env key and direct the user to `.env`. Windows/macOS
 * don't expose another process's env this way, so the guard is Linux-only (no workflow change there).
 *
 * `keyInLaunchEnv` MUST be captured BEFORE any runtime `.env` load (a key present only after that load
 * came from `.env` and is safe; a key present before it came from the shell launch env and is not).
 */
export function assertKeyNotInLaunchEnv(
  keyInLaunchEnv: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'linux' && keyInLaunchEnv) {
    throw new Error(
      'ARK_API_KEY is set in the launch environment. On Linux that leaks it via /proc/<pid>/environ to ' +
        'every command the agent runs (it is the execve-time env, immune to a runtime unset). Put ' +
        'ARK_API_KEY in a .env file (loaded at runtime, never written to /proc) and unset it from the ' +
        'shell, then re-run.',
    );
  }
}

/** Whether leg 3 (the independent LLM judge) is enabled, and if so with what config. */
export type VerifierResolution =
  | { enabled: true; config: DoubaoConfig }
  | { enabled: false; reason: string };

/**
 * Decide whether to enable leg 3 from `ARK_VERIFIER_MODEL`, reusing the builder's key/baseURL with a
 * different model. The independence assertion (verifier model ≠ builder model) is done HERE, at the
 * config-string layer, because {@link ModelProvider} exposes no model-id getter — the only place the
 * two model ids are comparable. Three outcomes:
 *  - unset → disabled (the batch-1 deterministic-only fallback);
 *  - set and ≠ the builder model → enabled (a genuinely different model);
 *  - set and === the builder model → DISABLED with a loud reason. Same-model independence is theater
 *    (a Doubao variant judging another Doubao variant of the SAME id shares all blind spots), so we
 *    fall back to the deterministic legs rather than pretend.
 */
export function resolveVerifierConfig(
  env: NodeJS.ProcessEnv,
  builderConfig: DoubaoConfig,
): VerifierResolution {
  const model = env.ARK_VERIFIER_MODEL?.trim();
  if (!model) {
    return { enabled: false, reason: 'ARK_VERIFIER_MODEL not set — leg 3 disabled (deterministic legs only)' };
  }
  if (model === builderConfig.model) {
    return {
      enabled: false,
      reason: `ARK_VERIFIER_MODEL equals the builder model (${model}) — same-model independence is theater; leg 3 disabled`,
    };
  }
  return { enabled: true, config: { ...builderConfig, model } };
}

/** Whether the vision tool is enabled, and if so with what config. */
export type VisionResolution =
  | { enabled: true; config: DoubaoConfig }
  | { enabled: false; reason: string };

/**
 * Decide whether to register the vision tool from `ARK_VISION_MODEL`, reusing the builder's key/baseURL
 * with a VISION model id. Unlike the verifier there is no "equals builder" theater check — a vision
 * model is a different KIND of model (the text builder genuinely can't see), so naming one is always the
 * point. Unset → the harness stays text-only (no vision tool registered).
 */
export function resolveVisionConfig(env: NodeJS.ProcessEnv, builderConfig: DoubaoConfig): VisionResolution {
  const model = env.ARK_VISION_MODEL?.trim();
  if (!model) {
    return { enabled: false, reason: 'ARK_VISION_MODEL not set — vision tool disabled (text-only)' };
  }
  return { enabled: true, config: { ...builderConfig, model } };
}
