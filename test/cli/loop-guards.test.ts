import { describe, expect, it } from 'vitest';
import { assertParallelHooksCompatible } from '../../src/surfaces/cli/loop-guards.js';

describe('loop CLI guards', () => {
  it('allows serial runs with hooks', () => {
    expect(() => assertParallelHooksCompatible(false, true)).not.toThrow();
  });

  it('allows parallel runs when hooks are off', () => {
    expect(() => assertParallelHooksCompatible(true, false)).not.toThrow();
  });

  it('fails closed for parallel runs with hooks configured', () => {
    expect(() => assertParallelHooksCompatible(true, true)).toThrow(/--parallel cannot run with hooks/);
  });
});
