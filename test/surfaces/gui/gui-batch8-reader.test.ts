import { describe, expect, it } from 'vitest';
import { orderDiffBlocks } from '../../../src/surfaces/gui/app/src/workbench/reader-diff.js';

const TWO_FILE_DIFF = 'diff --git a/docs/guide.md b/docs/guide.md\nnew file mode 100644\nindex 0000000..1f2d3e4\n--- /dev/null\n+++ b/docs/guide.md\n@@ -0,0 +1 @@\n+# 引导\n'
  + 'diff --git a/fixture/answer.mjs b/fixture/answer.mjs\nindex 8c1e2f4..2b7a91c 100644\n--- a/fixture/answer.mjs\n+++ b/fixture/answer.mjs\n@@ -1 +1 @@\n-export const label = "说明";\n+export const label = "改过的一行";\n';

describe('批8 orderDiffBlocks 纯函数（关联 Diff 当前文件置顶）', () => {
  it('puts the block for the current path first', () => {
    expect(orderDiffBlocks(TWO_FILE_DIFF, 'docs/guide.md').files.map((block) => block.path))
      .toEqual(['docs/guide.md', 'fixture/answer.mjs']);
    expect(orderDiffBlocks(TWO_FILE_DIFF, 'fixture/answer.mjs').files.map((block) => block.path))
      .toEqual(['fixture/answer.mjs', 'docs/guide.md']);
  });

  it('keeps the original order when the path is unknown', () => {
    expect(orderDiffBlocks(TWO_FILE_DIFF, 'somewhere/else.md').files.map((block) => block.path))
      .toEqual(['docs/guide.md', 'fixture/answer.mjs']);
  });

  it('empty diff yields no files and the truncated flag passes through', () => {
    expect(orderDiffBlocks('', 'anything.md')).toEqual({ files: [], truncated: false });
    const big = `diff --git a/one.txt b/one.txt\nindex 1111111..2222222 100644\n--- a/one.txt\n+++ b/one.txt\n@@ -1,450 +1,450 @@\n${Array.from({ length: 450 }, (_, index) => `-old-${index}`).join('\n')}\n`;
    const capped = orderDiffBlocks(big, 'one.txt');
    expect(capped.truncated).toBe(true);
    expect(capped.files).toHaveLength(1);
    expect(capped.files[0].path).toBe('one.txt');
  });
});
