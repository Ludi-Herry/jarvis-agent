import { splitDiffByFile, type DiffFileBlock } from './diff.js';

/**
 * Batch 8 §阅读层 (V1): pure ordering for the reader overlay's related-Diff column. Lives in its
 * own pure module so root-level tests can import it without pulling in the .tsx component;
 * reader-overlay.tsx re-exports it.
 */

/** Stable-sort diff blocks so the block for `path` comes first; everything else keeps order. */
export function orderDiffBlocks(diff: string, path: string): { files: DiffFileBlock[]; truncated: boolean } {
  const { files, truncated } = splitDiffByFile(diff);
  return { files: [...files].sort((a, b) => Number(b.path === path) - Number(a.path === path)), truncated };
}
