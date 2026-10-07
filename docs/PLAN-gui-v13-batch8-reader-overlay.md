# 批 8：全宽成果阅读层（V1，Owner 已签收） — 实施笔记

2026-10-07 · Mirasim Kimi K3 Max。签收记录（Owner 原话）：「选 V1：阅读层里并排『文件 + 关联 Diff 分块』；现在抽屉里的内联小预览（批 4 做的）保留。」样稿：`prototypes/gui-v13-artifact-wide/`（DESIGN-NOTE 已定稿，签收见上）。上一批：`f643d1b`。

> **状态：已完成（2026-10-07）。** 证据与门禁：`docs/evidence/gui-v13-batch8/README.md`。全量 1857 passed / 2 skipped，typecheck/lint/双 build 通过；Esc 关闭后底层现场无损（实测截图）。

## 目标

1. **全宽阅读层** `wb-reader`（role=dialog，aria-modal，固定全视口层）：顶栏 54px（← 返回任务对话 · 路径 chip · 来源标注「产物 / Diff 分块 / 文件树 · 只读」 · 复制 · 在外部打开 · ✕）；Esc/← 关闭；层内**只读**，不出现任何审批/验收/提交动作。
2. **并排「文件 + 关联 Diff 分块」**：正文区渲染当前文件（`.md` 走批 4 MarkdownBody；其他文本 `<pre>` mono；图片 `<img>`；200KB/2MiB 截断与二进制诚实拒绝复用既有合同）；右侧 380px 关联 Diff 列（同任务 splitDiffByFile 分块，当前文件置顶展开，其余折叠 + 「阅读」按钮切换当前文件）。<1100px 宽响应式退化为上下排。
3. **入口**：Diff 页签 artifact 行、Diff 分块文件头、「文件」页签预览卡头均加「大视图」；抽屉内联小预览原样保留（Owner 确认）。
4. **冻结布局不动**：层挂 workbench 根 sibling，不改 `wb-shell`/`wb-conversation` 任何既有几何；关闭后所有既有锚点（244/54/消息列/306-420 抽屉）原样。

## 文件范围

新 `workbench/reader-overlay.tsx`（含 `orderDiffBlocks(diff, path)` 纯函数前置排序）、`workbench.tsx`（reader 状态 + open/close + 传递 opener）、`evidence.tsx`（artifact 行与分块头加 大视图）、`file-preview.tsx`（卡头加可选 大视图）、`file-tree-pane.tsx`（预览卡头接入）、`detail-pane.tsx` 透传、`workbench.css`（仅追加 `.wb-reader*`）、试件层零新增（复用 getFileView + snapshot.diff）、`test/surfaces/gui/gui-batch8-reader.test.ts`（orderDiffBlocks 纯函数）。

## 验收

- typecheck/lint/`vitest --maxWorkers=4`/双 build 绿。
- 试件截图：verification 试件打开 docs/guide.md 层（Markdown 正文 + 关联 Diff 列）、切换到 fixture/answer.mjs；1440×900 → `docs/evidence/gui-v13-batch8/`。
- Esc/按钮关闭后底层现场（滚动、草稿、审批卡）原样。

## 不做

不在层内做任何写/审批；不新增后端端点（复用 readFileView/openFileExternal/snapshot.diff）；issues 全宽、多 pane、独立窗口仍冻结。
