/**
 * subagents — the SubagentManager and its construction-time guardrails (Phase C).
 *
 * derive.ts: pure narrowing (capabilities/tools/depth/budget). roster.ts: the AgentRole registry.
 * subagent-manager.ts: spawn a child as a narrowed recursive runAgent. (delegate-tool/panel land
 * in C3/C4.)
 */
export * from './derive.js';
export * from './roster.js';
export * from './subagent-manager.js';
export * from './delegate-tool.js';
