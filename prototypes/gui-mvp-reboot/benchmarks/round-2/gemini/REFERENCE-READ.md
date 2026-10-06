# Round 2 参考阅读回执 (Gemini)

## 身份与访问

- Agent：`gemini`
- 时间：`2026-09-01`
- 参考访问：`packet-only`
- 无法打开的来源：`none`

## 逐卡判断

| 参考卡 | 实际打开的来源 | 吸收 1 条 | 拒绝 1 条 | Jarvis 转译动作 |
|---|---|---|---|---|
| OpenHanako | REFERENCE-PACKET.md (Card 1) | 对话作为稳定主轴，Reasoning 与工具执行在完成后压缩降噪、渐进披露。 | 人格化头像、生活记忆、伴侣式闲聊与多 Agent 插件市场。 | 对话流中内嵌低压度 Reasoning 折叠块与紧凑工具流水线，保留工具失败语义与确定性状态。 |
| Tutti | REFERENCE-PACKET.md (Card 2) | 集中暴露人工注意力，需要用户裁决的高危动作（如写操作）拥有独立权限闸门。 | Agent OS 平台化、云端多人协作 Room、跨 Agent 编排超级应用。 | 将单机写操作权限申请就地提升为醒目决策卡片，提供明确影响范围（+29 / −2）与 3 种互斥决定。 |
| Kun | REFERENCE-PACKET.md (Card 3) | 区分持久化事实与实时显示投影，断线/恢复事件重放时保持状态单调性与证据链一致。 | 多工作模式切换、模型路由大厅、复杂拓扑图与全套 IDE 桌面复刻。 | 顶部 Task Anchor 与消息体明确显示 Session 回放事实与 Diff 投影对齐状态，突出单测断言证据。 |
| CodePilot | REFERENCE-PACKET.md (Card 4) | 有限的权威状态词汇（canonical state），权限 Prompt 明确展示影响范围与可回退性。 | Provider 矩阵、媒体工作台、Bridge 路由与通用模型广场。 | 统一运行时状态机（待审批/执行中/已完成/失败/已暂停/已终止），未知或未授权状态显式保持“完成授权未授予”。 |
| Jarvis 不变量 | PRODUCT.md, BRIEF.md, REFERENCE-PACKET.md (Card 5) | 首屏 5 大核心问题（目标、阶段、停下原因、用户动作、完成授权）在数秒内直观回答，控制与审批持续可达。 | 任何在未通过验证链前宣称完成的虚假绿灯，以及一切非编码 harness 的装饰性元素。 | 顶部常驻 Task Anchor + 底部浮动安全 Dock 双重保障；非绿灯状态持续锁定“完成授权未授予”，仅在单测全部绿灯时展示 `decideVerdict · verified（模拟）`。 |
| 两类反例 | REFERENCE-PACKET.md (Card 6) | 拒绝通用深色控制台与无限同形卡片，建立基于内容类型（消息、推导、工具、Diff、闸门）的异构排版尺度。 | 蓝紫霓虹光效、10px 密集标签堆叠、无真实运行证据的自评式绿灯。 | 采用冷静精密工程美学（Calm Precision Engineering），用清晰分隔线、微缩代码视窗与按键提示构建层级。 |

## 本稿的独立主张

- 结构主张：单向对话流作为视觉与阅读绝对重心，顶部紧凑 Task Anchor 锚定全局状态，底部浮动安全 Dock 保证长滚动下控制权永不丢失。
- 视觉主张：冷静精密工程美学（Calm Precision Engineering），蓝灰石墨暗底与高对比度正文，剔除发光霓虹与同形圆角卡片；状态全部采用“图标 + 代码块 + 语义文案”三重表达。
- 交互主张：就地内嵌决策（In-situ Decision Gate）+ 键盘优先（A / R / M / Space），所有状态变迁即时反馈，支持预设场景秒级切换。
- 与 Round 1 的预期差异：增强首屏信息密度与排版尺度差异，优化 Diff 查看器的折叠与对比体验，强化完成授权的法律级严密性表达与键盘可达性。

## 首屏草图检查

- 当前目标位置：顶部 Task Anchor 左侧任务标题与 ID
- 当前阶段位置：顶部 Task Anchor 中间 `阶段：修正显示投影`
- 停下原因位置：顶部 Anchor 状态 Badge (`⚠ 需要审批`) + 对话流内审批闸门卡片标题
- 用户动作位置：内嵌审批卡片 3 动作按键（A/M/R）+ 底部浮动 Dock 快捷按键
- 完成授权位置：顶部 Anchor 专属 Chip（`⊘ 完成授权未授予` / `✓ decideVerdict · verified（模拟）`）
- 对话主路径：页面中央 880px 宽度单向时间线，消息体原生包裹推导、工具与 Diff
- Artifact/Diff 进入路径：内嵌在第二条 Jarvis 消息中的文件变更 Tab 视窗与 Git Index 投影

## 事实保真

- 文件 1：`src/surfaces/gui/assets/presentation.js`
- 文件 2：`test/surfaces/gui/gui-presentation.test.js`
- 改动：`+29 / −2`
- 权限：`workspace.write`
- 完成：`decideVerdict · verified（模拟）`
- 禁止自行增加真实 Runtime API、测试数字或未在 Brief 中出现的成功事实。
