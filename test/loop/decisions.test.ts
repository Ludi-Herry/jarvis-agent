import { describe, expect, it } from 'vitest';
import { decideStop, decideCompact, withinBudget } from '../../src/core/loop/decisions.js';
import type { FinishReason, ModelResult, Usage } from '../../src/core/model/types.js';
import type { ToolCall } from '../../src/core/types.js';

function result(toolCalls: ToolCall[], finishReason?: FinishReason): ModelResult {
  return {
    text: 'x',
    toolCalls,
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'completed'),
    rawFinishReason: 'stop',
  };
}

const aCall: ToolCall = { id: 'c1', name: 'read', arguments: '{}' };
const usage = (inputTokens: number): Usage => ({ inputTokens, outputTokens: 0 });

describe('decideStop', () => {
  it('stops (done) when the model requested no tools', () => {
    expect(decideStop(result([]))).toEqual({ done: true, reason: 'final' });
  });

  it('continues when the model requested at least one tool', () => {
    expect(decideStop(result([aCall])).done).toBe(false);
  });

  it('halts (NOT final) on a truncated no-tool turn — a half reply is not the answer', () => {
    expect(decideStop(result([], 'truncated'))).toEqual({ done: true, reason: 'halt', cause: 'truncated' });
  });

  it('halts (NOT final) on a content-filtered no-tool turn', () => {
    expect(decideStop(result([], 'filtered'))).toEqual({ done: true, reason: 'halt', cause: 'filtered' });
  });

  it('still continues a truncated turn that carries tool calls (torn args fail downstream, not here)', () => {
    expect(decideStop(result([aCall], 'truncated')).done).toBe(false);
  });
});

describe('withinBudget', () => {
  it('permits a turn below the ceiling', () => {
    expect(withinBudget(2, { maxTurns: 3 })).toBe(true);
  });

  it('stops exactly at the ceiling (boundary)', () => {
    expect(withinBudget(3, { maxTurns: 3 })).toBe(false);
  });

  it('stops above the ceiling', () => {
    expect(withinBudget(4, { maxTurns: 3 })).toBe(false);
  });
});

describe('decideCompact', () => {
  it('does not compact below the threshold', () => {
    expect(decideCompact(usage(820), 1000)).toBe(false); // 0.82 < 0.83
  });

  it('compacts exactly at the threshold (boundary)', () => {
    expect(decideCompact(usage(830), 1000)).toBe(true); // 0.83
  });

  it('compacts above the threshold', () => {
    expect(decideCompact(usage(950), 1000)).toBe(true);
  });

  it('never compacts when the window is unknown (non-positive)', () => {
    expect(decideCompact(usage(999), 0)).toBe(false);
  });
});
