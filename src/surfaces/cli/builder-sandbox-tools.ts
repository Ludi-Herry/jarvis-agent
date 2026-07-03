import { createBrowserSmokeTool, createSandboxedBuilderCheckTool, type ToolRegistry } from '../../core/index.js';
import type { SandboxRunner } from '../../runtime/index.js';

export interface BuilderSandboxToolOptions {
  readonly browserExecutable?: string;
}

export function registerBuilderSandboxTools(registry: ToolRegistry, runner: SandboxRunner, options: BuilderSandboxToolOptions = {}): void {
  registry.register(createSandboxedBuilderCheckTool({ runner }));
  registry.register(createBrowserSmokeTool({ runner, browserExecutable: options.browserExecutable }));
}
