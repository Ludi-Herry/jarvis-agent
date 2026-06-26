import { describe, expect, it } from 'vitest';
import { DoubaoProvider } from '../../src/core/model/doubao-provider.js';
import { createProvider } from '../../src/core/model/create-provider.js';
import type { DoubaoConfig } from '../../src/core/model/types.js';

const config: DoubaoConfig = {
  provider: 'doubao',
  apiKey: 'test-key-not-used-offline',
  model: 'doubao-seed-2-1-pro-260628',
};

const msgs = [{ role: 'user', content: 'hi' }] as const;

describe('DoubaoProvider clone semantics', () => {
  it('withThinking returns a NEW instance and leaves the original untouched', () => {
    const base = new DoubaoProvider(config);
    const off = base.withThinking('off');

    expect(off).not.toBe(base); // new instance
    // original still sends no thinking key (server default = ON)
    expect(base.buildParams([...msgs], []).thinking).toBeUndefined();
    // clone really disables thinking
    expect((off as DoubaoProvider).buildParams([...msgs], []).thinking).toEqual({ type: 'disabled' });
  });

  it('withMaxCompletionTokens clones with a clamped cap, original unchanged', () => {
    const base = new DoubaoProvider(config);
    const capped = base.withMaxCompletionTokens(50) as DoubaoProvider;

    expect(capped).not.toBe(base);
    expect(base.buildParams([...msgs], []).max_tokens).toBeUndefined();
    expect(capped.buildParams([...msgs], []).max_tokens).toBe(50);
  });

  it('chains builders without mutating earlier instances', () => {
    const base = new DoubaoProvider(config);
    const chained = base.withThinking('off').withMaxCompletionTokens(100) as DoubaoProvider;
    const params = chained.buildParams([...msgs], []);

    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.max_tokens).toBe(100);
    // base is still pristine
    const baseParams = base.buildParams([...msgs], []);
    expect(baseParams.thinking).toBeUndefined();
    expect(baseParams.max_tokens).toBeUndefined();
  });

  it('exposes the Doubao capability', () => {
    const base = new DoubaoProvider(config);
    expect(base.capability.toolUse).toBe(true);
    expect(base.capability.thinking).toBe(true);
    expect(base.capability.maxContextTokens).toBeGreaterThan(0);
  });
});

describe('createProvider', () => {
  it('builds a working Doubao provider from config', () => {
    const provider = createProvider(config);
    expect(provider.capability.toolUse).toBe(true);
    expect(typeof provider.call).toBe('function');
    expect(typeof provider.withThinking).toBe('function');
  });
});
