/**
 * ToolRegistry types — the contract for registering, validating, and running tools.
 *
 * A tool is: a name + description + a zod input schema + a `run` side effect. The
 * registry (registry.ts) validates the model's raw JSON arguments against the schema
 * BEFORE calling `run`, and converts the schema into the OpenAI-compatible wire shape
 * the model sees (json-schema.ts). Keeping these shapes here means the AgentLoop
 * (loop/) and the built-in tools (read/write/grep) all speak the same contract — the
 * same "import the type" wiring A1 set up for Message/ToolCall/ToolResult.
 */
import type { ZodType } from 'zod';
import type { ToolCall, ToolResult, ToolSchema } from '../types.js';

/** Coarse capability tag. A phase only ANNOTATES with this — no permission is derived
 *  from it. The PermissionGate that reads these tags lands with Bash in phase B. */
export type ToolCapability = 'read-only' | 'writes-files';

/** Ambient context every tool run receives. Minimal in A phase: just the base
 *  directory that relative paths resolve against — the anchor every file tool needs,
 *  not a permission boundary (the sandbox/PermissionGate is phase B). */
export interface ToolRunCtx {
  cwd: string;
}

/** A tool's own output. The registry stamps the originating call id on to form a
 *  {@link ToolResult}, so the tool itself never has to know the id. */
export type ToolRunResult = Omit<ToolResult, 'callId'>;

/** A registered tool. `inputSchema` validates the model's arguments (so a malformed
 *  call fails before any side effect); `run` performs the effect. Generic over the
 *  parsed input type `I` so each tool's `run` is statically typed to its own args. */
export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  capability: ToolCapability;
  run(input: I, ctx: ToolRunCtx): Promise<ToolRunResult>;
}

/** Registers tools, advertises them to the model, and runs a model's tool call. */
export interface ToolRegistry {
  register<I>(tool: ToolDefinition<I>): void;
  /** OpenAI-compatible tool schemas, normalized: `$defs`/`$ref` deref'd (inlined) and
   *  `type` filled — strict endpoints (Doubao/ARK) reject `$defs`. See json-schema.ts. */
  schemasForModel(): ToolSchema[];
  /** Run one tool call. NEVER throws for tool-level failures — an unknown name, invalid
   *  JSON arguments, schema-invalid input, or a throwing `run` all come back normalized
   *  as {@link ToolResult} with `error` set, so the AgentLoop can feed the failure back
   *  to the model instead of crashing the turn. */
  run(call: ToolCall, ctx: ToolRunCtx): Promise<ToolResult>;
}
