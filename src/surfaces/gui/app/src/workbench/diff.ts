/** Pure unified-diff presentation. It only classifies lines the runtime already produced. */

export type DiffKind = 'meta' | 'header' | 'hunk' | 'added' | 'removed' | 'context';

export interface DiffRow {
  readonly kind: DiffKind;
  readonly text: string;
}

const MAX_ROWS = 400;

export function parseUnifiedDiff(diff: string): { readonly rows: readonly DiffRow[]; readonly truncated: boolean } {
  const lines = diff.replace(/\r\n/gu, '\n').split('\n');
  const rows: DiffRow[] = [];
  for (const line of lines) {
    if (rows.length >= MAX_ROWS) return { rows, truncated: true };
    const kind: DiffKind = line.startsWith('diff --git') || line.startsWith('index ')
      ? 'meta'
      : line.startsWith('---') || line.startsWith('+++')
        ? 'header'
        : line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+')
            ? 'added'
            : line.startsWith('-')
              ? 'removed'
              : 'context';
    if (line === '' && rows.length > 0 && rows[rows.length - 1].kind === 'context') continue;
    rows.push({ kind, text: line });
  }
  return { rows, truncated: false };
}

export function diffSummary(diff: string): { readonly added: number; readonly removed: number; readonly files: number } {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of diff.replace(/\r\n/gu, '\n').split('\n')) {
    if (line.startsWith('diff --git')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed, files };
}

/** Batch 7 §工作空间: one file's block inside a multi-file diff, ready for grouped rendering. */
export interface DiffFileBlock {
  readonly path: string;               // bare repo path (a//b/ prefix stripped); deleted files use the a-side
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;            // 'Binary files' / 'GIT binary patch'
}

/** Same per-line classification as parseUnifiedDiff, kept honest by sharing the rules. */
function kindOf(line: string): DiffKind {
  return line.startsWith('diff --git') || line.startsWith('index ')
    ? 'meta'
    : line.startsWith('---') || line.startsWith('+++')
      ? 'header'
      : line.startsWith('@@')
        ? 'hunk'
        : line.startsWith('+')
          ? 'added'
          : line.startsWith('-')
            ? 'removed'
            : 'context';
}

/** Batch 7 §工作空间: presentation-only grouping of the runtime's diff text into per-file blocks.
 *  Never re-derived from the worktree; the same 400-row global cap and line rules as
 *  parseUnifiedDiff apply, so counts stay consistent with diffSummary. */
export function splitDiffByFile(diff: string): { readonly files: readonly DiffFileBlock[]; readonly truncated: boolean } {
  const files: DiffFileBlock[] = [];
  let rows: DiffRow[] = [];
  let oldPath = '';
  let newPath = '';
  let headerNew = '';
  let added = 0;
  let removed = 0;
  let binary = false;
  let active = false;
  let total = 0;
  let truncated = false;
  const flush = (): void => {
    if (!active) return;
    const named = newPath !== '' && newPath !== '/dev/null' ? newPath
      : oldPath !== '' && oldPath !== '/dev/null' ? oldPath
        : headerNew !== '' ? headerNew
          : '(unknown path)';
    files.push({ path: named.startsWith('b/') || named.startsWith('a/') ? named.slice(2) : named, rows, added, removed, binary });
    active = false;
  };
  for (const line of diff.replace(/\r\n/gu, '\n').split('\n')) {
    if (truncated) break;
    if (line.startsWith('diff --git')) {
      flush();
      rows = [];
      oldPath = '';
      newPath = '';
      // Binary blocks carry no ---/+++ lines; the b-side of the header line is their only path.
      const sep = line.lastIndexOf(' b/');
      headerNew = sep >= 0 ? line.slice(sep + 3) : '';
      added = 0;
      removed = 0;
      binary = false;
      active = true;
      continue; // the header row already carries the path; the marker line itself is not a row
    }
    if (!active) continue; // preamble before the first header is dropped
    if (line.startsWith('---')) oldPath = line.slice(4);
    else if (line.startsWith('+++')) newPath = line.slice(4);
    else if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) binary = true;
    if (line === '' && rows.length > 0 && rows[rows.length - 1].kind === 'context') continue;
    rows.push({ kind: kindOf(line), text: line });
    total += 1;
    if (total >= MAX_ROWS) truncated = true;
  }
  flush();
  return { files, truncated };
}
