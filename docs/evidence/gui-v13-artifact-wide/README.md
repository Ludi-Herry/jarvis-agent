# 全宽成果大视图 · 样稿证据（2026-10-07）

性质：**待 Owner 视觉签收的结构评审材料**，不是实现、不构成任何产品承诺。样稿：`prototypes/gui-v13-artifact-wide/index.html`（自包含静态稿，token 族抄自现行黑白灰 tokens；内容与批 7 试件同源）。设计说明与三稿对比：`prototypes/gui-v13-artifact-wide/DESIGN-NOTE.md`。

## 截图（1440×900，Playwright，`python -m http.server 4321` 静态伺服）

- `v1-overlay-notes-1440x900.png` / `v1-overlay-clean-1440x900.png`：V1 全宽覆盖阅读层（批注解 / 净版）。
- `v2-expand-notes-1440x900.png` / `v2-expand-clean-1440x900.png`：V2 证据栏扩展为全宽栏（含 300px 产物目录/文件树 TOC）。
- `v3-swap-notes-1440x900.png` / `v3-swap-clean-1440x900.png`：V3 中栏对话↔成果原位切换。

## 记录

- 推荐 V1：最大阅读面且冻结布局零改动；V2 动列模成本高、V3 宽度收益最小。三稿的共同硬约束（阅读态只读、数据来自现有 readFileView 边界、关掉后既有锚点不动）见 DESIGN-NOTE。
- 制作过程修正两处样稿自身问题（批注层被覆盖层压住、V2 TOC 返回按钮被网格规则挤压），均为样稿内修复，不涉产品代码。
- 本轮未改任何产品文件；server 仅静态样稿用；未触真实模型。
