/**
 * bash — the first ExecutesCode tool (B3, plan §3.4). Runs a shell command and feeds its output
 * back to the model, so the agent can build / test / use git, not just read and write files.
 *
 * This tool is DANGEROUS by construction, so it is never safe ungated: it carries the
 * `executes-code` capability, which the PermissionGate routes through the deterministic command
 * analyzer (B2) before anything runs — a dangerous or secret-touching command is denied and never
 * reaches a shell. Register it only alongside a gate (the b3-demo and the B4 REPL do; the bare
 * default registry does NOT).
 *
 * The hardened spawn/timeout/tree-kill runner lives in {@link runCommand} (run-command.ts), shared
 * with the goal verifier's leg-1 checks. This tool wraps it model-facing: it surfaces the exit code
 * as a `[exit code: …]` text note (leg 1 reads the structured `code` from runCommand directly).
 *
 * Target shell is POSIX bash (Git Bash on Windows) — the same shell the B2 analyzer parses for.
 */
import { z } from 'zod';
import { defaultShellPath, runCommand } from './run-command.js';
import type { ToolDefinition } from './types.js';

// Re-exported for back-compat: callers/tests that imported `defaultShellPath` from here keep working;
// its home is now run-command.ts (shared with the goal verifier's leg-1 checks).
export { defaultShellPath } from './run-command.js';

/** Default kill deadline. Long enough for a real build/test, short enough not to hang forever. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap captured output so a noisy command can't exhaust memory; the ContextManager offloads the
 *  rest to disk. Comfortably above the loop's 50K budget threshold. */
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

export interface BashToolOptions {
  /** Path to the bash executable. Defaults to the Git Bash resolver ({@link defaultShellPath}). */
  shellPath?: string;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
}

/** Build the bash tool. A factory (not a const) so the shell path and limits are injectable —
 *  tests pin an explicit bash, the demo/REPL take the default. */
export function createBashTool(options: BashToolOptions = {}): ToolDefinition<{ command: string; timeout_ms?: number }> {
  const shellPath = options.shellPath ?? defaultShellPath();
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  return {
    name: 'bash',
    description:
      'Run a shell command in a POSIX bash shell and return its combined stdout+stderr. The command ' +
      'runs in the project root. Dangerous or secret-touching commands are blocked by the permission ' +
      'gate. Use for build/test/git/inspecting the project; prefer the read/write/grep tools for plain ' +
      'file access.',
    capability: 'executes-code',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run (POSIX bash syntax).'),
      timeout_ms: z
        .number()
        .int()
        .optional()
        .describe(`Kill the command after this many milliseconds (default ${defaultTimeout}, max ${MAX_TIMEOUT_MS}).`),
    }),
    run: async ({ command, timeout_ms }, ctx) => {
      const timeout = clamp(timeout_ms ?? defaultTimeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const res = await runCommand(shellPath, command, ctx.cwd, timeout, maxOutputChars, ctx.signal);

      if (res.spawnError !== undefined) {
        return { content: '', error: `Failed to start shell (${shellPath}): ${res.spawnError}` };
      }

      const body = res.output.trim() === '' ? '(no output)' : res.output;
      const notes: string[] = [];
      if (res.truncated) notes.push(`[output truncated at ${maxOutputChars} chars]`);
      if (res.aborted) notes.push('[aborted and killed]');
      else if (res.timedOut) notes.push(`[timed out after ${timeout}ms and was killed]`);
      else if (res.code !== 0 && res.code !== null) notes.push(`[exit code: ${res.code}]`);
      return { content: notes.length > 0 ? `${body}\n${notes.join('\n')}` : body };
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
