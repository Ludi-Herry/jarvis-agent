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
    baseURL: env.ARK_BASE_URL ?? DEFAULT_ARK_BASE_URL,
    model: env.ARK_MODEL ?? DEFAULT_ARK_MODEL,
    ...(env.ARK_REASONING_KEY ? { reasoningKey: env.ARK_REASONING_KEY } : {}),
  };
}
