/**
 * HookRunner — executes tool-call hooks at the harness seam (Hooks slice 1).
 *
 * Wired into runAgent's gatedRun (core/loop/run-agent.ts), AFTER the PermissionGate's verdict:
 *  - {@link HookRunner.preToolUse} runs the matching PreToolUse hooks on a gate-ALLOWED call. A hook
 *    that exits non-zero (or times out → `code===null`) BLOCKS the call (fail-closed). Hooks can ONLY
 *    block — there is no allow path in this API — so a hook can never unlock a call the gate denied
 *    (the gate returns its deny before this is ever called; mirrors decide.ts "rules apply after,
 *    never unlock").
 *  - {@link HookRunner.postToolUse} runs the matching PostToolUse hooks AFTER the tool — advisory:
 *    exit code ignored, failures swallowed, the ToolResult is never altered. Same discipline as
 *    goal-loop's snapshotShadow: observability must not be able to break what it observes.
 *
 * Hook commands reuse the hardened {@link runCommand} (confined cwd, timeout + tree-kill, scrubbed
 * secret env) — never a bare shell (hard invariant #4). The tool-call context is handed to the hook
 * via env vars (JARVIS_HOOK_*), layered on AFTER secret-scrub so it can't smuggle a key back out.
 */
import { readFile, realpath as fsRealpath } from 'node:fs/promises';
import type { ToolCall, ToolResult } from '../../core/types.js';
import type { ToolCapability } from '../../core/tools/types.js';
import { runCommand, type ExecResult } from '../../core/tools/run-command.js';
import type { ReadText } from '../rules/index.js';
import { loadHookConfig, type HookConfig, type HookEntry, type HookEvent, type RealPath } from './hook-config.js';

/** Per-hook wall-clock ceiling (ms). A hook that outlives this is killed and treated as a block
 *  (PreToolUse) / ignored (PostToolUse) — it must not be able to wedge the agent loop. */
export const HOOK_TIMEOUT_MS = 30_000;
/** Cap on a hook command's captured output (chars). */
const HOOK_MAX_OUTPUT = 8_192;
/** How much of a blocking hook's output to echo back to the model (tail chars). */
const BLOCK_REASON_TAIL = 500;
/** Cap on the serialized tool input passed via env (avoid OS env-size limits on a big `write`). */
const HOOK_INPUT_CAP = 4_096;

/** A PreToolUse decision. `blocked:true` denies the call; `reason` is fed back to the model. There
 *  is deliberately NO allow path — a hook can only narrow, never unlock. */
export interface HookBlock {
  blocked: boolean;
  reason: string;
}

export interface HookRunner {
  /** Run matching PreToolUse hooks for a gate-allowed call. First non-zero exit ⇒ block (fail-closed). */
  preToolUse(call: ToolCall, capability: ToolCapability | undefined): Promise<HookBlock>;
  /** Run matching PostToolUse hooks (advisory; never blocks, never alters the result). */
  postToolUse(call: ToolCall, result: ToolResult): Promise<void>;
}

/** The {@link runCommand} signature — injected so tests drive the runner without a real shell. */
export type RunHookCommand = typeof runCommand;

export interface HookRunnerDeps {
  shellPath: string;
  cwd: string;
  /** Defaults to the real {@link runCommand}; tests inject a fake. */
  run?: RunHookCommand;
  signal?: AbortSignal;
}

const NOT_BLOCKED: HookBlock = { blocked: false, reason: '' };

export function createHookRunner(config: HookConfig, deps: HookRunnerDeps): HookRunner {
  const run = deps.run ?? runCommand;

  const exec = (event: HookEvent, hook: HookEntry, call: ToolCall): Promise<ExecResult> =>
    run(deps.shellPath, hook.command, deps.cwd, HOOK_TIMEOUT_MS, HOOK_MAX_OUTPUT, deps.signal, {
      scrubSecretEnv: true, // hooks must not be a side channel to exfil ARK_API_KEY etc. (invariant #4)
      extraEnv: hookEnv(event, call),
    });

  return {
    async preToolUse(call) {
      for (const hook of matching(config.PreToolUse, call.name)) {
        const res = await exec('PreToolUse', hook, call);
        // Non-zero OR null (timeout/killed) ⇒ block. The safe default when we can't confirm a clean
        // exit 0 is "deny" — fail-closed, mirroring the gate's no-approver path.
        if (res.code !== 0) return { blocked: true, reason: blockReason(res) };
      }
      return NOT_BLOCKED;
    },
    async postToolUse(call) {
      for (const hook of matching(config.PostToolUse, call.name)) {
        try {
          await exec('PostToolUse', hook, call);
        } catch {
          // Advisory — swallow. runCommand never rejects; this only backstops a misbehaving injected run.
        }
      }
    },
  };
}

