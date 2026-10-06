import { describe, expect, it } from 'vitest';
import type { GuiTool } from '../../../src/surfaces/gui/live-types.js';
import { deriveSubagents } from '../../../src/surfaces/gui/app/src/workbench/subagents.js';
import {
  canStepPreview,
  currentPreviewAddress,
  initialPreviewHistory,
  parsePreviewHistory,
  pushPreviewAddress,
  serializePreviewHistory,
  stepPreview,
} from '../../../src/surfaces/gui/app/src/workbench/preview-state.js';

function tool(id: string, name: string, args: string, patch: Partial<GuiTool> = {}): GuiTool {
  return { id, name, arguments: args, status: 'committed', ...patch };
}

describe('GUI batch 3 subagent derivation (§B6)', () => {
  it('keeps only task tool calls and maps role, status, summary and result preview', () => {
    const tools = [
      tool('call-1', 'read', JSON.stringify({ path: 'a.mjs' })),
      tool('call-2', 'task', JSON.stringify({ role: 'researcher', task: '核对既有验收口径' }), { output: '委派结果摘要' }),
      tool('call-3', 'task', JSON.stringify({ role: 'explorer', task: '扫描目录' }), { status: 'running' }),
    ];
    const agents = deriveSubagents(tools);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toEqual({
      id: 'call-2', role: 'researcher', taskSummary: '核对既有验收口径', status: 'committed', resultPreview: '委派结果摘要',
    });
    expect(agents[1]).toMatchObject({ id: 'call-3', role: 'explorer', status: 'running', resultPreview: '' });
  });

  it('marks broken arguments as unknown instead of guessing', () => {
    const agents = deriveSubagents([
      tool('call-1', 'task', '{"role":'),
      tool('call-2', 'task', JSON.stringify({ noRole: true })),
      tool('call-3', 'task', JSON.stringify({ role: '  ', task: '实际任务' })),
    ]);
    expect(agents[0]).toMatchObject({ role: 'unknown', taskSummary: 'unknown' });
    expect(agents[1]).toMatchObject({ role: 'unknown', taskSummary: 'unknown' });
    expect(agents[2]).toMatchObject({ role: 'unknown', taskSummary: '实际任务' });
  });

  it('truncates the task summary to 120 chars and the result preview to 400 chars', () => {
    const agents = deriveSubagents([
      tool('call-1', 'task', JSON.stringify({ role: 'r', task: 'x'.repeat(200) }), { output: 'y'.repeat(500) }),
    ]);
    expect(agents[0].taskSummary).toHaveLength(120);
    expect(agents[0].resultPreview).toHaveLength(400);
  });
});

describe('GUI batch 3 preview history state (§C9–§C13)', () => {
  it('pushes addresses, drops forward entries and steps within bounds', () => {
    let history = initialPreviewHistory();
    expect(currentPreviewAddress(history)).toBeNull();
    history = pushPreviewAddress(history, 'http://127.0.0.1:4328/');
    history = pushPreviewAddress(history, 'http://127.0.0.1:5173/');
    history = pushPreviewAddress(history, 'http://localhost:8080/');
    expect(currentPreviewAddress(history)).toBe('http://localhost:8080/');
    expect(canStepPreview(history, 1)).toBe(false);
    expect(canStepPreview(history, -1)).toBe(true);

    history = stepPreview(history, -1);
    expect(currentPreviewAddress(history)).toBe('http://127.0.0.1:5173/');
    history = stepPreview(history, -1);
    history = stepPreview(history, -1);
    expect(currentPreviewAddress(history)).toBe('http://127.0.0.1:4328/');
    expect(canStepPreview(history, -1)).toBe(false);

    // A push from a middle position discards the forward tail (browser semantics).
    const reopened = pushPreviewAddress(history, 'http://127.0.0.1:9000/');
    expect(reopened.stack).toEqual(['http://127.0.0.1:4328/', 'http://127.0.0.1:9000/']);
    expect(currentPreviewAddress(reopened)).toBe('http://127.0.0.1:9000/');
    expect(canStepPreview(reopened, 1)).toBe(false);
  });

  it('does not duplicate the same address opened twice in a row', () => {
    const once = pushPreviewAddress(initialPreviewHistory(), 'http://127.0.0.1:4328/');
    const twice = pushPreviewAddress(once, 'http://127.0.0.1:4328/');
    expect(twice.stack).toEqual(['http://127.0.0.1:4328/']);
    expect(twice.index).toBe(0);
  });

  it('round-trips through serialization and falls back on broken storage values', () => {
    const history = pushPreviewAddress(pushPreviewAddress(initialPreviewHistory(), 'http://127.0.0.1:1/'), 'http://localhost:2/');
    const restored = parsePreviewHistory(serializePreviewHistory(history));
    expect(restored).toEqual(history);

    expect(parsePreviewHistory(null)).toEqual(initialPreviewHistory());
    expect(parsePreviewHistory('not json')).toEqual(initialPreviewHistory());
    expect(parsePreviewHistory('{"stack":"nope","index":0}')).toEqual(initialPreviewHistory());
    expect(parsePreviewHistory('{"stack":[1],"index":0}')).toEqual(initialPreviewHistory());
    const clamped = parsePreviewHistory('{"stack":["http://a/"],"index":7}');
    expect(clamped.index).toBe(0);
    expect(currentPreviewAddress(clamped)).toBe('http://a/');
  });
});
