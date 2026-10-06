import type { GuiTool } from '../../../live-types.js';

/**
 * Batch 3 §B6: a subagent call is a `task` tool call already in the projection stream — no new
 * event type. This derives the drawer list from `snapshot.tools`. Honest degradation: a broken
 * arguments payload surfaces as 'unknown' instead of being guessed.
 */
export interface SubagentEntry {
  readonly id: string;
  readonly role: string;
  readonly taskSummary: string;
  readonly status: GuiTool['status'];
  readonly resultPreview: string;
}

const UNKNOWN = 'unknown';

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN;
}

export function deriveSubagents(tools: readonly GuiTool[]): SubagentEntry[] {
  return tools
    .filter((tool) => tool.name === 'task')
    .map((tool) => {
      let role = UNKNOWN;
      let task = UNKNOWN;
      try {
        const parsed: unknown = JSON.parse(tool.arguments);
        if (typeof parsed === 'object' && parsed !== null) {
          const record = parsed as Record<string, unknown>;
          role = readString(record, 'role');
          task = readString(record, 'task');
        }
      } catch {
        // Keep the honest unknown markers; the raw call stays visible in the Diff/context tabs.
      }
      return {
        id: tool.id,
        role,
        taskSummary: task.slice(0, 120),
        status: tool.status,
        resultPreview: (tool.output ?? '').slice(0, 400),
      };
    });
}
