/**
 * DoubaoProvider — the 火山方舟 / ARK wire, OpenAI-compatible. Named for the model family it was
 * written against; it is the generic implementation for every model Ark serves through that
 * endpoint (the default model id lives in config.ts, today a DeepSeek one).
 *
 * Shaped after kimi-code's `kosong` ChatProvider (knowledge base Part8 §3):
 *  - immutable: `withThinking` / `withMaxCompletionTokens` return shallow clones
 *    that share the same HTTP transport (the OpenAI client) and only swap kwargs.
 *  - `call()` streams deltas and returns an aggregated ModelResult.
 *
 * Request building and stream folding live in `request.ts` / `stream.ts` as pure
 * functions, so this class stays a thin stateful shell over tested logic.
 */
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { Message, ToolSchema } from '../types.js';
import type {
  DoubaoConfig,
  ModelCapability,
  ModelDelta,
  ModelProvider,
  ModelResult,
  ThinkingEffort,
} from './types.js';
import { buildChatParams, type DoubaoChatParams } from './request.js';
import { emptyStreamState, finalizeResult, foldChunk, type StreamChunk } from './stream.js';
import { describeModelError } from './errors.js';

export const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/** Doubao-Seed-2.1-pro capability (knowledge base: 256K context / 128K output). */
export const DOUBAO_SEED_PRO_CAPABILITY: ModelCapability = {
  maxContextTokens: 262_144,
  maxOutputTokens: 131_072,
  thinking: true,
  toolUse: true,
  imageIn: false,
  videoIn: false,
};

/** DeepSeek-V4 (pro and flash) capability. Evidence: Ark `GET /api/v3/models` on 2026-07-25 reports
 *  `context_window: 1048576`, `max_output_token_length: 393216` for both `deepseek-v4-pro-260425`
 *  and `deepseek-v4-flash-260425`. */
export const DEEPSEEK_V4_CAPABILITY: ModelCapability = {
  maxContextTokens: 1_048_576,
  maxOutputTokens: 393_216,
  thinking: true,
  toolUse: true,
  imageIn: false,
  videoIn: false,
};

/**
 * Which capability a model id gets. One Ark endpoint serves several families whose windows differ
 * 4x, and the ContextManager compacts against this number — a wrong one either wastes most of the
 * window or overruns it mid-session. Matching is by family prefix because Ark ids carry a date
 * suffix (`deepseek-v4-pro-260425`); anything unrecognized falls back to the SMALLER Doubao numbers,
 * which only compacts earlier than necessary rather than blowing the request.
 *
 * Pure decision point.
 */
export function capabilityForModel(model: string): ModelCapability {
  return model.startsWith('deepseek-v4-') ? DEEPSEEK_V4_CAPABILITY : DOUBAO_SEED_PRO_CAPABILITY;
}

/** Per-clone kwargs — the only things `with*` builders change. */
interface DoubaoKwargs {
  thinking?: ThinkingEffort;
  maxCompletionTokens?: number;
}

export class DoubaoProvider implements ModelProvider {
  readonly capability: ModelCapability;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly reasoningKey?: string;
  private readonly maxOutputCap: number;
  private readonly kwargs: DoubaoKwargs;

  constructor(config: DoubaoConfig, client?: OpenAI, kwargs: DoubaoKwargs = {}) {
    this.model = config.model;
    this.capability = capabilityForModel(config.model); // must precede maxOutputCap, which reads it
    this.reasoningKey = config.reasoningKey;
    this.maxOutputCap = config.maxOutputCap ?? this.capability.maxOutputTokens;
    // Reuse the injected client on clones so the HTTP transport is shared.
    this.client =
      client ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? DEFAULT_ARK_BASE_URL,
      });
    this.kwargs = kwargs;
  }

  /** Build the request body for these messages/tools with the current kwargs.
   *  Exposed (beyond the ModelProvider interface) so tests can assert thinking is
   *  actually disabled without a network call. */
  buildParams(messages: Message[], tools: ToolSchema[]): DoubaoChatParams {
    return buildChatParams({
      model: this.model,
      messages,
      tools,
      thinking: this.kwargs.thinking,
      maxCompletionTokens: this.kwargs.maxCompletionTokens,
      maxOutputCap: this.maxOutputCap,
    });
  }

  async *call(
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelDelta, ModelResult> {
    const params = this.buildParams(messages, tools);
    const state = emptyStreamState();
    try {
      const stream = await this.client.chat.completions.create(
        params as unknown as ChatCompletionCreateParamsStreaming,
        { signal },
      );
      for await (const chunk of stream) {
        for (const delta of foldChunk(state, chunk as unknown as StreamChunk, this.reasoningKey)) {
          yield delta;
        }
      }
    } catch (err) {
      // A deliberate cancel is not a failure — let the caller see the abort as-is.
      if (signal?.aborted) throw err;
      throw describeModelError(err, this.model);
    }
    return finalizeResult(state);
  }

  private clone(kwargs: DoubaoKwargs): DoubaoProvider {
    return new DoubaoProvider(
      {
        provider: 'doubao',
        apiKey: '', // unused: the shared client already holds credentials
        model: this.model,
        reasoningKey: this.reasoningKey,
        maxOutputCap: this.maxOutputCap,
      },
      this.client,
      { ...this.kwargs, ...kwargs },
    );
  }

  withThinking(effort: ThinkingEffort): ModelProvider {
    return this.clone({ thinking: effort });
  }

  withMaxCompletionTokens(n: number): ModelProvider {
    return this.clone({ maxCompletionTokens: n });
  }
}
