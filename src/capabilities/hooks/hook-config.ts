/**
 * Hook config — load and parse the user's tool-call hooks (Hooks slice 1).
 *
 * Two events: PreToolUse (runs BEFORE a tool, can fail-closed BLOCK it) and PostToolUse (runs
 * AFTER, advisory side-effect only). The runtime (hook-runner.ts) executes a matched hook's
 * `command` via the hardened {@link runCommand}; this file only loads and validates the config.
 *
 * The trust boundary is the OPPOSITE of B5 rules and is the whole reason hooks are gated tighter:
 *  - **Rules** can only ADD deny, so loading them from the (untrusted) repo under cwd is safe —
 *    that's why the rule-resolver scans cwd (see surfaces/cli/index.ts).
 *  - **Hooks EXECUTE arbitrary shell.** Loading a hook command from the repo == arbitrary code
 *    execution the moment the agent works on an untrusted repo — the same threat that killed the
 *    bash allow-list Path A (memory restore-bash-session-allow). So hook config is read ONLY from a
 *    trusted, launch-controlled source ({@link loadHookConfig}'s injected path, from `JARVIS_HOOKS`),
 *    and a path resolving INSIDE cwd is REFUSED. There is no code path that scans cwd for hooks.
 *
 * Loading discipline mirrors the rule-resolver: I/O is injected (`readText`) so parsing stays pure
 * and unit-testable, and absence of config means hooks are simply OFF (opt-in, like vision/leg3).
 * Format is JSON (a hook entry is structurally richer than an allow/deny string, which the zero-dep
 * frontmatter parser can't express), so {@link parseHookConfig} uses `JSON.parse`.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { ReadText } from '../rules/index.js';

/** Canonicalizes a path (resolving symlinks + Windows `\\?\` + `..` + case), or null if it can't be
 *  resolved (missing/unreadable). Injected so the containment check stays unit-testable. */
export type RealPath = (path: string) => Promise<string | null>;

/** The two tool-call lifecycle events this slice supports. */
export type HookEvent = 'PreToolUse' | 'PostToolUse';

/** One configured hook: a tool-name matcher + the shell command to run. */
export interface HookEntry {
  /** Tool-name glob (`*` is the only wildcard). `*` / omitted ⇒ matches every tool. */
  matcher: string;
  /** The shell command to run (non-empty), executed via the hardened {@link runCommand}. */
  command: string;
}

/** The parsed hook config: ordered entries per event (empty arrays when none configured). */
export interface HookConfig {
  PreToolUse: HookEntry[];
  PostToolUse: HookEntry[];
}

/** What {@link loadHookConfig} returns: a config (when one was loaded) and/or a warning to surface.
 *  No config + a warning means "we refused/failed to load — hooks stay OFF"; no config + no warning
 *  means "none configured" (the default-off path). */
export interface LoadHookResult {
  config?: HookConfig;
  warning?: string;
}

/**
 * Load hook config from a trusted path (from `JARVIS_HOOKS`), or return "off" when absent.
 *
 * REFUSES a path resolving inside `cwd` (hard invariant #2: in-repo hook config is excluded — it
 * would be attacker-authored code execution). A read failure or a parse error disables hooks with a
 * warning rather than crashing the session. I/O is injected so this is unit-testable without fs.
 */
export async function loadHookConfig(deps: {
  path?: string;
  cwd: string;
  readText: ReadText;
  realpath?: RealPath;
}): Promise<LoadHookResult> {
  const { path, cwd, readText, realpath } = deps;
  if (path === undefined || path.trim() === '') return {}; // not configured → off

  // Canonicalize BOTH the config path and cwd BEFORE the containment check. A purely lexical
  // resolve()/relative() is fooled (codex 2026-06-30 adversarial review) by:
  //  - Windows `\\?\` extended-length paths: `\\?\H:\repo\.hooks.json` lexically looks OUTSIDE
  //    `H:\repo` yet readFile opens the in-repo file;
  //  - symlinks: a trusted-looking path outside cwd whose target is an in-repo file.
  // realpath collapses `\\?\`, symlinks, `..`, and case to the true location, so the in-repo
  // exclusion (invariant #2) can't be smuggled past. No realpath injected (pure tests) → lexical.
  const canonCwd = (realpath ? await realpath(cwd) : null) ?? resolve(cwd);
  const canonPath = realpath ? await realpath(path.trim()) : resolve(path.trim());
  if (canonPath === null) {
    return { warning: `JARVIS_HOOKS 配置文件无法读取 (${path.trim()})。已禁用 hooks。` };
  }
  if (isInsideCwd(canonPath, canonCwd)) {
    return {
      warning: `JARVIS_HOOKS 指向工作目录内 (${canonPath})——拒绝从仓库加载 hook 配置（仓内 hook = 任意代码执行）。已禁用 hooks。`,
    };
  }

  const text = await readText(canonPath);
  if (text === null) return { warning: `JARVIS_HOOKS 配置文件无法读取 (${canonPath})。已禁用 hooks。` };

  try {
    return { config: parseHookConfig(text) };
  } catch (err) {
    return { warning: `JARVIS_HOOKS 配置解析失败 (${canonPath}): ${err instanceof Error ? err.message : String(err)}。已禁用 hooks。` };
  }
}

/** Parse a hook config document. Throws a descriptive error on any shape violation (the loader
 *  catches it → warn + disable). Pure — no I/O. */
export function parseHookConfig(text: string): HookConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('hook 配置必须是一个 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;
  // Reject unknown top-level keys LOUDLY. A typo'd event name (e.g. `PreToolUes`) would otherwise be
  // silently dropped → a security guard the user believes is active is actually off. Fail-disable +
  // warning (the loader catches this) makes the mistake visible (codex 2026-06-30 review).
  const unknown = Object.keys(obj).filter((k) => k !== 'PreToolUse' && k !== 'PostToolUse');
  if (unknown.length > 0) {
    throw new Error(`未知的顶层配置项: ${unknown.join(', ')}（只支持 PreToolUse / PostToolUse；拼写错误会让 hook 静默失效，故拒绝）`);
  }
  return {
    PreToolUse: parseEntries(obj.PreToolUse, 'PreToolUse'),
    PostToolUse: parseEntries(obj.PostToolUse, 'PostToolUse'),
  };
}

/** Validate and normalize one event's entry array. Missing ⇒ []. */
function parseEntries(value: unknown, event: HookEvent): HookEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${event} 必须是数组`);
  return value.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${event}[${i}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.command !== 'string' || entry.command.trim() === '') {
      throw new Error(`${event}[${i}].command 必须是非空字符串`);
    }
    if (entry.matcher !== undefined && typeof entry.matcher !== 'string') {
      throw new Error(`${event}[${i}].matcher 必须是字符串`);
    }
    // A present-but-empty matcher is almost always a typo; silently treating it as match-all would
    // widen a BLOCKING hook to every tool. Omitting matcher is the explicit "all" form — an empty
    // string is rejected (codex 2026-06-30 review).
    if (typeof entry.matcher === 'string' && entry.matcher.trim() === '') {
      throw new Error(`${event}[${i}].matcher 不能是空字符串（省略 matcher 才表示匹配所有工具；空串多半是笔误）`);
    }
    const matcher = entry.matcher === undefined ? '*' : entry.matcher.trim();
    return { matcher, command: entry.command };
  });
}

/** Whether `absPath` resolves inside `cwd` (so an in-repo hook config can be refused). Cross-platform:
 *  `relative` returns a `..`-prefixed or absolute (different-drive) path when outside. */
function isInsideCwd(absPath: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), absPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
