/**
 * Request construction for the Doubao (OpenAI-compatible) wire — pure functions.
 *
 * Kept separate from the provider so the request body is inspectable and testable
 * without a network call: the "did `withThinking('off')` actually disable thinking"
 * check is a deterministic assertion on `buildChatParams` output, not a token burn.
 *
 * Bakes in OpenAI-compat gotchas (knowledge base Part8 §5):
 *  - streaming usage requires `stream_options.include_usage` (§5.6)
 *  - Doubao defaults thinking ON; `off` sends `thinking:{type:'disabled'}` (§1, plan §1)
 *  - tool_call_id truncated to ≤64 chars (§5.4)
 *  - max output sent as the clamped value only when explicitly requested (§5.2)
 */
import type { Message, ToolSchema } from '../types.js';
import type { ThinkingEffort } from './types.js';
import { clampMaxTokens } from './clamp.js';

/** ARK / OpenAI-compatible tool-call id limit. */
const TOOL_CALL_ID_MAX = 64;

/** Truncate a tool_call_id to the endpoint's limit. */
export function sanitizeToolCallId(id: string): string {
  return id.length > TOOL_CALL_ID_MAX ? id.slice(0, TOOL_CALL_ID_MAX) : id;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: WireToolCall[];
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface WireTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** The request body we send. Superset of the SDK's typed params: it includes the
 *  Doubao-specific `thinking` field, so we cast once at the `create()` boundary. */
export interface DoubaoChatParams {
  model: string;
  messages: WireMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: WireTool[];
  thinking?: { type: 'enabled' | 'disabled' };
  max_tokens?: number;
}

export interface BuildChatParamsInput {
  model: string;
  messages: Message[];
  tools: ToolSchema[];
  /** Undefined = don't send `thinking` (server default, which for Doubao is ON). */
  thinking?: ThinkingEffort;
  /** Undefined = don't send a cap (let the server decide). */
  maxCompletionTokens?: number;
  /** Hard ceiling for `maxCompletionTokens`. */
  maxOutputCap: number;
}

function toWireMessages(messages: Message[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const msg: Extract<WireMessage, { role: 'assistant' }> = {
          role: 'assistant',
          content: m.content ?? '',
        };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: sanitizeToolCallId(tc.id),
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        if (m.reasoning) msg.reasoning_content = m.reasoning;
        return msg;
      }
      case 'tool':
        return {
          role: 'tool',
          tool_call_id: sanitizeToolCallId(m.toolCallId),
          content: m.content,
        };
    }
  });
}

function toWireTools(tools: ToolSchema[]): WireTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Build the streaming chat-completion request body from canonical inputs.
 * Pure: same inputs always produce the same body.
 */
export function buildChatParams(input: BuildChatParamsInput): DoubaoChatParams {
  const params: DoubaoChatParams = {
    model: input.model,
    messages: toWireMessages(input.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (input.tools.length > 0) params.tools = toWireTools(input.tools);
  if (input.thinking !== undefined) {
    params.thinking = { type: input.thinking === 'off' ? 'disabled' : 'enabled' };
  }
  if (input.maxCompletionTokens !== undefined) {
    params.max_tokens = clampMaxTokens(input.maxCompletionTokens, input.maxOutputCap);
  }
  return params;
}
