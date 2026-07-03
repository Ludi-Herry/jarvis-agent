import { z } from 'zod';
import type { SandboxLimits, SandboxRunResult, SandboxRunner } from '../../runtime/sandbox/index.js';
import type { ToolDefinition } from './types.js';

const DEFAULT_SANDBOX_SOURCE_DIR = '/tmp/jarvis-sandbox/source';
const DEFAULT_SANDBOX_WORK_DIR = '/tmp/jarvis-sandbox/work';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_BYTES = 131_072;

const BUILDER_CHECK_COMMANDS = {
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  test: 'npm test',
  build: 'npm run build',
} as const;

const SNAPSHOT_EXCLUDES = [
  '.git',
  '.env',
  '.env.*',
  '*/.env',
  '*/.env.*',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '*/.npmrc',
  '*/.netrc',
  '*/.git-credentials',
  '.ssh',
  '.ssh/*',
  '*/.ssh',
  '*/.ssh/*',
  'auth.json',
  '*/auth.json',
  'credential',
  'credential.*',
  'credentials',
  'credentials.*',
  '*/credential',
  '*/credential.*',
  '*/credentials',
  '*/credentials.*',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa.*',
  'id_dsa.*',
  'id_ecdsa.*',
  'id_ed25519.*',
  '*/id_rsa',
  '*/id_dsa',
  '*/id_ecdsa',
  '*/id_ed25519',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.token',
  '*.crt',
  '*.cer',
  '*/*.key',
  '*/*.pem',
  '*/*.p12',
  '*/*.pfx',
  '*/*.token',
  '*/*.crt',
  '*/*.cer',
] as const;

export type SandboxedBuilderCheckName = keyof typeof BUILDER_CHECK_COMMANDS;

export interface SandboxedBuilderCheckToolOptions {
  readonly runner: SandboxRunner;
  readonly sandboxSourceDir?: string;
  readonly sandboxWorkDir?: string;
  readonly limits?: Partial<SandboxLimits>;
}

export function createSandboxedBuilderCheckTool(
  options: SandboxedBuilderCheckToolOptions,
): ToolDefinition<{ check: SandboxedBuilderCheckName; reason?: string }> {
  const sandboxSourceDir = options.sandboxSourceDir ?? DEFAULT_SANDBOX_SOURCE_DIR;
  const sandboxWorkDir = options.sandboxWorkDir ?? DEFAULT_SANDBOX_WORK_DIR;
  const limits: SandboxLimits = {
    timeoutMs: options.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputBytes: options.limits?.outputBytes ?? DEFAULT_OUTPUT_BYTES,
    ...(options.limits?.maxProcesses !== undefined ? { maxProcesses: options.limits.maxProcesses } : {}),
    ...(options.limits?.memoryBytes !== undefined ? { memoryBytes: options.limits.memoryBytes } : {}),
    ...(options.limits?.cpuMillis !== undefined ? { cpuMillis: options.limits.cpuMillis } : {}),
  };

  return {
    name: 'sandboxed_check',
    description:
      'Run one allow-listed project check in the OS sandbox and return stdout/stderr to the builder. ' +
      'Allowed checks are typecheck, lint, test, and build. The host project is mounted read-only, ' +
      'copied into a sandbox-local work directory with secret-shaped paths excluded, network is disabled, ' +
      'and non-zero check exits are reported as normal feedback so the builder can keep fixing.',
    capability: 'read-only',
    inputSchema: z.object({
      check: z
        .enum(['typecheck', 'lint', 'test', 'build'])
        .describe('The project check to run inside the sandbox. No arbitrary shell command is accepted.'),
      reason: z.string().optional().describe('Why this sandboxed check is useful now.'),
    }),
    run: async ({ check, reason }, ctx) => {
      const command = BUILDER_CHECK_COMMANDS[check];
      const script = buildSandboxScript({ command, sandboxSourceDir, sandboxWorkDir });
      const result = await options.runner.run({
        command: ['bash', '--noprofile', '--norc', '-c', script],
        cwd: sandboxSourceDir,
        mounts: [{ hostPath: ctx.cwd, sandboxPath: sandboxSourceDir, access: 'read-only' }],
        networkMode: 'none',
        limits,
        reason: formatReason(check, reason),
      });

      return renderSandboxCheckResult(check, command, result);
    },
  };
}

function buildSandboxScript(input: { command: string; sandboxSourceDir: string; sandboxWorkDir: string }): string {
  const excludeArgs = SNAPSHOT_EXCLUDES.map((pattern) => `--exclude=${shellQuote(pattern)}`).join(' ');
  return [
    'set -euo pipefail',
    `rm -rf ${shellQuote(input.sandboxWorkDir)}`,
    `mkdir -p ${shellQuote(input.sandboxWorkDir)}`,
    `tar ${excludeArgs} -cf - -C ${shellQuote(input.sandboxSourceDir)} . | tar -xf - -C ${shellQuote(input.sandboxWorkDir)}`,
    `cd ${shellQuote(input.sandboxWorkDir)}`,
    input.command,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatReason(check: SandboxedBuilderCheckName, reason: string | undefined): string {
  return reason === undefined || reason.trim() === '' ? `builder check ${check}` : `builder check ${check}: ${reason}`;
}

function renderSandboxCheckResult(
  check: SandboxedBuilderCheckName,
  command: string,
  result: SandboxRunResult,
): { content: string; error?: string } {
  if (result.status === 'completed') {
    const notes = [
      `[sandboxed check: ${check}]`,
      `[command: ${command}]`,
      `[sandbox backend: ${result.backend}]`,
      `[exit code: ${result.exitCode}]`,
      `[duration ms: ${result.durationMs}]`,
    ];
    const stdout = result.stdout.trim() === '' ? '(no stdout)' : result.stdout;
    const stderr = result.stderr.trim() === '' ? '' : `\n[stderr]\n${result.stderr}`;
    return { content: `${stdout}${stderr}\n${notes.join('\n')}` };
  }

  return {
    content: JSON.stringify(result.audit, null, 2),
    error: `Sandbox ${result.status}: ${result.reason}`,
  };
}
