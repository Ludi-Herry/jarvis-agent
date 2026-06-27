import { describe, expect, it } from 'vitest';
import { canSplitAfter, findSplitPoint } from '../../src/core/context/split.js';
import type { Message } from '../../src/core/types.js';

const sys: Message = { role: 'system', content: 'sys' };
const user = (c: string): Message => ({ role: 'user', content: c });
const asst = (c: string): Message => ({ role: 'assistant', content: c });
const asstTool: Message = {
  role: 'assistant',
  toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }],
};
const toolMsg: Message = { role: 'tool', toolCallId: 't1', content: 'file' };

describe('canSplitAfter', () => {
  it('returns false right after an assistant that made tool calls (the key case)', () => {
    expect(canSplitAfter([asstTool, toolMsg], 0)).toBe(false);
  });

  it('returns false right before a tool result (tail must not start orphaned)', () => {
    expect(canSplitAfter([asst('a'), toolMsg], 0)).toBe(false);
  });

  it('returns false right after a user message (keep the turn with its reply)', () => {
    expect(canSplitAfter([user('q'), asst('a')], 0)).toBe(false);
  });

  it('returns true after a plain assistant followed by a user turn', () => {
    expect(canSplitAfter([asst('a'), user('q')], 0)).toBe(true);
  });

  it('returns false with nothing on one side (out of range / empty tail)', () => {
    expect(canSplitAfter([asst('a')], 0)).toBe(false); // no next
    expect(canSplitAfter([asst('a'), user('q')], -1)).toBe(false); // no cur
  });
});

describe('findSplitPoint', () => {
  it('targets the last keepRecent messages when that boundary is already safe', () => {
    const messages = [sys, user('q1'), asst('a1'), user('q2'), asst('a2')];
    // len 5, keepRecent 2 → target 3; boundary after index 2 (asst→user) is safe.
    expect(findSplitPoint(messages, 2, 1)).toBe(3);
  });

  it('walks earlier (keeps MORE) to avoid cutting a tool call from its result', () => {
    const messages = [sys, user('q1'), asst('a1'), user('q2'), asstTool, toolMsg];
    // target 4 is after a user msg (unsafe); index 3 boundary (asst→user) is safe → 3.
    // keeps [q2, asstTool, toolMsg] — the tool group stays intact in the tail.
    expect(findSplitPoint(messages, 2, 1)).toBe(3);
  });

  it('returns headStart when no safe cut summarizes anything', () => {
    const messages = [sys, asstTool, toolMsg];
    expect(findSplitPoint(messages, 1, 1)).toBe(1); // == headStart → caller skips
  });
});
