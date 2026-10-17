/**
 * plain-controls — GUI plain-v1 P2 decision points (docs/PLAN-gui-plain-v1.md §P2).
 *
 * 1. Permission modes. The composer offers three plain-language modes (只讨论 / 改之前问我 / 自动).
 *    {@link decideModeGate} is the pure verdict layered INSIDE the existing GUI contract gate: it
 *    runs after the writePaths/shellCommands boundary and the hard `decide()` checks, and before
 *    DefaultPermissionGate asks a human. It may only
 *      - narrow: `discuss` refuses every non-read effect, so the model must answer in words; or
 *      - skip the human ask for a file write the contract already lists (`auto`).
 *    It never widens executes-code or network. Bash auto-allow stays out per the security baseline
 *    ("bash allow-list round": the analyzer is a deny-oracle, not an allow-oracle), so `auto` still
 *    asks before any command; the per-command "这个任务都允许" grant lives in the gate.
 *
 * 2. Task-scoped undo. GUI writes are confined to contract.writePaths, and start already freezes
 *    a private Git tree of the source files (captureBaseline → baseline.headSha). Undo restores
 *    exactly those paths from that tree through a THROWAWAY index; the state before undo is saved
 *    as another tree so 恢复 (redo) is the same operation in reverse. The user's Git index and the
 *    task's baseline index are never touched. Session checkpoints/rewind are not reused here:
 *    a finished task's session carries tool receipts, which checkpoint rewind deliberately refuses
 *    (isReceiptFreeRewindProjection), and file rewind there requires ShadowGit.
 *
 * Git helpers take an injected runner so this module has no process/filesystem dependency of its
 * own and the decisions stay unit-testable (AGENTS.md: 决策点写成无状态纯函数 + 单测).
 */
import type { ToolCapability } from '../../core/tools/types.js';
import type { GuiPermissionMode, GuiUndoFile } from './live-types.js';

export const GUI_PERMISSION_MODES: readonly GuiPermissionMode[] = ['discuss', 'ask', 'auto'];

/** Pre-v1 journals carry no mode event; they keep today's behavior. */
export const DEFAULT_GUI_PERMISSION_MODE: GuiPermissionMode = 'ask';

export function parsePermissionMode(value: unknown): GuiPermissionMode | undefined {
  return typeof value === 'string' && (GUI_PERMISSION_MODES as readonly string[]).includes(value)
    ? value as GuiPermissionMode
    : undefined;
}

/** Fed back to the model as the denial reason, so it switches to explaining instead of retrying. */
export const DISCUSS_MODE_REASON = '用户当前选的是「只讨论」：这一步不改文件、不运行命令。请先用文字说明你打算怎么改、改哪些地方，等用户切到「改之前问我」或「自动」后再动手。';
export const AUTO_MODE_REASON = '「自动」模式：本任务合同列出的文件写入不再逐次询问';

export type ModeGateVerdict =
  | { kind: 'defer' }
  | { kind: 'deny'; reason: string }
  | { kind: 'allow'; reason: string };

export interface ModeGateInput {
  /** The task's current composer mode; absent means {@link DEFAULT_GUI_PERMISSION_MODE}. */
  mode: GuiPermissionMode | undefined;
  toolName: string;
  capability: ToolCapability;
  /** The pure `decide()` action for this call under the effective policy (hard checks first). */
  hardAction: 'allow' | 'ask' | 'deny';
}

/**
 * The mode layer's verdict for one call. Callers must have applied the contract boundary first
 * (writePaths / shellCommands); `defer` hands the call to the unchanged DefaultPermissionGate.
 */
export function decideModeGate(input: ModeGateInput): ModeGateVerdict {
  const mode = input.mode ?? DEFAULT_GUI_PERMISSION_MODE;
  // A hard deny (secret path, dangerous command, configured ceiling) is never reinterpreted here.
  if (input.hardAction === 'deny') return { kind: 'defer' };
  // Reads and the goal bookkeeping tool keep their existing lane in every mode.
  if (input.capability === 'read-only' || input.toolName === 'update_goal') return { kind: 'defer' };
  if (mode === 'discuss') return { kind: 'deny', reason: DISCUSS_MODE_REASON };
  if (mode === 'auto' && input.capability === 'writes-files' && input.hardAction === 'ask') {
    return { kind: 'allow', reason: AUTO_MODE_REASON };
  }
  return { kind: 'defer' };
}

/** Why undo/redo cannot run right now, or undefined when it may. Pure; the host gathers facts. */
export function undoBlocker(facts: {
  started: boolean;
  running: boolean;
  /** A crashed active task that can still resume: its Session believes the writes happened. */
  resumable: boolean;
  reviewing: boolean;
  terminalRunning: boolean;
  workspaceBusy: boolean;
}): string | undefined {
  if (!facts.started) return '任务还没开始，没有改动可以撤销';
  if (facts.running) return '任务还在进行中；先停止或等它结束再撤销';
  if (facts.resumable) return '任务中断了但还能接着跑；先恢复跑完或停止它，再撤销';
  if (facts.reviewing) return '正在提交验收，稍后再试';
  if (facts.terminalRunning) return '终端里还有命令在运行，等它结束再撤销';
  if (facts.workspaceBusy) return '同一个项目里还有任务在运行或正在启动，等它结束再撤销';
  return undefined;
}

