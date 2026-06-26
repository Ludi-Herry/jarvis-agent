import { describe, expect, it } from 'vitest';
import { clampMaxTokens } from '../../src/core/model/clamp.js';

describe('clampMaxTokens', () => {
  it('passes through values within the cap (floored)', () => {
    expect(clampMaxTokens(100, 1000)).toBe(100);
    expect(clampMaxTokens(100.9, 1000)).toBe(100);
    expect(clampMaxTokens(1000, 1000)).toBe(1000);
  });

  it('clamps values above the cap', () => {
    expect(clampMaxTokens(5000, 1000)).toBe(1000);
  });

  it('floors at 1 and falls back to cap for non-finite input', () => {
    expect(clampMaxTokens(0, 1000)).toBe(1);
    expect(clampMaxTokens(-5, 1000)).toBe(1);
    expect(clampMaxTokens(Number.NaN, 1000)).toBe(1000);
    expect(clampMaxTokens(Number.POSITIVE_INFINITY, 1000)).toBe(1000);
  });
});
