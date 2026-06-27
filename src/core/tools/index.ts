/**
 * Tools barrel — public face of `src/core/tools`, plus the default registry assembly.
 *
 * The AgentLoop (loop/) and the a2-demo build their tool set from
 * {@link buildDefaultRegistry}; the deeper files (json-schema helpers, individual tool
 * defs) stay reachable for tests but callers normally only need the registry.
 */
import { InMemoryToolRegistry } from './registry.js';
import { readTool, writeTool, grepTool } from './builtins.js';
import type { ToolRegistry } from './types.js';

export { InMemoryToolRegistry } from './registry.js';
export { readTool, writeTool, grepTool } from './builtins.js';
export { zodToParameters, normalizeJsonSchema } from './json-schema.js';
export type {
  ToolDefinition,
  ToolRegistry,
  ToolRunCtx,
  ToolRunResult,
  ToolCapability,
} from './types.js';

/** A registry with the three A-phase built-ins (read/write/grep) registered. */
export function buildDefaultRegistry(): ToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(grepTool);
  return registry;
}
