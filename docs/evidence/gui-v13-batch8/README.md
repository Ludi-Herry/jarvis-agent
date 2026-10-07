# 批 8（全宽成果阅读层 V1 · Owner 已签收）回执

2026-10-07 · Mirasim Kimi K3 Max（effort=max）。签收：Owner 选定 V1、阅读层内并排「文件 + 关联 Diff 分块」、抽屉内联小预览保留。上游：`docs/PLAN-gui-v13-batch8-reader-overlay.md`、样稿 `prototypes/gui-v13-artifact-wide/`。上一批 `64e3162`。

## 做了什么

1. **`wb-reader` 全宽阅读层**（`reader-overlay.tsx`，role=dialog/aria-modal，fixed 全视口，z 40）：54px 顶栏（← 返回任务对话 · 路径 chip · 来源标注（产物/Diff 分块/文件树 · 只读）· 复制（文本）· 在外部打开 · ✕）；Esc/← 关闭并还原焦点。层内**没有任何审批/验收/提交动作**。
2. **并排「文件 + 关联 Diff 分块」**：正文当前文件——`.md` 走批 4 MarkdownBody；其他文本等宽 `<pre>`；图片 data-URI；200KB 与图片上限沿用既有截断合同（含注明）。右侧 380px 关联 Diff 列：同任务 `orderDiffBlocks(diff, path)`（纯函数，当前文件置顶展开），其余折叠 + 「阅读」按钮切换当前文件；<1100px 退化为上下排。
3. **入口**：Diff 页签 artifact 行、Diff 分块文件头、文件预视卡头都加「大视图」（taskId 为空时不显示入口，层内有诚实 404 兜底文本）；批 4 内联小预览原样保留。
4. **冻结布局未动**：层挂 workbench 根 sibling，不改 `wb-shell`/`wb-conversation` 任何几何；关闭后底层现场（抽屉页签、滚动、草稿、审批卡）原样恢复（截图 `reader-closed-1440x900.png`，Esc 关闭后实证）。
5. 路由纪律：无新增后端端点；整层只消费既有 `readFileView/openFileExternal` 与 `snapshot.diff` 投影。

## 门禁

- 根 `typecheck`、`lint`、`vitest --maxWorkers=4`：**1857 passed / 2 skipped**（新增 3 条 orderDiffBlocks 排序/未知路径/空 Diff）。
- 根 `npm run build`、GUI build 通过。
- 试件截图：`reader-answer-1440x900.png`（answer.mjs 等宽文本 +  Diff 列）、`reader-guide-md-1440x900.png`（guide.md Markdown 渲染）、`reader-closed-1440x900.png`（关闭后底层无损）。console 零 error/warning；交互实测切换/复制入口/关闭。

## 收尾

- 无依赖新增；CSS 只追加 `.wb-reader*`。
- 条件项中「全宽成果大视图」至此交付读态最小版（Owner 已签收 V1）。
- 剩余条件项（多 pane、独立窗口、worktree、GUI 模型配置、Skill/MCP、受控浏览器）继续冻结；真实 Jarvis 模型任务窗口仍由 Owner 安排。