/**
 * Build a HookRunner from a TRUSTED config path, or return "off". `hooksPath` is the value of
 * `JARVIS_HOOKS` — the CALLER must capture it from the LAUNCH env BEFORE loading any in-repo `.env`,
 * so an attacker-authored `.env` can't set it and enable repo hooks (codex 2026-06-30 review). Unset
 * ⇒ no hooks. Refuses an in-repo path (realpath-canonicalized) and a malformed config (see
 * {@link loadHookConfig}), returning a `warning` the caller surfaces. Production fs reader/realpath
 * are the defaults; tests can inject both.
 */
export async function resolveHooks(deps: {
  hooksPath?: string;
  cwd: string;
  shellPath: string;
  readText?: ReadText;
  realpath?: RealPath;
  signal?: AbortSignal;
}): Promise<{ hooks?: HookRunner; warning?: string }> {
  const loaded = await loadHookConfig({
    path: deps.hooksPath,
    cwd: deps.cwd,
    readText: deps.readText ?? defaultReadText,
    realpath: deps.realpath ?? defaultRealpath,
  });
  if (!loaded.config) return { warning: loaded.warning };
  return {
    hooks: createHookRunner(loaded.config, { shellPath: deps.shellPath, cwd: deps.cwd, signal: deps.signal }),
    warning: loaded.warning,
  };
}

const defaultReadText: ReadText = async (p) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

const defaultRealpath: RealPath = async (p) => {
  try {
    return await fsRealpath(p);
  } catch {
    return null; // missing / unresolvable → treated as unreadable by loadHookConfig
  }
};

/** The tool-call context handed to a hook via env. Kept small. */
function hookEnv(event: HookEvent, call: ToolCall): Record<string, string> {
  return {
    JARVIS_HOOK_EVENT: event,
    JARVIS_HOOK_TOOL: call.name,
    JARVIS_HOOK_TOOL_INPUT: hookInput(call.arguments ?? ''),
  };
}

/** The tool args handed to a hook. Within the cap, passed verbatim (the model-emitted JSON). OVER the
 *  cap, replaced with a VALID-JSON truncation sentinel — never a sliced (now-invalid) fragment — so a
 *  well-behaved hook that `JSON.parse`s the value can't choke on a big `write` payload and spuriously
 *  block the call (codex 2026-06-30 review). The cap also keeps env under OS per-var size limits. */
function hookInput(args: string): string {
  return args.length <= HOOK_INPUT_CAP ? args : JSON.stringify({ _jarvis_truncated: true, bytes: args.length });
}

/** Entries whose matcher glob matches the tool name (anchored, `*` the only wildcard). */
function matching(entries: HookEntry[], toolName: string): HookEntry[] {
  return entries.filter((e) => globMatch(e.matcher, toolName));
}

/** The denial reason fed back to the model — the hook's exit + a tail of its output (or the spawn
 *  error when the hook process couldn't even start). gatedRun prefixes `Permission denied: `. */
function blockReason(res: ExecResult): string {
  const code = res.timedOut ? 'timeout' : res.code === null ? 'killed' : String(res.code);
  const detail = (res.spawnError ?? res.output).trim().slice(-BLOCK_REASON_TAIL);
  return `PreToolUse hook blocked (exit ${code})${detail ? `: ${detail}` : ''}`;
}

/** Anchored wildcard match — `*` matches any run (including empty), everything else literal. A linear
 *  two-pointer scan (NOT a regex): a pathological config matcher can't trigger catastrophic regex
 *  backtracking / ReDoS on the tool name (codex 2026-06-30 review). */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = v;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (star !== -1) {
      p = star + 1;
      v = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
