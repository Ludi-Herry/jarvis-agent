import { describe, expect, it } from 'vitest';
import { extractReasoning } from '../../src/core/model/reasoning.js';

describe('extractReasoning', () => {
  it('reads the three known field names in priority order', () => {
    expect(extractReasoning({ reasoning_content: 'a' })).toBe('a');
    expect(extractReasoning({ reasoning_details: 'b' })).toBe('b');
    expect(extractReasoning({ reasoning: 'c' })).toBe('c');
    // priority: reasoning_content wins over the others
    expect(extractReasoning({ reasoning_content: 'a', reasoning: 'c' })).toBe('a');
  });

  it('honors an explicit override key first', () => {
    expect(extractReasoning({ my_think: 'x', reasoning: 'c' }, 'my_think')).toBe('x');
    // falls back to standard keys when the override is absent
    expect(extractReasoning({ reasoning: 'c' }, 'my_think')).toBe('c');
  });

  it('returns undefined for missing, empty, non-string, or nullish input', () => {
    expect(extractReasoning(undefined)).toBeUndefined();
    expect(extractReasoning(null)).toBeUndefined();
    expect(extractReasoning({})).toBeUndefined();
    expect(extractReasoning({ reasoning_content: '' })).toBeUndefined();
    expect(extractReasoning({ reasoning_content: 123 })).toBeUndefined();
  });
});
