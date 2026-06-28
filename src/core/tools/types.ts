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

/** A tool's effect class — the orthogonal capability the PermissionGate derives a default
 *  action from (plan §3.1, decision 4). Four distinct categories, NOT 11 flat booleans:
 *  `read-only` → allow, `writes-files` → ask, `executes-code` → command-tree parsing (B2),
 *  `network` → ask. A tool declares ONE today (none of read/write/grep/Bash spans two); if a
 *  future tool genuinely combines effects (e.g. fetch-and-save) this widens to an array and
 *  the gate takes the strictest — not pre-built now. */
export type ToolCapability = 'read-only' | 'writes-files' | 'executes-code' | 'network';

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
  /** The declared effect class of a registered tool, or `undefined` if the name is unknown.
   *  The PermissionGate reads this to derive a default action; an unknown tool (undefined)
   *  has no classifiable effect, so the gate fails closed (B1, plan §3.2). */
  capabilityOf(name: string): ToolCapability | undefined;
  /** OpenAI-compatible tool schemas, normalized: `$defs`/`$ref` deref'd (inlined) and
   *  `type` filled — strict endpoints (Doubao/ARK) reject `$defs`. See json-schema.ts. */
  schemasForModel(): ToolSchema[];
  /** Run one tool call. NEVER throws for tool-level failures — an unknown name, invalid
   *  JSON arguments, schema-invalid input, or a throwing `run` all come back normalized
   *  as {@link ToolResult} with `error` set, so the AgentLoop can feed the failure back
   *  to the model instead of crashing the turn. */
  run(call: ToolCall, ctx: ToolRunCtx): Promise<ToolResult>;
}
