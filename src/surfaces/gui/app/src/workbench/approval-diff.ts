/**
 * Batch 4 §授权判断: build the "about to be approved" change preview from a pending approval's
 * tool arguments. Pure and defensive — malformed arguments degrade to null (the card's raw
 * argument details stay visible), never to a guessed preview. Nothing here has executed yet;
 * the UI labels it as such.
 */

export type ApprovalPreview =
  | { kind: 'write-create'; path: string; diff: string }          // unified diff, +all new lines
  | { kind: 'write-replace'; path: string; content: string; note: string }
  | { kind: 'edit'; path: string; diff: string }                  // LCS line diff oldText→newText
  | { kind: 'command'; command: string }
  | null;

/** Exact replacement note shown for a full-file write that needs the workspace's current text. */
export const WRITE_REPLACE_NOTE = '替换后的完整内容；旧文本以工作区当前文件为准。此预览未执行，不代表已生效的改动。';

/** LCS is O(n*m); past this per-side cap the preview refuses instead of computing a huge table. */
const LCS_MAX_LINES_PER_SIDE = 400;

const COMMAND_TOOLS: ReadonlySet<string> = new Set(['bash', 'sandboxed_exec', 'terminal']);

/** Unified diff of a brand-new file: `--- /dev/null`, every content line added. */
function createDiff(path: string, content: string): string {
  const lines = content.split('\n');
  const body = lines.map((line) => `+${line}`).join('\n');
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

interface LcsOp {
  readonly kind: 'context' | 'removed' | 'added';
  readonly text: string;
}

/** Line-level LCS between oldLines and newLines as an ordered op list (back-traced, ties keep context). */
function lcsOps(oldLines: readonly string[], newLines: readonly string[]): LcsOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = LCS length of oldLines[i..] and newLines[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'context', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'removed', text: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: 'added', text: newLines[j] });
      j += 1;
    }
  }
  while (i < m) { ops.push({ kind: 'removed', text: oldLines[i] }); i += 1; }
  while (j < n) { ops.push({ kind: 'added', text: newLines[j] }); j += 1; }
  return ops;
}

/** Unified-diff text of oldText→newText for `path`; lines are emitted in LCS order. */
export function diffLines(oldText: string, newText: string, path: string): string | null {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length > LCS_MAX_LINES_PER_SIDE || newLines.length > LCS_MAX_LINES_PER_SIDE) return null;
  const body = lcsOps(oldLines, newLines)
    .map((op) => `${op.kind === 'context' ? ' ' : op.kind === 'removed' ? '-' : '+'}${op.text}`)
    .join('\n');
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${body}\n`;
}

export function buildApprovalPreview(toolName: string, argsJson: string): ApprovalPreview {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (toolName === 'write') {
    if (typeof args.path !== 'string' || typeof args.content !== 'string') return null;
    if (args.createOnly === true) return { kind: 'write-create', path: args.path, diff: createDiff(args.path, args.content) };
    if (typeof args.expectedVersion === 'string') return { kind: 'write-replace', path: args.path, content: args.content, note: WRITE_REPLACE_NOTE };
    return null;
  }

  if (toolName === 'edit') {
    if (typeof args.path !== 'string' || typeof args.oldText !== 'string' || typeof args.newText !== 'string') return null;
    const diff = diffLines(args.oldText, args.newText, args.path);
    return diff === null ? null : { kind: 'edit', path: args.path, diff };
  }

  if (COMMAND_TOOLS.has(toolName)) {
    return typeof args.command === 'string' ? { kind: 'command', command: args.command } : null;
  }

  return null;
}
