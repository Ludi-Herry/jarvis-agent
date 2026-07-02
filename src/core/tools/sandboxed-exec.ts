import { z } from 'zod';
import type { SandboxLimits, SandboxRunResult, SandboxRunner } from '../../runtime/sandbox/index.js';
import { validateSandboxInspectionCommand } from './sandboxed-inspection-command.js';
import type { ToolDefinition } from './types.js';

const DEFAULT_SANDBOX_CWD = '/tmp/jarvis-sandbox/project';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 32_768;

export interface SandboxedExecToolOptions {
  readonly runner: SandboxRunner;
  readonly sandboxCwd?: string;
  readonly limits?: Partial<SandboxLimits>;
}

export function createSandboxedExecTool(options: SandboxedExecToolOptions): ToolDefinition<{ command: string; reason?: string }> {
  const sandboxCwd = options.sandboxCwd ?? DEFAULT_SANDBOX_CWD;
  const limits: SandboxLimits = {
    timeoutMs: options.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputBytes: options.limits?.outputBytes ?? DEFAULT_OUTPUT_BYTES,
    ...(options.limits?.maxProcesses !== undefined ? { maxProcesses: options.limits.maxProcesses } : {}),
    ...(options.limits?.memoryBytes !== undefined ? { memoryBytes: options.limits.memoryBytes } : {}),
    ...(options.limits?.cpuMillis !== undefined ? { cpuMillis: options.limits.cpuMillis } : {}),
  };

  return {
    name: 'sandboxed_exec',
    description:
      'Run an inspection command through the configured OS sandbox runner. The project is mounted ' +
      'read-only, network is disabled, and unavailable sandboxes fail closed instead of falling back ' +
      'to raw bash. This tool is not part of the default registry.',
    capability: 'executes-code',
    inputSchema: z.object({
      command: z.string().min(1).describe('The POSIX bash inspection command to run inside the sandbox.'),
      reason: z.string().optional().describe('Why this sandboxed command is needed.'),
    }),
    run: async ({ command, reason }, ctx) => {
      const inspection = validateSandboxInspectionCommand(command);
      if (!inspection.ok) {
        return { content: '', error: `Sandboxed inspection command rejected: ${inspection.reason ?? 'not allowed'}` };
      }

      const result = await options.runner.run({
        command: ['bash', '--noprofile', '--norc', '-c', command],
        cwd: sandboxCwd,
        mounts: [{ hostPath: ctx.cwd, sandboxPath: sandboxCwd, access: 'read-only' }],
        networkMode: 'none',
        limits,
        reason: reason ?? 'sandboxed inspection command',
      });

      return renderSandboxResult(result);
    },
  };
}

function renderSandboxResult(result: SandboxRunResult): { content: string; error?: string } {
  if (result.status === 'completed') {
    const notes = [`[sandbox backend: ${result.backend}]`, `[exit code: ${result.exitCode}]`];
    const stdout = result.stdout.trim() === '' ? '(no stdout)' : result.stdout;
    const stderr = result.stderr.trim() === '' ? '' : `\n[stderr]\n${result.stderr}`;
    return { content: `${stdout}${stderr}\n${notes.join('\n')}` };
  }

  const audit = JSON.stringify(result.audit, null, 2);
  return {
    content: audit,
    error: `Sandbox ${result.status}: ${result.reason}`,
  };
}
