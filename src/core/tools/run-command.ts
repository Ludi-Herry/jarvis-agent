/**
 * runCommand — spawn a shell command, capture merged output (capped), kill the whole tree on
 * timeout/abort, and return the STRUCTURED result (real exit `code`). Extracted from bash.ts so two
 * callers share one hardened runner:
 *  - the bash TOOL (model-facing, gated) — surfaces output as text;
 *  - the goal verifier's leg-1 objective checks (harness-run) — needs the structured `code`, which
 *    the bash tool only exposes as a `[exit code: …]` text note.
 *
 * Safety (unchanged from bash.ts B3): confined cwd, timeout + tree-kill (taskkill /T on Windows,
 * SIGKILL the process group on POSIX), bounded capture, NEVER rejects, and never depends on the kill
 * succeeding — force-resolve within {@link KILL_GRACE_MS} so a kill-resistant/detached process can't
 * wedge the caller. The non-interactive startup hooks (`BASH_ENV`/`ENV`) are stripped from the env;
 * and the MODEL-FACING bash tool additionally passes `scrubSecretEnv` so credential-shaped vars
 * (`ARK_API_KEY`, `*_TOKEN`, …) are removed — the agent can't `echo` a key out of its own environment.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** After we kill a timed-out/aborted command, resolve anyway this soon even if the OS never reports
 *  the child closed — so a kill-resistant or detached process can't wedge the caller. */
const KILL_GRACE_MS = 2_000;

export interface ExecResult {
  output: string;
  /** The real exit code (null when killed/abnormal). The whole reason this is extracted: leg 1 needs
   *  this structured, not a text note. */
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  spawnError?: string;
}

export interface RunCommandOptions {
  /** Scrub secret-shaped env vars (API keys, tokens, `ARK_*`) from the child shell. Set ONLY for the
   *  MODEL-FACING bash tool, so the agent can't `echo $ARK_API_KEY` and exfil it. Harness-run commands
   *  (leg-1/held-out checks, git baseline — config-sourced, not model-chosen) omit this and keep the
   *  full env, since their commands are trusted and may legitimately need it. */
  scrubSecretEnv?: boolean;
  /** Extra env vars layered onto the child shell AFTER secret-scrubbing — for handing trusted context
   *  (e.g. a hook's JARVIS_HOOK_* tool-call metadata) to the command without re-exposing scrubbed
   *  secrets. Applied last, so these keys win over inherited env. */
  extraEnv?: Record<string, string>;
  /** Remove inherited Git configuration/env hooks before layering `extraEnv`. Use for harness-owned
   *  Git invocations that inspect or apply untrusted worktrees, so repo/user env cannot turn reads into
   *  command execution via fsmonitor, external diff, pagers, or similar Git extension points. */
  scrubGitEnv?: boolean;
}

/** Spawn `shellPath -c command` in `cwd`, capture merged stdout+stderr (capped at `maxOutputChars`),
 *  and kill the whole tree if it outlives `timeoutMs` or `signal` aborts. Never rejects. */
export function runCommand(
  shellPath: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  signal?: AbortSignal,
  options?: RunCommandOptions,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let graceArmed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // On POSIX, detach so the child LEADS its own process group — killTree then signals the whole
    // group (negative pid), the analogue of Windows `taskkill /t`. On Windows we stay attached.
    const child = spawn(shellPath, ['-c', command], {
      cwd,
      windowsHide: true,
      env: shellEnv(options?.scrubSecretEnv, options?.extraEnv, options?.scrubGitEnv),
      detached: process.platform !== 'win32',
    });

    const finish = (result: Pick<ExecResult, 'code' | 'spawnError'>): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ output, truncated, timedOut, aborted, ...result });
    };

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

/** Kill a process AND its children. Windows: `taskkill /T` walks the tree; POSIX: SIGKILL the whole
 *  process GROUP via negative pid (the child was spawned detached as its own group leader). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/** The child shell's env with the startup-file hooks stripped: a non-interactive bash sources
 *  `$BASH_ENV` (POSIX sh sources `$ENV`) BEFORE `-c <command>` — code never parsed/approved. When
 *  `scrubSecrets` is set (the model-facing bash tool), credential-shaped vars are also removed so the
 *  agent can't read a key out of its own environment. `extraEnv` is layered on LAST (after scrubbing),
 *  so trusted caller-supplied context (e.g. a hook's JARVIS_HOOK_* vars) survives the scrub. */
function shellEnv(scrubSecrets = false, extraEnv?: Record<string, string>, scrubGitEnv = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  if (scrubGitEnv) {
    for (const name of Object.keys(env)) {
      if (name.toUpperCase().startsWith('GIT_')) delete env[name];
    }
  }
  if (scrubSecrets) {
    for (const name of Object.keys(env)) {
      if (isSecretEnvName(name)) delete env[name];
    }
  }
  if (extraEnv) {
    for (const [name, value] of Object.entries(extraEnv)) env[name] = value;
  }
  return env;
}

/**
 * Whether an env var NAME looks credential-bearing — scrubbed from the MODEL-FACING shell so the agent
 * can't `echo $ARK_API_KEY` (or any token/secret) and exfil it. Conservative on purpose: over-scrubbing
 * the model shell is safe (it's gated + cwd-confined and never needs these), under-scrubbing leaks a
 * key. Keeps innocuous vars (PATH, HOME, LANG, TMP, SSH_AUTH_SOCK) since none match.
 */
export function isSecretEnvName(name: string): boolean {
  const n = name.toUpperCase();
  if (n.startsWith('ARK_')) return true; // this app's provider config + key — the model shell never needs it
  // unambiguous credential substrings
  if (/SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|APIKEY|AUTHORIZATION|PRIVATE_KEY|ACCESS_KEY/.test(n)) return true;
  // credential-shaped name COMPONENTS (avoids PATH, MONKEY, TURNKEY, CONNECTIONS_COUNT)
  if (/(^|_)(KEY|PAT|DSN)($|_)/.test(n)) return true;
  // connection strings carry inline credentials (e.g. postgres://user:pass@host)
  if (/(^|_)(DATABASE|DB|MONGODB?|REDIS|POSTGRES(QL)?|MYSQL|MARIADB|AMQP|RABBITMQ|CLICKHOUSE|ELASTIC(SEARCH)?|CONNECTION)_(URL|URI|DSN|CONN|CONNECTION|STRING)/.test(n)) {
    return true;
  }
  return false;
}

/** Resolve the bash executable. `JARVIS_BASH` wins; on Windows prefer the Git Bash install (the PATH
 *  `bash` is often the WindowsApps WSL stub); otherwise fall back to `bash` on PATH. */
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
