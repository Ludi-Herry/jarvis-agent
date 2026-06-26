/**
 * ModelProvider types — the unified socket for talking to a model.
 *
 * Shape follows kimi-code's `kosong` ChatProvider (knowledge base Part8 §3): an
 * immutable provider, `withThinking` / `withMaxCompletionTokens` return shallow
 * clones, and a `createProvider(config)` factory dispatches on a discriminated
 * union. Doubao is the only wire implemented in A1; Kimi/Anthropic drop in later
 * as new config variants without touching callers.
 */
import type { Message, ToolCall, ToolSchema } from '../types.js';

/** Normalized stop reason. `rawFinishReason` on ModelResult keeps the provider's
 *  original string as an escape hatch so normalization never eats information. */
export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

/** Requested thinking budget. Each provider clamps to what it supports — Doubao
 *  only distinguishes on/off, so low/medium/high all map to "enabled". */
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high';

/** What a model can do — used for request-time gating later so we fail before the
 *  network round-trip, not after. */
export interface ModelCapability {
  maxContextTokens: number;
  maxOutputTokens: number;
  thinking: boolean;
  toolUse: boolean;
  imageIn: boolean;
  videoIn: boolean;
}

/** Token accounting from the API's real usage (never estimated). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** A streamed increment. `call()` yields these as they arrive; tool-call deltas
 *  are partial (buffered by `index` into the final ToolCall[]). */
export type ModelDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string };

/** The aggregated result returned when the stream completes. */
export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
  /** Escape hatch: the provider's raw finish_reason before normalization. */
  rawFinishReason: string;
  /** Thinking content the model returned (round-trips via Message.reasoning). */
  reasoning?: string;
}

/** The provider interface every wire implements. Immutable: the `with*` builders
 *  return clones, the original is untouched. */
export interface ModelProvider {
  readonly capability: ModelCapability;
  call(
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelDelta, ModelResult>;
  withThinking(effort: ThinkingEffort): ModelProvider;
  withMaxCompletionTokens(n: number): ModelProvider;
}

/** Config for the Doubao (火山方舟 / ARK, OpenAI-compatible) wire. */
export interface DoubaoConfig {
  provider: 'doubao';
  apiKey: string;
  /** OpenAI-compatible base URL. Defaults to the ARK Beijing endpoint. */
  baseURL?: string;
  model: string;
  /** Override the reasoning field name if the endpoint uses a non-standard key. */
  reasoningKey?: string;
  /** Hard cap for max output tokens (third-party endpoints reject values above
   *  their limit). Defaults to the model's capability max. */
  maxOutputCap?: number;
}

/** Discriminated union the factory dispatches on. Grows with each new wire:
 *  `| KimiConfig | AnthropicConfig`. */
export type ProviderConfig = DoubaoConfig;
