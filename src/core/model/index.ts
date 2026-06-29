/**
 * ModelProvider barrel — the unified socket for talking to a model (plan §3.1).
 *
 * Public surface only: the provider API + config + capability. The internal pure
 * helpers (request building, stream folding, finish-reason / reasoning / clamp,
 * error mapping) stay module-private — their unit tests deep-import the concrete
 * files directly, so nothing needs them re-exported here.
 */
export type {
  FinishReason,
  ThinkingEffort,
  ModelCapability,
  Usage,
  ModelDelta,
  ModelResult,
  ModelProvider,
  DoubaoConfig,
  ProviderConfig,
} from './types.js';
export { createProvider } from './create-provider.js';
export {
  DoubaoProvider,
  DEFAULT_ARK_BASE_URL,
  DOUBAO_SEED_PRO_CAPABILITY,
} from './doubao-provider.js';
export {
  loadDoubaoConfig,
  resolveVerifierConfig,
  scrubProviderKeyFromEnv,
  assertKeyNotInLaunchEnv,
  DEFAULT_ARK_MODEL,
  type VerifierResolution,
} from './config.js';
