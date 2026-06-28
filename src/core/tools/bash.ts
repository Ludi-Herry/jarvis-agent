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
 * Execution-layer safety (the gate decides IF a command runs; this decides HOW, safely):
 *  - **Confined cwd**: the command runs in `ctx.cwd`, the project root the loop injects.
 *  - **Timeout + tree-kill**: a command past its deadline is killed with its whole child tree
 *    (`taskkill /T` on Windows, SIGKILL elsewhere) so a hung `npm install` can't wedge the loop.
 *  - **Bounded capture**: stdout+stderr are merged and capped, so runaway output can't exhaust
 *    memory; the loop's ContextManager budgets the rest to disk.
 *  - **Failures are results, not throws**: a non-zero exit, a timeout, or a missing shell all come
 *    back as a ToolRunResult the model can read and react to (matching the registry contract).
 *
 * Target shell is POSIX bash (Git Bash on Windows) — the same shell the B2 analyzer parses for, so
 * "what we checked" and "what we run" are the same language.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition } from './types.js';

/** Default kill deadline. Long enough for a real build/test, short enough not to hang forever. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap captured output so a noisy command can't exhaust memory; the ContextManager offloads the
 *  rest to disk. Comfortably above the loop's 50K budget threshold. */
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
/** After we kill a timed-out/aborted command, resolve anyway this soon even if the OS never
 *  reports the child closed — so a kill-resistant or detached process can't wedge the loop. */
const KILL_GRACE_MS = 2_000;

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
      const res = await execute(shellPath, command, ctx.cwd, timeout, maxOutputChars, ctx.signal);

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

interface ExecResult {
  output: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  spawnError?: string;
}

/** Spawn `bash -c command` in `cwd`, capture merged output (capped), and kill the whole tree if it
 *  outlives `timeoutMs` or the turn is aborted. Never rejects, and — critically — never depends on
 *  the kill actually succeeding: after a kill we force-resolve within {@link KILL_GRACE_MS}, so a
 *  kill-resistant or detached process can't leave the loop awaiting forever. */
function execute(
  shellPath: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let graceArmed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const child = spawn(shellPath, ['-c', command], { cwd, windowsHide: true, env: shellEnv() });

    const finish = (result: Pick<ExecResult, 'code' | 'spawnError'>): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ output, truncated, timedOut, aborted, ...result });
    };

    // Kill the tree, then arm an INDEPENDENT fallback that resolves even if 'close' never fires —
    // so a kill-resistant or detached process can never leave the loop awaiting forever.
    const killAndGrace = (): void => {
      killTree(child.pid);
      if (graceArmed) return;
      graceArmed = true;
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ code: null });
        }, KILL_GRACE_MS),
      );
    };

    function onAbort(): void {
      aborted = true;
      killAndGrace();
    }

    const append = (buf: Buffer): void => {
      if (truncated) return;
      const remaining = maxOutputChars - output.length;
      const text = buf.toString('utf8');
      if (text.length >= remaining) {
        output += text.slice(0, remaining);
        truncated = true;
      } else {
        output += text;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    timers.push(
      setTimeout(() => {
        timedOut = true;
        killAndGrace();
      }, timeoutMs),
    );

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort);

    child.on('error', (err) => finish({ code: null, spawnError: err.message }));
    child.on('close', (code) => finish({ code }));
  });
}

/** Kill a process AND its children. On Windows the child shell spawns its own subprocesses that a
 *  plain kill leaves orphaned, so use `taskkill /T`; elsewhere SIGKILL the process. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Best-effort; the spawned taskkill is fire-and-forget. Ignore its own failures.
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** The child shell's environment, with the startup-file hooks stripped. A non-interactive bash
 *  sources `$BASH_ENV` (and a POSIX sh sources `$ENV`) BEFORE it runs `-c <command>` — code the
 *  command analyzer never parsed and the user never approved, so "what we checked" wouldn't be
 *  "what runs". Everything else (PATH, …) is inherited so commands still work; only these two
 *  startup hooks are dropped. (The model can't set the parent process's env anyway, but dropping
 *  them closes the door even when the operator's own environment carries one.) */
function shellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  return env;
}

/** Resolve the bash executable. An explicit `JARVIS_BASH` wins; on Windows prefer the Git Bash
 *  install (the PATH `bash` is often the WindowsApps WSL stub, which has different cwd/FS
 *  semantics); otherwise fall back to `bash` on PATH. */
export function defaultShellPath(): string {
  if (process.env.JARVIS_BASH) return process.env.JARVIS_BASH;
  if (process.platform === 'win32') {
    const candidates = [
      `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
      `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
      `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
