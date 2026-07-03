import { createSandboxedBuilderCheckTool, type ToolRegistry } from '../../core/index.js';
import type { SandboxRunner } from '../../runtime/index.js';

export function registerBuilderSandboxTools(registry: ToolRegistry, runner: SandboxRunner): void {
  registry.register(createSandboxedBuilderCheckTool({ runner }));
}
