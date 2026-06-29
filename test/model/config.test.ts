import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARK_MODEL,
  loadDoubaoConfig,
  resolveVerifierConfig,
} from '../../src/core/model/config.js';
import { DEFAULT_ARK_BASE_URL } from '../../src/core/model/doubao-provider.js';
import type { DoubaoConfig } from '../../src/core/model/types.js';

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

  it('treats a present-but-blank baseURL/model as unset and uses the defaults', () => {
    const cfg = loadDoubaoConfig({ ARK_API_KEY: 'k', ARK_BASE_URL: '', ARK_MODEL: '' });
    expect(cfg.baseURL).toBe(DEFAULT_ARK_BASE_URL);
    expect(cfg.model).toBe(DEFAULT_ARK_MODEL);
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

describe('resolveVerifierConfig — leg 3 enablement + config-layer independence', () => {
  const builder: DoubaoConfig = {
    provider: 'doubao',
    apiKey: 'k',
    baseURL: 'https://example.test/v1',
    model: 'doubao-builder',
  };

  it('disabled when ARK_VERIFIER_MODEL is unset (batch-1 deterministic-only fallback)', () => {
    const r = resolveVerifierConfig({}, builder);
    expect(r.enabled).toBe(false);
    if (!r.enabled) expect(r.reason).toContain('not set');
  });

  it('disabled when the verifier model equals the builder model (same-model independence is theater)', () => {
    const r = resolveVerifierConfig({ ARK_VERIFIER_MODEL: 'doubao-builder' }, builder);
    expect(r.enabled).toBe(false);
    if (!r.enabled) expect(r.reason).toContain('theater');
  });

  it('enabled with a different model, reusing the builder key/baseURL but overriding the model id', () => {
    const r = resolveVerifierConfig({ ARK_VERIFIER_MODEL: 'doubao-judge' }, builder);
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.config.model).toBe('doubao-judge');
      expect(r.config.apiKey).toBe('k');
      expect(r.config.baseURL).toBe('https://example.test/v1');
    }
  });

  it('treats a blank verifier model as unset', () => {
    expect(resolveVerifierConfig({ ARK_VERIFIER_MODEL: '   ' }, builder).enabled).toBe(false);
  });
});
