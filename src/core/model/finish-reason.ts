import type { FinishReason } from './types.js';

/**
 * Normalize an OpenAI-compatible `finish_reason` into our canonical {@link FinishReason}.
 *
 * Pure decision point. The raw string is preserved separately on `ModelResult`
 * (`rawFinishReason`) so normalization never loses information.
 */
export function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'completed';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'truncated';
    case 'content_filter':
      return 'filtered';
    default:
      return 'other';
  }
}
