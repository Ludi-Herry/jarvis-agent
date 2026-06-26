/**
 * Provider factory — dispatches on the discriminated-union config.
 *
 * Today only Doubao exists; Kimi / Anthropic drop in as new `case`s here when
 * their config variants are added to {@link ProviderConfig}. Callers depend on the
 * `ModelProvider` interface, never on a concrete class.
 */
import type { ModelProvider, ProviderConfig } from './types.js';
import { DoubaoProvider } from './doubao-provider.js';

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.provider) {
    case 'doubao':
      return new DoubaoProvider(config);
    default: {
      // Exhaustiveness guard: a new provider in the union must be handled here.
      const exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}
