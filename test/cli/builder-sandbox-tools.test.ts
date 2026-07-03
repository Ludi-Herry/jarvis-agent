import { describe, expect, it } from 'vitest';
import { buildDefaultRegistry } from '../../src/core/index.js';
import { sandboxUnavailable, type SandboxRunner } from '../../src/runtime/index.js';
import { registerBuilderSandboxTools } from '../../src/surfaces/cli/builder-sandbox-tools.js';

describe('builder sandbox tool registration', () => {
  it('adds sandboxed_check to the builder registry as a read-only feedback tool', async () => {
    const registry = buildDefaultRegistry();
    const runner: SandboxRunner = {
      backend: 'unavailable',
      async run(request) {
        return sandboxUnavailable(request, 'disabled for test');
      },
    };

    registerBuilderSandboxTools(registry, runner);

    expect(registry.capabilityOf('sandboxed_check')).toBe('read-only');
    expect(registry.schemasForModel().map((schema) => schema.name)).toContain('sandboxed_check');
    const result = await registry.run(
      { id: 'call-1', name: 'sandboxed_check', arguments: JSON.stringify({ check: 'lint' }) },
      { cwd: '/host/project' },
    );
    expect(result.error).toBe('Sandbox unavailable: disabled for test');
    expect(result.content).toContain('"networkMode": "none"');
  });
});
