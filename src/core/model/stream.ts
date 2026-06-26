/**
 * Streaming aggregation — folds OpenAI-compatible chunks into a ModelResult.
 *
 * The stateful `call()` generator is a thin wrapper over these: each chunk is
 * `foldChunk`'d into a plain accumulator and `finalizeResult` produces the result.
 * Pulling the logic out here makes the two trickiest OpenAI-compat gotchas
 * (knowledge base Part8 §5) unit-testable without a network call:
 *  - tool_calls stream in fragments keyed by `index` — buffer and concat (§5.6)
 *  - usage may sit in `choices[0].usage` instead of top-level (§5.5)
 */
import type { ToolCall } from '../types.js';
import type { ModelDelta, ModelResult } from './types.js';
import { normalizeFinishReason } from './finish-reason.js';
import { extractReasoning } from './reasoning.js';

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Minimal structural view of a streamed chunk — only the fields we read. We type
 *  it ourselves (not the SDK's `ChatCompletionChunk`) because Doubao adds
 *  `reasoning_content` and may stash `usage` inside a choice. */
export interface StreamChunk {
  choices?: Array<{
    delta?: Record<string, unknown> | null;
    finish_reason?: string | null;
    usage?: RawUsage | null;
  }>;
  usage?: RawUsage | null;
}

interface ToolCallBuffer {
  id: string;
  name: string;
  arguments: string;
}

/** The mutable accumulator the generator threads through `foldChunk`. */
export interface StreamState {
  text: string;
  reasoning: string;
  /** Buffered by tool-call index; arguments concatenated across chunks. */
  toolCalls: Map<number, ToolCallBuffer>;
  usage?: RawUsage;
  rawFinishReason?: string;
}

export function emptyStreamState(): StreamState {
  return { text: '', reasoning: '', toolCalls: new Map() };
}

/**
 * Fold one chunk into `state` (mutates it) and return the deltas to yield.
 * `reasoningKey` overrides the reasoning field name for non-standard endpoints.
 */
export function foldChunk(
  state: StreamState,
  chunk: StreamChunk,
  reasoningKey?: string,
): ModelDelta[] {
  const deltas: ModelDelta[] = [];

  // usage: top-level first (the include_usage final chunk), then the private slot.
  const usage = chunk.usage ?? chunk.choices?.[0]?.usage;
  if (usage) state.usage = usage;

  const choice = chunk.choices?.[0];
  if (!choice) return deltas;

  if (typeof choice.finish_reason === 'string') state.rawFinishReason = choice.finish_reason;

  const delta = choice.delta;
  if (!delta) return deltas;

  const reasoning = extractReasoning(delta, reasoningKey);
  if (reasoning) {
    state.reasoning += reasoning;
    deltas.push({ type: 'reasoning', text: reasoning });
  }

  const content = delta.content;
  if (typeof content === 'string' && content.length > 0) {
    state.text += content;
    deltas.push({ type: 'text', text: content });
  }

  const toolCalls = delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>) {
      const index = tc.index ?? 0;
      const buf = state.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) buf.id = tc.id;
      if (tc.function?.name) buf.name = tc.function.name;
      if (tc.function?.arguments) buf.arguments += tc.function.arguments;
      state.toolCalls.set(index, buf);
      deltas.push({
        type: 'tool_call',
        index,
        id: tc.id,
        name: tc.function?.name,
        argumentsDelta: tc.function?.arguments,
      });
    }
  }

  return deltas;
}

/** Collapse the accumulator into the final ModelResult. */
export function finalizeResult(state: StreamState): ModelResult {
  const toolCalls: ToolCall[] = [...state.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, buf]) => ({ id: buf.id, name: buf.name, arguments: buf.arguments }));

  return {
    text: state.text,
    toolCalls,
    usage: {
      inputTokens: state.usage?.prompt_tokens ?? 0,
      outputTokens: state.usage?.completion_tokens ?? 0,
      ...(state.usage?.prompt_tokens_details?.cached_tokens !== undefined
        ? { cachedInputTokens: state.usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
    finishReason: normalizeFinishReason(state.rawFinishReason),
    rawFinishReason: state.rawFinishReason ?? '',
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
  };
}
