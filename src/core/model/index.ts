/**
 * ModelProvider barrel — the unified socket for talking to a model.
 * See docs/phase-A-plan.md §3.1.
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
export { loadDoubaoConfig, DEFAULT_ARK_MODEL } from './config.js';
export { normalizeFinishReason } from './finish-reason.js';
export { extractReasoning } from './reasoning.js';
export { clampMaxTokens } from './clamp.js';
export { buildChatParams, sanitizeToolCallId, type DoubaoChatParams } from './request.js';
export {
  foldChunk,
  finalizeResult,
  emptyStreamState,
  type StreamChunk,
  type StreamState,
} from './stream.js';
export { describeModelError } from './errors.js';
