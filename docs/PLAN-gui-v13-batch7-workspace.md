# 批 7（第四批）：项目工作空间（只读先行） — 实施笔记

2026-10-07 · Mirasim Kimi K3 Max。上游：`HANDOFF-gui-kimi-k3-max-2026-10-07.md` §「第四批」、差距报告 §6（先只读）。上一批：`6ed75c7`。

> **状态：已完成（2026-10-07）。** 证据与门禁：`docs/evidence/gui-v13-batch7/README.md`。全量 1854 passed / 2 skipped，typecheck/lint/双 build 通过。

## 目标（本批只做只读，不改冻结布局）

1. **任务改动文件 → 易读多文件 Diff**：Diff 页签的统一 Diff 改为按文件分块（diff.ts 纯函数 `splitDiffByFile`）：每块文件头（路径、+/-计数、二进制标注、打开按钮、折叠）；总块数 >20 时默认只展开前 3 块并注明；全局行数上限沿用 400 行截断契约。
2. **只读文件树**：新端点 `GET /api/live/:id/tree?path=`（懒加载单层目录），safeResolve 越界/敏感路径/git 元数据拒绝；`.git` 与敏感条目不列出；软链标 `link`，展开软链目录经 safeResolve 复核；每目录 ≤500 条截断注明。抽屉新增第 7 页签「文件」（仍 306/420px 抽屉内，布局禁区不碰）：树浏览 + 点击文件内联预览。
3. **成果阅读复用**：把 Diff 页签的文件预览卡抽成共享组件 `file-preview.tsx`，Diff 与「文件」页签共用同一加载/截断/图片/外部打开/复制行为。
4. **明确不做（条件项，待样稿签收或另立项）**：全宽成果大视图、多 pane、独立窗口、Git 写操作、树内编辑。这些不出现在本批。

## 文件范围

`live-types.ts`（GuiWorkspaceTree）、`live-session.ts`（listWorkspaceDir）、`live-api.ts`（GET tree）、`diff.ts`（splitDiffByFile）、app 侧 `live/api.ts`、`types.ts`、`use-live-session.ts`、`detail-pane.tsx`、新 `workbench/file-tree-pane.tsx`、新 `workbench/file-preview.tsx`（抽取）、`evidence.tsx`（Diff 分块渲染+预览卡复用为抽取组件）、`fixtures.ts`/`fixture-store.ts`（树与多文件 Diff 试件）、`workbench.css`（仅追加）、`test/surfaces/gui/gui-batch7-workspace.test.ts`。

## 验收

- 全门绿；测试：树端点（排序/排除/越界 403/非目录 404/软链外逃 403/截断）、splitDiffByFile（多文件/删除/二进制/空/截断）。
- 试件截图：Diff 分块（多文件）、「文件」页签树+预览 → `docs/evidence/gui-v13-batch7/`，1440×900。

## 边界

V13 冻结结构与抽屉几何不动；树与预览纯只读；批 2 禁止事项中的「目录浏览枚举」已由 HANDOFF 第四批显式解锁（只读形态）；条件项（全宽/多 pane/独立窗口/Git 写）需样稿签收或另立项，不默认推进。
