/**
 * InMemoryToolRegistry — the safety funnel between the model and tool side effects.
 *
 * The model hands us a {@link ToolCall} with a raw JSON `arguments` string and a name
 * it picked. EVERYTHING about that input is untrusted: the name may not exist, the JSON
 * may be malformed, the parsed value may violate the tool's schema, and the tool's `run`
 * may throw. `run()` normalizes ALL four into a {@link ToolResult} with `error` set —
 * it never throws for a tool-level failure — so the AgentLoop can feed the failure back
 * to the model and keep the turn alive instead of crashing (tools/types.ts contract).
 *
 * `schemasForModel()` advertises each tool in the normalized, `$defs`-free shape strict
 * endpoints (Doubao/ARK) require (json-schema.ts).
 */
import type { ToolCall, ToolResult, ToolSchema } from '../types.js';
import { zodToParameters } from './json-schema.js';
import type { ToolCapability, ToolDefinition, ToolRegistry, ToolRunCtx } from './types.js';

/** ARK rejects tool_call_id longer than 64 chars; truncate defensively so a model that
 *  emits an over-long id can't poison the next request. */
const MAX_TOOL_CALL_ID = 64;

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<I>(tool: ToolDefinition<I>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  capabilityOf(name: string): ToolCapability | undefined {
    return this.tools.get(name)?.capability;
  }

  schemasForModel(): ToolSchemaList {
    return [...this.tools.values()].map(toolDefinitionSchema);
  }

  async run(call: ToolCall, ctx: ToolRunCtx): Promise<ToolResult> {
    const callId = call.id.slice(0, MAX_TOOL_CALL_ID);

    const tool = this.tools.get(call.name);
    if (!tool) {
      return { callId, content: '', error: `Unknown tool: ${call.name}` };
    }

    let parsed: unknown;
    try {
      // A model sometimes emits "" for a no-argument tool; treat it as "{}".
      const raw = call.arguments.trim() === '' ? '{}' : call.arguments;
      parsed = JSON.parse(raw);
    } catch (err) {
      return { callId, content: '', error: `Invalid JSON arguments: ${message(err)}` };
    }

    const checked = tool.inputSchema.safeParse(parsed);
    if (!checked.success) {
      const issues = checked.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { callId, content: '', error: `Invalid arguments for ${call.name}: ${issues}` };
    }

    try {
      const out = await tool.run(checked.data, ctx);
      return {
        callId,
        content: out.content,
        ...(out.error !== undefined ? { error: out.error } : {}),
        ...(out.executionUnknown === true ? { executionUnknown: true as const } : {}),
        ...(out.fileReceipt !== undefined ? { fileReceipt: out.fileReceipt } : {}),
      };
    } catch (err) {
      // Validation failures above are known no-execution outcomes. Once tool.run starts,
      // a throw cannot prove whether an external side effect happened before the error.
      return {
        callId,
        content: '',
        error: `Tool ${call.name} threw after dispatch: ${message(err)}`,
        executionUnknown: true,
      };
    }
  }

  /** A new registry holding only the named tools, reusing the SAME {@link ToolDefinition}
   *  references (so each `run` closure is intact). Names not registered here are silently
   *  skipped — the result is always a subset of this registry, never a superset. */
  subset(names: string[]): ToolRegistry {
    const r = new InMemoryToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) r.register(tool);
    }
    return r;
  }
}

/** Convert one definition through the exact registry schema path. Capability-owned
 *  conditional tools use this to hash the schema before their runtime closure exists. */
export function toolDefinitionSchema(
  tool: Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>,
): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: zodToParameters(tool.inputSchema),
  };
}

/** Local alias so the return type reads cleanly; identical to ToolRegistry's. */
type ToolSchemaList = ReturnType<ToolRegistry['schemasForModel']>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
