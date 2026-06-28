import { describe, expect, it } from 'vitest';
import { describeModelError, redactSecrets } from '../../src/core/model/errors.js';

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

  it('handles plain errors and non-error throws via the generic (non-HTTP) branch', () => {
    const plain = describeModelError(new Error('socket hang up'), 'm').message;
    expect(plain).toContain('socket hang up');
    expect(plain).not.toContain('HTTP'); // no numeric status => not treated as an API error
    expect(describeModelError('boom', 'm').message).toContain('boom');
    // an object with a message but no numeric status is NOT an API error
    expect(describeModelError({ message: 'weird' }, 'm').message).not.toContain('HTTP');
  });

  it('redacts a secret the endpoint echoes back in the message (no credential re-leak)', () => {
    const msg = describeModelError(
      { status: 400, message: 'bad request: Authorization: Bearer sk-LIVEKEY1234567890 rejected' },
      'm',
    ).message;
    expect(msg).toContain('HTTP 400');
    expect(msg).not.toContain('sk-LIVEKEY1234567890');
    expect(msg).toContain('sk-***');
  });
});

describe('redactSecrets', () => {
  it('masks api-key prefixes, bearer tokens, and labelled secret values', () => {
    expect(redactSecrets('leaked sk-ABCdef123456 here')).toContain('sk-***');
    expect(redactSecrets('leaked sk-ABCdef123456 here')).not.toContain('ABCdef123456');
    expect(redactSecrets('Authorization: Bearer abc.def.ghi123')).toContain('Bearer ***');
    expect(redactSecrets('api_key=supersecretvalue')).toBe('api_key=***');
    const masked = redactSecrets('"token": "abcdef123456"');
    expect(masked).toContain('***');
    expect(masked).not.toContain('abcdef123456');
  });

  it('leaves ordinary diagnostic text untouched', () => {
    expect(redactSecrets('rate limited or out of quota')).toBe('rate limited or out of quota');
    expect(redactSecrets('socket hang up')).toBe('socket hang up');
  });
});
