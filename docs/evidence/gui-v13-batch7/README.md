# 批 7（项目工作空间 · 只读先行）回执

2026-10-07 · Mirasim Kimi K3 Max（effort=max）。上游：`docs/PLAN-gui-v13-batch7-workspace.md`、HANDOFF §「第四批」。上一批 `6ed75c7`。

## 做了什么

1. **易读多文件 Diff**：Diff 页签的统一 Diff 改为按文件分块（纯函数 `splitDiffByFile`，沿用 400 行全局截断与行分类规则）：每块文件头含路径（a//b/ 前缀剥离）、+/- 计数（排除 +++/--- 头行）、二进制标注、打开按钮与折叠；文件数 >20 时默认只展开前 3 块并注明。非 git 输出（如诚实失败提示）保持原有平铺渲染不破坏。
2. **只读文件树**：新端点 `GET /api/live/:id/tree?path=` 懒加载单层目录（safeResolve 越界/敏感/git 元数据拒绝；`.git` 与敏感条目不列出；软链标 link，展开经 safeResolve 复核；单层 ≤500 条截断注明）。抽屉新增第 7 页签「文件」：目录懒展开、按深度缩进、↗ 链接标注、文件点击内联预览。批 2 禁做「目录枚举」已由 HANDOFF 第四批明示解锁为只读形态。
3. **成果阅读复用**：预览卡抽成共享 `file-preview.tsx`，Diff 与「文件」页签同一套加载/截断/图片/外部打开/复制行为。
4. **试件**：verification 试件升级为两文件 Diff（修改 + 新文件）；`FIXTURE_TREE` 三层树含一个 `locked.lnk` other 链接；`docs/guide.md` 进 FIXTURE_FILES。

## 门禁

- 根 `typecheck`、`lint`、`vitest --maxWorkers=4`：**1854 passed / 2 skipped**（新增 9 条：树排序/排除/403/404/软链外逃/500 截断；splitDiffByFile 两文件/删除/二进制/空/截断）。
- 根 `npm run build`、GUI build 通过。
- 试件截图：`diff-blocks-1440x900b.png`（两文件分块 Diff）、`files-tree-preview-1440x900.png`（文件页签树+预览）；交互实测展开/折叠/打开；console 零 error/warning。

## 边界与条件项

- V13 冻结结构与抽屉几何未动（306/420px 不变）；树与预览纯只读；Git 写操作、全宽成果大视图、多 pane、独立窗口仍属条件项——需先出样稿给你视觉签收或另立项，本批未碰。
- 未触真实模型额度；4317 服务本轮未在运行。