/** One git invocation. The host runs it in the task cwd with GIT_INDEX_FILE = the throwaway index. */
export type UndoGitRun = (command: string) => Promise<{ code: number | null; output: string; truncated?: boolean }>;

export interface UndoGitDeps {
  run: UndoGitRun;
  /** Shell-quote one literal argument (the host's shellQuote). */
  quote: (value: string) => string;
  /** The contract's writePaths, relative to the task cwd. */
  paths: readonly string[];
}

const TREE_SHA = /^[a-f0-9]{40,64}$/u;

export function normalizeWritePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function assertTree(sha: string, what: string): void {
  if (!TREE_SHA.test(sha)) throw new Error(`${what}不是有效的 Git 树`);
}

async function must(deps: UndoGitDeps, command: string, failure: string): Promise<string> {
  const result = await deps.run(command);
  if (result.code !== 0 || result.truncated) throw new Error(`${failure}：${result.output.trim().slice(0, 300)}`);
  return result.output;
}

function pathArgs(deps: UndoGitDeps): string {
  return deps.paths.map((path) => deps.quote(normalizeWritePath(path))).join(' ');
}

/**
 * Freeze the CURRENT state of the write paths as a tree: the baseline tree with each write path
 * replaced by what is on disk now (or dropped when the file is gone). Its SHA doubles as the
 * fingerprint the UI echoes back, so a confirm on a stale view is refused.
 */
export async function captureWritePathsTree(
  deps: UndoGitDeps & { baseTree: string; exists: (path: string) => boolean },
): Promise<string> {
  assertTree(deps.baseTree, '基线');
  await must(deps, `git -c core.fsmonitor=false read-tree ${deps.baseTree}`, '无法读取任务开始时的基线');
  for (const raw of deps.paths) {
    const path = normalizeWritePath(raw);
    const command = deps.exists(path)
      ? `git -c core.fsmonitor=false add -- ${deps.quote(path)}`
      : `git -c core.fsmonitor=false rm -q --cached --ignore-unmatch -- ${deps.quote(path)}`;
    await must(deps, command, `无法记录文件现状：${path}`);
  }
  const sha = (await must(deps, 'git -c core.fsmonitor=false write-tree', '无法固定文件现状')).trim();
  assertTree(sha, '文件现状');
  return sha;
}

/** Write-path changes between two trees, cwd-relative, in contract order. */
export async function diffWritePaths(deps: UndoGitDeps, from: string, to: string): Promise<GuiUndoFile[]> {
  assertTree(from, '起点');
  assertTree(to, '终点');
  if (from === to || deps.paths.length === 0) return [];
  const output = await must(deps,
    `git -c core.quotePath=false diff --relative --no-renames --name-status ${from} ${to} -- ${pathArgs(deps)}`,
    '无法比较改动');
  const changes = new Map<string, GuiUndoFile['change']>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([ACDMRTUX])\d*\t(.+)$/u.exec(line.trim());
    if (!match) continue;
    changes.set(normalizeWritePath(match[2]), match[1] === 'A' ? 'added' : match[1] === 'D' ? 'deleted' : 'modified');
  }
  return deps.paths.map(normalizeWritePath).flatMap((path) => {
    const change = changes.get(path);
    return change ? [{ path, change }] : [];
  });
}

/**
 * Make the write paths on disk equal to `tree`: files present in it are checked out from a
 * throwaway index (Git applies the repo's own eol/attribute rules); files absent from it are
 * removed through the host's confined `remove`. Nothing outside the write paths is touched.
 */
export async function restoreWritePaths(
  deps: UndoGitDeps & { tree: string; remove: (path: string) => Promise<void> },
): Promise<void> {
  assertTree(deps.tree, '目标');
  if (deps.paths.length === 0) return;
  await must(deps, `git -c core.fsmonitor=false read-tree ${deps.tree}`, '无法读取要恢复到的版本');
  const listed = await must(deps, `git -c core.quotePath=false ls-files -- ${pathArgs(deps)}`, '无法列出要恢复的文件');
  const present = new Set(listed.split(/\r?\n/u).map((line) => normalizeWritePath(line.trim())).filter(Boolean));
  const paths = deps.paths.map(normalizeWritePath);
  const keep = paths.filter((path) => present.has(path));
  if (keep.length > 0) {
    await must(deps, `git -c core.fsmonitor=false checkout-index -f -- ${keep.map(deps.quote).join(' ')}`, '无法写回文件');
  }
  for (const path of paths) if (!present.has(path)) await deps.remove(path);
}
