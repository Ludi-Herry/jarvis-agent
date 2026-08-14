import { describe, expect, it } from 'vitest';
import { normalizeFinishReason } from '../../src/core/model/finish-reason.js';

describe('normalizeFinishReason', () => {
  it('maps known OpenAI-compatible reasons', () => {
    expect(normalizeFinishReason('stop')).toBe('completed');
    expect(normalizeFinishReason('tool_calls')).toBe('tool_calls');
    expect(normalizeFinishReason('function_call')).toBe('tool_calls');
    expect(normalizeFinishReason('length')).toBe('truncated');
    expect(normalizeFinishReason('content_filter')).toBe('filtered');
    expect(normalizeFinishReason('paused')).toBe('paused');
    expect(normalizeFinishReason('refusal')).toBe('refused');
    expect(normalizeFinishReason('safety_refusal')).toBe('refused');
  });

  it('fails closed as unknown for null, undefined, and unknown strings', () => {
    expect(normalizeFinishReason(null)).toBe('unknown');
    expect(normalizeFinishReason(undefined)).toBe('unknown');
    expect(normalizeFinishReason('something_new')).toBe('unknown');
  });
});
