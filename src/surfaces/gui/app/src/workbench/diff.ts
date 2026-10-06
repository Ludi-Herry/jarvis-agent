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
