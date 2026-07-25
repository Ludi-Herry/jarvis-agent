import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_V4_CAPABILITY,
  DOUBAO_SEED_PRO_CAPABILITY,
  DoubaoProvider,
  capabilityForModel,
} from '../../src/core/model/doubao-provider.js';
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

describe('capabilityForModel', () => {
  it('gives the DeepSeek-V4 family its 1M window (pro and flash, whatever the date suffix)', () => {
    for (const id of ['deepseek-v4-pro-260425', 'deepseek-v4-flash-260425', 'deepseek-v4-pro-999999']) {
      expect(capabilityForModel(id)).toEqual(DEEPSEEK_V4_CAPABILITY);
    }
    expect(DEEPSEEK_V4_CAPABILITY.maxContextTokens).toBe(1_048_576);
  });

  it('keeps Doubao on its own 256K window, so ARK_MODEL still switches back cleanly', () => {
    expect(capabilityForModel('doubao-seed-2-1-pro-260628')).toEqual(DOUBAO_SEED_PRO_CAPABILITY);
    expect(new DoubaoProvider(config).capability.maxContextTokens).toBe(262_144);
  });

  it('falls back to the SMALLER window for an unknown id (under-promise, never overrun)', () => {
    const unknown = capabilityForModel('some-future-model-270101');
    expect(unknown).toEqual(DOUBAO_SEED_PRO_CAPABILITY);
    expect(unknown.maxContextTokens).toBeLessThan(DEEPSEEK_V4_CAPABILITY.maxContextTokens);
  });

  it('the provider reports the window of the model it was configured with', () => {
    const ds = new DoubaoProvider({ ...config, model: 'deepseek-v4-pro-260425' });
    expect(ds.capability.maxContextTokens).toBe(1_048_576);
    // and a clone (withThinking/withMaxCompletionTokens) keeps it
    expect((ds.withThinking('off') as DoubaoProvider).capability.maxContextTokens).toBe(1_048_576);
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
