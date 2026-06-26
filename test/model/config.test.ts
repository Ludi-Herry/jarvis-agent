import { describe, expect, it } from 'vitest';
import { DEFAULT_ARK_MODEL, loadDoubaoConfig } from '../../src/core/model/config.js';
import { DEFAULT_ARK_BASE_URL } from '../../src/core/model/doubao-provider.js';

describe('loadDoubaoConfig', () => {
  it('throws a readable error when ARK_API_KEY is missing', () => {
    expect(() => loadDoubaoConfig({})).toThrow(/ARK_API_KEY/);
  });

  it('uses ARK defaults when only the key is set', () => {
    const cfg = loadDoubaoConfig({ ARK_API_KEY: 'k' });
    expect(cfg).toEqual({
      provider: 'doubao',
      apiKey: 'k',
      baseURL: DEFAULT_ARK_BASE_URL,
      model: DEFAULT_ARK_MODEL,
    });
  });

  it('honors overrides from the environment', () => {
    const cfg = loadDoubaoConfig({
      ARK_API_KEY: 'k',
      ARK_BASE_URL: 'https://example.test/v1',
      ARK_MODEL: 'doubao-other',
      ARK_REASONING_KEY: 'my_think',
    });
    expect(cfg.baseURL).toBe('https://example.test/v1');
    expect(cfg.model).toBe('doubao-other');
    expect(cfg.reasoningKey).toBe('my_think');
  });
});
