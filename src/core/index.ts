/**
 * core layer — AgentLoop · ToolRegistry · ContextManager · ModelProvider.
 *
 * A1 lands ModelProvider (model/) + the shared domain vocabulary (types.ts).
 * A2 adds the ToolRegistry (tools/) and the AgentLoop (loop/). ContextManager arrives in A3.
 */
export type { Message, ToolCall, ToolResult, ToolSchema } from './types.js';
export * from './model/index.js';
export * from './tools/index.js';
export * from './loop/index.js';
