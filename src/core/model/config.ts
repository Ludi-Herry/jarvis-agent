/**
 * Read Doubao config from the environment.
 *
 * The only side effect is reading `env` (defaults to `process.env`); pass a fake
 * env to test it. The API key is required and has no default — it is never logged
 * or committed. baseURL/model fall back to the known ARK defaults so the harness
 * runs even when only the secret is set.
 */
import type { DoubaoConfig } from './types.js';
import { DEFAULT_ARK_BASE_URL } from './doubao-provider.js';

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
