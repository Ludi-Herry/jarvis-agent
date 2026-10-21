# GUI Demo 最新版收尾（2026-10-21）

远程门禁未通过，详情见 [CI 结果](GUI-DEMO-CI-RESULT-2026-10-21.md)。本轮 GUI 已提交推送，整体 CI 尚未签收。

## 交付范围

源码与本地预览位于 codex/gui-demo-border-sync-20261021 分支，基线 f0d1f4f。Ludi 已接受描边、审批卡动效修复，并要求走查台默认收起后提交、记录经验并推送。本次不改 Runtime 映射或 Figma 文档。

- 容器细边线改真实 border，与投影分开；Figma 对应 INSIDE stroke。输入框边线保留在 BorderBeam 外壳；底托保留真实边框与 border-top:0。
- 整合 3438bc0 的投影余量修复：底部 44px、画布工具栏底部 30px、窄屏紧凑投影；补齐工具栏横向投影空间。8cb3d69 与 f0d1f4f 是相同补丁（patch-id 638c1cb5ac3f3eba000430d380e2ee460357f2ef），不重复合并。
- 审批卡收起改为 ResizeObserver 测量内容并过渡真实 height，避免 layout=size 的 scaleY 拉伸退场卡片。保持原有淡入淡出、等比退出及减少动态效果适配。
- ReviewDock 的 open 初始值固定 false。每次打开原型默认收起，点击顶部胶囊后展开；刷新后回到收起。
- 一并提交构建必需字体、字体 OFL、6 张旧版对照图、Arc NOTICE 和本地缓存忽略规则。没有依赖安装或锁文件变更。

## 验证与权威边界

本地 typecheck、lint、test、root build、Demo build 和 git diff --check 通过，完整运行日志留在本机同名 evidence 目录，摘要随提交。CI 以 GitHub 同提交的「门禁」结果为准；分支 push 本身不触发门禁，推送后手动调用已有 workflow_dispatch，不修改 CI 配置。

浏览器核对：初次打开 expanded=false、dock-panel 数量0；手动点击 expanded=true、数量1；重新打开另一种状态 expanded=false、数量0。原型页已在用户浏览器中，保留当前演示状态。

描边回归涵盖浅深色、1280/1281px、390px、DPR1/2、输入聚焦、设置弹窗及画布，clip-audit 最终 cut=0。审批收起基线约12倍拉伸（15px Pencil 约180px），真实高度修复后批准、拒绝、审核状态跳转、历史任务、快速往返和窄屏约1.00倍；历史任务包括原有约0.12%的轻微等比入场。Ludi 已认可本轮视觉结果。

## 可复用经验

1. 边线和投影承担不同职责。真实边框保证闭合边缘；投影仍须给出 offset+blur+spread 需要的空间。不能靠恢复旧阴影环来合并裁切补丁。
2. layout=size 会用 transform 模拟尺寸改变。不同高度内容交替且旧内容仍在退场时，图标可被拉长；单补子层 layout=position 仍会漏状态跳转。真实高度动画能消除这条缩放链路。
3. 复测必须包含正常批准、拒绝、整段状态跳转、历史任务、快速反向与窄屏。DOM/rAF 采样用于定位几何问题；真实绘制仍保留视觉验收，长任务不等同硬件不足。
4. 对比历史提交先核对 patch-id。同一补丁在不同分支有不同哈希，重复 cherry-pick 会增加冲突。

跨会话经验已写入用户授权的 Codex 记忆增量 20261021-jarvis-gui-border-and-layout-morph.md；未直接改写既有记忆库文件。

## 产物与保护范围

本提交 evidence/gui-demo-closeout-2026-10-21/ 包含：jarvis-gui-latest.html、default-collapsed.png、morph-measurements.json、border-audit-final.json、checks-summary.json。HTML 是可独立打开的构建产物，浏览器预览仍采用 HTTP。

两轮详细报告与失败证据原样保留于 H:/jarvis-agent/docs/REPORT-gui-border-sync-2026-10-21.md、REPORT-gui-approval-morph-2026-10-21.md 及各自 evidence 目录；未覆盖历史 HTML 快照。另一份 gui-acceptance-2026-10-17 有并行 Runtime 编辑，未改动：纯 CSS 补丁可 apply --check，README 与 Thread.tsx 需后续按该分支上下文合并。

本轮未创建临时脚本或新 worktree。原有 exact worktree、开发服务和复用已有依赖的两个 node_modules Junction 保留，供用户继续打开预览；未删除失败现场、日志或他人文件。
