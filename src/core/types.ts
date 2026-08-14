/**
 * Shared domain vocabulary used across model, tools, and events.
 *
 * These are the client-agnostic shapes the whole harness speaks in. Keeping them
 * in one place means the ModelProvider (A1), ToolRegistry (A2), AgentLoop (A2),
 * and EventBus (A1) all reference the same `ToolCall` / `ToolResult`, so wiring
 * later milestones together is "import the type", not "reshape the data".
 */

/** A tool invocation requested by the model. `arguments` stays a raw JSON string
 *  here — parsing + zod validation is the ToolRegistry's job (A2), not the
 *  provider's. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Narrow, host-authored evidence for the built-in file tools. */
export type FileReceipt =
  | { kind: 'read'; path: string; version: string }
  | {
      kind: 'write';
      path: string;
      precondition: 'createOnly' | 'expectedVersion';
      outcome: 'applied' | 'conflict' | 'unknown';
      expectedVersion?: string;
      preVersion?: string;
      postVersion?: string;
    };

/** The outcome of running a tool. Minimal in A1 (only the EventBus references it);
 *  the ToolRegistry (A2) owns the richer shape and execution. */
export interface ToolResult {
  callId: string;
  content: string;
  error?: string;
  /** The tool body was dispatched but the host could not prove its terminal side-effect state.
   *  Consumers must halt and reconcile; this result must never be recorded as committed. */
  executionUnknown?: true;
  /** Present only for the built-in read/write tools. Session receipts preserve it. */
  fileReceipt?: FileReceipt;
}

/** A tool advertised to the model. `parameters` is a JSON Schema object. The
 *  provider converts this canonical shape into each wire format; the ToolRegistry
 *  (A2) produces it from zod (deref'd `$defs`, `type` filled — see plan §3.3). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A conversation message. The `assistant` variant carries `reasoning` so thinking
 *  content can round-trip across turns (a Doubao/OpenAI-compat gotcha); the `tool`
 *  variant carries the id it answers so results re-attach to their call. */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; reasoning?: string; toolCalls?: ToolCall[]; requestId?: string }
  | { role: 'tool'; toolCallId: string; content: string; executionId?: string };
