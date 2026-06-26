/**
 * core layer — AgentLoop · ToolRegistry · ContextManager · ModelProvider.
 *
 * A1 lands ModelProvider (model/) + the shared domain vocabulary (types.ts).
 * The rest arrive in A2+ (see docs/phase-A-plan.md).
 */
export type { Message, ToolCall, ToolResult, ToolSchema } from './types.js';
export * from './model/index.js';
