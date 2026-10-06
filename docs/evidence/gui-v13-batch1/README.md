# 批 1 证据包：V13 黑白灰视觉精准贴合（2026-10-05）

对照源：`docs/v13-source-manifest.json` 冻结的 45 文件样稿；颜色唯一色源 `v23-neutral-theme.css` 尾部权威 `:root`。
改动：`src/surfaces/gui/app/src/styles/{workbench.css,app.css}` + `workbench/{message-item,conversation-pane,scroll-rules,use-history-geometry}` 四个组件/模块（git diff +340/−176）。

## 截图清单（19 张，Edge 采集，console 0 错误 0 警告）

| 文件 | 状态 |
| --- | --- |
| empty-1440x900 / empty-1280x800 | 空态（垂直居中、合同卡） |
| running-1440x900 / running-1280x800 | 运行中 |
| approval-1440x900 / approval-1000x760 | 待审批决策卡（含自动长高输入框） |
| approval-expanded-1440x900 / approval-expanded-1280x800 | 证据抽屉展开 |
| verification-1440x900 | 人工验收 |
| complete-1440x900 / complete-1280x800 | 完成（授权已授予） |
| failed-1440x900 | 检查失败 |
| stopped-1440x900 | 急停后 |
| disconnected-1440x900 | 连接中断 |
| long-1440x900 | 长历史（底部停驻） |
| long-scrolled-1440x900 / long-scrolled-1280x800 | 长历史滚动态：顶部摘要卡 + 定位刻度 9 tick + 回到最新 |

实测事实：1280×800 证据抽屉展开时中栏 1036px（抽屉浮层式，不挤压对话；无 610px 违约）；1000×760 无整页横向溢出；刻度四门槛（窗 ≥1200、gutter ≥52、回合 ≥2、可滚动 >64）按样稿生效；输入框 6 行文本实测 60→152px 自动长高；时间右推且 hover 才显（含最新一条）。

## 对齐口径摘要（全部 44 项，详见实施回执）

- 全局：字体族 Segoe UI/PingFang SC/雅黑、base 13px、focus 环 var(--accent)、--line-soft #f4f4f5。
- 左栏：恒 244px（删 1320 断点收窄）、收起 58px、padding 22/12/14、行高 34、任务标题 11.5px、个人区分隔 --line-strong、avatar 25、brand radius 9。
- 页头：54px、无底边、左 padding 23px、folder 26×26 chip、标题 12px/600/#3f3f46/220、图标钮 26、chip radius 7、状态区分隔线。
- 消息流：留白 730 公式（上 23 下 24）、回合距 46px、composer 列 730、用户气泡 min(83%,560px)/12px/1.75/补 1px 同底框/用户 meta 补时间、agent 29×29 avatar + 37px 缩进、正文 12px/1.78 #52525b。
- 操作条：margin-top 12、min-h 27、gap 3、25×25 纯图标（tooltip 文案）、图标 15×15/1.6、时间 margin-left:auto + hover 才显。
- 摘要：8/18/13、渐层 73%、748 圆角卡片（radius 12、#f4f4f5、0 3px 12 阴影）、删 chip、回跳偏移 20。
- 刻度：6×1 普通 / 16×2 当前悬停（同 #27272a）、轨 26 宽/顶 14/高 max(160,h-28)/left=留白-17、预览卡 left 34/min(320,100vw-100)/12 13 11/650。
- Composer：外区无边、10/13 padding、radius 15、textarea 60/164 自动长高、meta 10px faint。
- 空态/浮钮：垂直居中、h2 clamp(17,2vw,23) 无 display 字体、图标 29 faint；回到最新 bottom 10、padding 7/12、门槛 >80px。
- 颜色：workbench.css 全量 var 化（--paper/--primary-foreground/--paper-glass/--faint/--code-dim 新 token）；零硬编码 `#fff/#9a9a9a/#b6b6b6` 残留。

## 门禁

根 typecheck ✓；app typecheck + vite build ✓（731 modules）；vitest GUI 相关 75/75 ✓（子代理阶段 18/18）；全量 `vitest run --maxWorkers=4` **1760 通过 / 2 skipped / 0 失败** ✓；根 lint ✓。

## Defer（已登记，不在本批）

640px 全局搜索弹窗、滚动渐隐 mask、书签刻度、日期分隔条、Composer 盒内工具行（随批 2 模型选择）、发送钮 29×29 图标化、任务行单行绝对 meta 版式、970/1180 新断点层级、`tokens.css` ≤1320 死规则清理（对 workbench 无视觉效力，属清理项非视觉项）。

## 待 Owner 目检裁点（实施时的九处判断）

1. 任务行保留 jarvis 状态点列 + 第二行 meta（V13 为单行绝对 meta），仅字号行高已对齐。
2. 空态图标用现有 TerminalIcon（样稿为聊天气泡形），如不合意换图标字形即可。
3. 首分组上间距以 padding 承担（样稿 margin 语义）。
4. 页头分隔线只在有状态 chip 时出现（避免空态孤立竖线）。
5. ≤1320px 断点页头左 padding 仍为 10px（既有覆盖，清单未要求删除）。
6. 刻度轨道无可见底槽（样稿 v22 轨道是否有底色未逐像素取证，如有视觉差异按 Owner 意见补）。
7. textarea rows 2→1 以保初始高恰 60px。
8. 空态垂直居中用 flex 列实现（grid 的 justify-content 不达垂直轴）。
9. 末轮间距由滚动区 padding-bottom 24px 承担（样稿 margin 语义等价）。
