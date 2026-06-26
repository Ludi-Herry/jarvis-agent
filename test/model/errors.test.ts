import { describe, expect, it } from 'vitest';
import { describeModelError } from '../../src/core/model/errors.js';

describe('describeModelError', () => {
  it('gives an auth hint for 401/403 and never leaks the key', () => {
    const msg = describeModelError({ status: 401, message: 'Invalid Authentication' }, 'm').message;
    expect(msg).toContain('HTTP 401');
    expect(msg).toContain('ARK_API_KEY');
    expect(msg).toContain('Invalid Authentication');
    expect(msg).not.toMatch(/sk-|api[_-]?key=/i);
  });

  it('hints at the model id / baseURL for 404 and quota for 429', () => {
    expect(describeModelError({ status: 404 }, 'm').message).toContain('model id');
    expect(describeModelError({ status: 429 }, 'm').message).toContain('rate limited');
  });

  it('handles plain errors and non-error throws', () => {
    expect(describeModelError(new Error('socket hang up'), 'm').message).toContain('socket hang up');
    expect(describeModelError('boom', 'm').message).toContain('boom');
  });

  it('includes the model id', () => {
    expect(describeModelError({ status: 500 }, 'doubao-x').message).toContain('doubao-x');
  });
});
